import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
  startWaitingToIdleTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

type ToolClass = 'read' | 'write' | 'run' | 'search' | 'ask' | 'task' | 'plan' | 'other';

type NormalizedEvent =
  | {
      type: 'tool_start';
      scope: 'agent';
      toolId: string;
      toolName: string;
      status: string;
      toolClass: ToolClass;
      isSubagentRoot?: boolean;
      subagentLabel?: string;
    }
  | {
      type: 'tool_start';
      scope: 'subagent';
      parentToolId: string;
      toolId: string;
      toolName: string;
      status: string;
      toolClass: ToolClass;
    }
  | { type: 'tool_done'; scope: 'agent'; toolId: string }
  | { type: 'tool_done'; scope: 'subagent'; parentToolId: string; toolId: string }
  | { type: 'assistant_text' }
  | { type: 'turn_end' }
  | { type: 'user_prompt' }
  | { type: 'progress_heartbeat'; parentToolId: string }
  | { type: 'activity' };

const TOOL_NAME_ALIASES: Record<string, string> = {
  Read: 'ReadFile',
  ReadFile: 'ReadFile',
  Grep: 'rg',
  rg: 'rg',
  Bash: 'Shell',
  Shell: 'Shell',
  Edit: 'Edit',
  NotebookEdit: 'NotebookEdit',
  Write: 'Write',
  Glob: 'Glob',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  SemanticSearch: 'SemanticSearch',
  Task: 'Task',
  EnterPlanMode: 'EnterPlanMode',
  AskQuestion: 'AskQuestion',
  AskUserQuestion: 'AskQuestion',
};

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskQuestion']);

const STREAM_JSON_TOOL_NAME_ALIASES: Record<string, string> = {
  askQuestionToolCall: 'AskQuestion',
  askUserQuestionToolCall: 'AskQuestion',
  bashToolCall: 'Shell',
  editToolCall: 'Edit',
  enterPlanModeToolCall: 'EnterPlanMode',
  globToolCall: 'Glob',
  grepToolCall: 'rg',
  notebookEditToolCall: 'NotebookEdit',
  readToolCall: 'ReadFile',
  semanticSearchToolCall: 'SemanticSearch',
  shellToolCall: 'Shell',
  taskToolCall: 'Task',
  webFetchToolCall: 'WebFetch',
  webSearchToolCall: 'WebSearch',
  writeToolCall: 'Write',
};

function canonicalToolName(toolName: string): string {
  return TOOL_NAME_ALIASES[toolName] || toolName || 'Unknown';
}

function classifyTool(toolName: string): ToolClass {
  switch (toolName) {
    case 'ReadFile':
    case 'WebFetch':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'write';
    case 'Shell':
      return 'run';
    case 'Glob':
    case 'rg':
    case 'WebSearch':
    case 'SemanticSearch':
      return 'search';
    case 'Task':
      return 'task';
    case 'AskQuestion':
      return 'ask';
    case 'EnterPlanMode':
      return 'plan';
    default:
      return 'other';
  }
}

function parseStreamJsonToolCall(toolCall: Record<string, unknown> | undefined): {
  toolName: string;
  input: Record<string, unknown>;
} | null {
  if (!toolCall) return null;
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith('ToolCall') || !value || typeof value !== 'object') continue;
    const toolName = canonicalToolName(
      STREAM_JSON_TOOL_NAME_ALIASES[key] || key.replace(/ToolCall$/, ''),
    );
    const input = ((value as { args?: Record<string, unknown> }).args || {}) as Record<
      string,
      unknown
    >;
    return { toolName, input };
  }
  return null;
}

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'ReadFile': {
      const file = base(input.file_path) || base(input.path);
      return file ? `Reading ${file}` : 'Reading file';
    }
    case 'Edit':
      return `Editing ${base(input.file_path) || base(input.path)}`;
    case 'NotebookEdit':
      return 'Editing notebook';
    case 'Write':
      return `Writing ${base(input.file_path) || base(input.path)}`;
    case 'Shell': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'rg':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'SemanticSearch':
      return 'Exploring code';
    case 'Task': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    default:
      return `Using ${toolName}`;
  }
}

function parseRecord(record: Record<string, unknown>): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const message = record.message as Record<string, unknown> | undefined;
  const recordType =
    (typeof record.type === 'string' ? record.type : undefined) ||
    (typeof record.role === 'string' ? record.role : undefined);

  if (recordType === 'assistant' && Array.isArray(message?.content)) {
    const blocks = message.content as Array<{
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    let hasToolUse = false;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id) {
        hasToolUse = true;
        const toolName = canonicalToolName(block.name || '');
        const status = formatToolStatus(toolName, block.input || {});
        if (toolName === 'Task') {
          const desc = typeof block.input?.description === 'string' ? block.input.description : '';
          events.push({
            type: 'tool_start',
            scope: 'agent',
            toolId: block.id,
            toolName,
            status,
            toolClass: classifyTool(toolName),
            isSubagentRoot: true,
            subagentLabel: desc || 'Subtask',
          });
        } else {
          events.push({
            type: 'tool_start',
            scope: 'agent',
            toolId: block.id,
            toolName,
            status,
            toolClass: classifyTool(toolName),
          });
        }
      }
    }
    // Cursor CLI writes assistant with content blocks: type "text" or "thinking"
    if (
      !hasToolUse &&
      (blocks.some((b) => b.type === 'text') || blocks.some((b) => b.type === 'thinking'))
    ) {
      events.push({ type: 'assistant_text' });
    }
    return events;
  }

  if (recordType === 'user') {
    const content = message?.content;
    if (Array.isArray(content)) {
      const blocks = content as Array<{ type: string; tool_use_id?: string }>;
      let hasToolResult = false;
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          hasToolResult = true;
          events.push({ type: 'tool_done', scope: 'agent', toolId: block.tool_use_id });
        }
      }
      if (!hasToolResult) {
        events.push({ type: 'user_prompt' });
      }
      return events;
    }
    if (typeof content === 'string' && content.trim()) {
      events.push({ type: 'user_prompt' });
    }
    return events;
  }

  if (recordType === 'system' && record.subtype === 'turn_duration') {
    events.push({ type: 'turn_end' });
    return events;
  }

  if (recordType === 'tool_call') {
    const tool = parseStreamJsonToolCall(
      (record.tool_call as Record<string, unknown> | undefined) ||
        (record.toolCall as Record<string, unknown> | undefined),
    );
    const callId =
      (record.call_id as string | undefined) || (record.callId as string | undefined) || undefined;
    if (!tool || !callId) return events;
    if (record.subtype === 'started') {
      const status = formatToolStatus(tool.toolName, tool.input);
      if (tool.toolName === 'Task') {
        const desc = typeof tool.input.description === 'string' ? tool.input.description : '';
        events.push({
          type: 'tool_start',
          scope: 'agent',
          toolId: callId,
          toolName: tool.toolName,
          status,
          toolClass: classifyTool(tool.toolName),
          isSubagentRoot: true,
          subagentLabel: desc || 'Subtask',
        });
      } else {
        events.push({
          type: 'tool_start',
          scope: 'agent',
          toolId: callId,
          toolName: tool.toolName,
          status,
          toolClass: classifyTool(tool.toolName),
        });
      }
    } else if (record.subtype === 'completed') {
      events.push({ type: 'tool_done', scope: 'agent', toolId: callId });
    }
    return events;
  }

  if (recordType === 'result') {
    events.push({ type: 'turn_end' });
    return events;
  }

  if (recordType !== 'progress') return events;
  const parentToolId =
    (record.parentToolUseID as string | undefined) ||
    (record.parentToolUseId as string | undefined);
  const data = record.data as Record<string, unknown> | undefined;
  // Any progress record indicates agent activity (tools running, sub-agent, etc.)
  if (parentToolId || data) {
    events.push({ type: 'activity' });
  }
  if (!parentToolId) return events;
  if (!data) return events;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    events.push({ type: 'progress_heartbeat', parentToolId });
    return events;
  }

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return events;
  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return events;

  if (msgType === 'assistant') {
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = canonicalToolName(block.name || '');
        events.push({
          type: 'tool_start',
          scope: 'subagent',
          parentToolId,
          toolId: block.id,
          toolName,
          status: formatToolStatus(toolName, block.input || {}),
          toolClass: classifyTool(toolName),
        });
      }
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        events.push({
          type: 'tool_done',
          scope: 'subagent',
          parentToolId,
          toolId: block.tool_use_id,
        });
      }
    }
  }
  return events;
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const events = parseRecord(JSON.parse(line) as Record<string, unknown>);
    let hasNonExemptTool = false;

    for (const event of events) {
      if (event.type === 'tool_start' && event.scope === 'agent') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        agent.activeToolIds.add(event.toolId);
        agent.activeToolStatuses.set(event.toolId, event.status);
        agent.activeToolNames.set(event.toolId, event.toolName);
        if (!PERMISSION_EXEMPT_TOOLS.has(event.toolName)) {
          hasNonExemptTool = true;
        }
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId: event.toolId,
          toolName: event.toolName,
          toolClass: event.toolClass,
          status: event.status,
          isSubagentRoot: !!event.isSubagentRoot,
          subagentLabel: event.subagentLabel,
        });
      } else if (event.type === 'assistant_text') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        agent.isWaiting = false;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        if (!agent.hadToolsInTurn) {
          startWaitingTimer(
            agentId,
            TEXT_IDLE_DELAY_MS,
            agents,
            waitingTimers,
            webview,
            waitingToIdleTimers,
          );
        }
      } else if (event.type === 'activity') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        agent.isWaiting = false;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
      } else if (event.type === 'progress_heartbeat') {
        if (agent.activeToolIds.has(event.parentToolId)) {
          startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
        }
      } else if (event.type === 'tool_start' && event.scope === 'subagent') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        if (agent.activeToolNames.get(event.parentToolId) !== 'Task') continue;
        let subTools = agent.activeSubagentToolIds.get(event.parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(event.parentToolId, subTools);
        }
        subTools.add(event.toolId);
        let subNames = agent.activeSubagentToolNames.get(event.parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(event.parentToolId, subNames);
        }
        subNames.set(event.toolId, event.toolName);
        if (!PERMISSION_EXEMPT_TOOLS.has(event.toolName)) {
          hasNonExemptTool = true;
        }
        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId: event.parentToolId,
          toolId: event.toolId,
          toolName: event.toolName,
          toolClass: event.toolClass,
          status: event.status,
        });
      } else if (event.type === 'tool_done' && event.scope === 'agent') {
        const completedToolId = event.toolId;
        if (agent.activeToolNames.get(completedToolId) === 'Task') {
          agent.activeSubagentToolIds.delete(completedToolId);
          agent.activeSubagentToolNames.delete(completedToolId);
          webview?.postMessage({
            type: 'subagentClear',
            id: agentId,
            parentToolId: completedToolId,
          });
        }
        agent.activeToolIds.delete(completedToolId);
        agent.activeToolStatuses.delete(completedToolId);
        agent.activeToolNames.delete(completedToolId);
        setTimeout(() => {
          webview?.postMessage({
            type: 'agentToolDone',
            id: agentId,
            toolId: completedToolId,
          });
        }, TOOL_DONE_DELAY_MS);
        if (agent.activeToolIds.size === 0) {
          agent.hadToolsInTurn = false;
        }
      } else if (event.type === 'tool_done' && event.scope === 'subagent') {
        const subTools = agent.activeSubagentToolIds.get(event.parentToolId);
        if (subTools) {
          subTools.delete(event.toolId);
        }
        const subNames = agent.activeSubagentToolNames.get(event.parentToolId);
        if (subNames) {
          subNames.delete(event.toolId);
        }
        setTimeout(() => {
          webview?.postMessage({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId: event.parentToolId,
            toolId: event.toolId,
          });
        }, TOOL_DONE_DELAY_MS);
      } else if (event.type === 'turn_end') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        cancelPermissionTimer(agentId, permissionTimers);
        if (agent.activeToolIds.size > 0) {
          agent.activeToolIds.clear();
          agent.activeToolStatuses.clear();
          agent.activeToolNames.clear();
          agent.activeSubagentToolIds.clear();
          agent.activeSubagentToolNames.clear();
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }
        agent.isWaiting = true;
        agent.permissionSent = false;
        agent.hadToolsInTurn = false;
        webview?.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
        if (waitingToIdleTimers) {
          startWaitingToIdleTimer(agentId, agents, waitingToIdleTimers, webview);
        }
      } else if (event.type === 'user_prompt') {
        cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
      }
    }

    if (hasNonExemptTool) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  } catch {
    // Ignore malformed lines
  }
}
