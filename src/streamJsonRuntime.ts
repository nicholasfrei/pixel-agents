import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as vscode from 'vscode';

import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildTurnCommand(commandTemplate: string, prompt: string, sessionId?: string): string {
  let command = sessionId
    ? commandTemplate.replaceAll('{sessionId}', sessionId)
    : commandTemplate.replaceAll('{sessionId}', '');
  if (
    sessionId &&
    !commandTemplate.includes('{sessionId}') &&
    !/(^|\s)--resume(?:\s|=)/.test(commandTemplate) &&
    !/(^|\s)--continue(?:\s|$)/.test(commandTemplate)
  ) {
    command = `${command} --resume ${shellEscape(sessionId)}`;
  }
  return `${command.trim()} ${shellEscape(prompt)}`;
}

function describeToolCall(toolCall: Record<string, unknown>): string {
  const entry = Object.entries(toolCall).find(([, value]) => value && typeof value === 'object');
  if (!entry) return 'Using tool';
  const [rawName, rawBody] = entry;
  const body = rawBody as { args?: Record<string, unknown> };
  const toolName = rawName.replace(/ToolCall$/, '');
  const args = body.args || {};
  if (toolName === 'read' && typeof args.path === 'string') {
    return `Reading ${args.path}`;
  }
  if (toolName === 'shell' && typeof args.command === 'string') {
    return `Running ${args.command}`;
  }
  if (toolName === 'glob') return 'Searching files';
  if (toolName === 'grep') return 'Searching code';
  return `Using ${toolName}`;
}

function renderRecord(record: Record<string, unknown>): string | null {
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'assistant') {
    const message = record.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const parts =
      message?.content
        ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim())
        .filter((part): part is string => !!part) || [];
    return parts.length > 0 ? `${parts.join('\n')}\r\n` : null;
  }
  if (type === 'tool_call' && record.subtype === 'started') {
    const toolCall = record.tool_call as Record<string, unknown> | undefined;
    return toolCall ? `[tool] ${describeToolCall(toolCall)}\r\n` : null;
  }
  if (type === 'result') {
    return record.subtype === 'error' ? '[agent] Turn failed\r\n' : '[agent] Turn complete\r\n';
  }
  return null;
}

export function isStreamJsonLaunchCommand(commandTemplate: string): boolean {
  return (
    /(^|\s)--print(?:\s|$)/.test(commandTemplate) &&
    /(^|\s)--output-format(?:=|\s+)stream-json(?:\s|$)/.test(commandTemplate)
  );
}

export class StreamJsonTerminalRuntime implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private inputBuffer = '';
  private disposed = false;
  private busy = false;

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  readonly onDidClose?: vscode.Event<number> = this.closeEmitter.event;

  constructor(
    private readonly agentId: number,
    private readonly cwd: string,
    private readonly commandTemplate: string,
    private readonly agents: Map<number, AgentState>,
    private readonly waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    private readonly permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    private readonly webview: vscode.Webview | undefined,
  ) {}

  open(): void {
    this.writeEmitter.fire('Pixel Agents stream-json mode\r\n');
    this.writeEmitter.fire(`cwd: ${this.cwd}\r\n`);
    this.writeEmitter.fire('Type a prompt and press Enter to run a turn.\r\n\r\n');
    this.showPrompt();
  }

  close(): void {
    this.dispose();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    for (const ch of data) {
      if (ch === '\r') {
        this.submitCurrentPrompt();
        continue;
      }
      if (ch === '\u0003') {
        if (this.process) {
          this.process.kill('SIGINT');
        }
        continue;
      }
      if (ch === '\u007f') {
        if (!this.busy && this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.writeEmitter.fire('\b \b');
        }
        continue;
      }
      if (ch >= ' ' && ch !== '\u007f' && !this.busy) {
        this.inputBuffer += ch;
        this.writeEmitter.fire(ch);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.closeEmitter.fire(0);
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private showPrompt(): void {
    if (this.disposed) return;
    this.writeEmitter.fire('> ');
  }

  private submitCurrentPrompt(): void {
    const prompt = this.inputBuffer.trim();
    this.writeEmitter.fire('\r\n');
    this.inputBuffer = '';
    if (this.busy) {
      this.writeEmitter.fire('[agent] Wait for the current turn to finish.\r\n');
      this.showPrompt();
      return;
    }
    if (!prompt) {
      this.showPrompt();
      return;
    }
    this.runTurn(prompt);
  }

  private runTurn(prompt: string): void {
    const agent = this.agents.get(this.agentId);
    if (!agent) return;

    const shell = process.env.SHELL || '/bin/zsh';
    const command = buildTurnCommand(this.commandTemplate, prompt, agent.streamSessionId);
    this.busy = true;
    this.stdoutBuffer = '';
    this.writeEmitter.fire(`[agent] ${command}\r\n\r\n`);

    const child = spawn(shell, ['-lc', command], {
      cwd: this.cwd,
      env: process.env,
      stdio: 'pipe',
    });
    this.process = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this.consumeOutput(chunk.toString('utf-8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.writeEmitter.fire(chunk.toString('utf-8').replace(/\n/g, '\r\n'));
    });
    child.on('close', (code) => {
      this.process = null;
      this.busy = false;
      if (code && code !== 0) {
        this.writeEmitter.fire(`\r\n[agent] Process exited with code ${code}\r\n`);
      } else {
        this.writeEmitter.fire('\r\n');
      }
      this.showPrompt();
    });
    child.stdin.end();
  }

  private consumeOutput(text: string): void {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.markActivity();
      this.captureSessionId(trimmed);
      processTranscriptLine(
        this.agentId,
        trimmed,
        this.agents,
        this.waitingTimers,
        this.permissionTimers,
        this.webview,
      );
      try {
        const rendered = renderRecord(JSON.parse(trimmed) as Record<string, unknown>);
        if (rendered) {
          this.writeEmitter.fire(rendered);
        }
      } catch {
        this.writeEmitter.fire(`${trimmed}\r\n`);
      }
    }
  }

  private markActivity(): void {
    const agent = this.agents.get(this.agentId);
    if (!agent) return;
    cancelWaitingTimer(this.agentId, this.waitingTimers);
    cancelPermissionTimer(this.agentId, this.permissionTimers);
    agent.isWaiting = false;
    this.webview?.postMessage({ type: 'agentStatus', id: this.agentId, status: 'active' });
    if (agent.permissionSent) {
      agent.permissionSent = false;
      this.webview?.postMessage({ type: 'agentToolPermissionClear', id: this.agentId });
    }
  }

  private captureSessionId(line: string): void {
    const agent = this.agents.get(this.agentId);
    if (!agent) return;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (
        record.type === 'system' &&
        record.subtype === 'init' &&
        typeof record.session_id === 'string'
      ) {
        agent.streamSessionId = record.session_id;
      }
    } catch {
      // Ignore malformed output lines.
    }
  }
}
