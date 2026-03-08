import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  CURSOR_AGENT_TOOLS_SUBDIR,
  FILE_WATCHER_POLL_INTERVAL_MS,
  PROJECT_SCAN_INTERVAL_MS,
  TEXT_IDLE_DELAY_MS,
  TRANSCRIPT_SCAN_MAX_DEPTH,
} from './constants.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startWaitingTimer,
} from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

export function startFileWatching(
  agentId: number,
  filePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const read = (): void =>
    readNewLines(agentId, agents, waitingTimers, permissionTimers, webview, waitingToIdleTimers);
  // Primary: fs.watch (unreliable on macOS — may miss events)
  try {
    const watcher = fs.watch(filePath, read);
    fileWatchers.set(agentId, watcher);
  } catch (e) {
    console.log(`[Pixel Agents] fs.watch failed for agent ${agentId}: ${e}`);
  }

  // Secondary: fs.watchFile (stat-based polling, reliable on macOS)
  try {
    fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, read);
  } catch (e) {
    console.log(`[Pixel Agents] fs.watchFile failed for agent ${agentId}: ${e}`);
  }

  // Tertiary: manual poll as last resort
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      try {
        fs.unwatchFile(filePath);
      } catch {
        /* ignore */
      }
      return;
    }
    read();
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.transcriptFile);
    if (stat.size <= agent.fileOffset) return;

    const buf = Buffer.alloc(stat.size - agent.fileOffset);
    const fd = fs.openSync(agent.transcriptFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset = stat.size;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    const hasPartialLine = agent.lineBuffer.trim().length > 0;

    if (hasLines) {
      // Complete line(s) — agent is replying (or tool result); show active
      cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      agent.isWaiting = false;
      webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
      if (agent.permissionSent) {
        agent.permissionSent = false;
        webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
      }
    } else if (hasPartialLine) {
      // File grew but no newline yet — transcript streaming (thinking/replying in progress)
      cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
      agent.isWaiting = false;
      webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'thinking' });
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(
        agentId,
        line,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
        waitingToIdleTimers,
      );
    }

    // Only start the "waiting for input" timer when we have complete lines and no partial line.
    // If we still have a partial line in the buffer, the agent is still streaming — don't start
    // the timer or we can briefly show "Waiting for input" when the next chunk is slow to arrive.
    if (hasLines && !hasPartialLine) {
      startWaitingTimer(
        agentId,
        TEXT_IDLE_DELAY_MS,
        agents,
        waitingTimers,
        webview,
        waitingToIdleTimers,
      );
    }
  } catch (e) {
    console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
  }
}

export function ensureProjectScan(
  projectDir: string,
  knownTranscriptFiles: Set<string>,
  transcriptFileMtimes: Map<string, number>,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  if (projectScanTimerRef.current) return;
  // Seed with all existing JSONL files so we only react to truly new ones
  try {
    const files = listTranscriptFiles(projectDir);
    for (const f of files) {
      knownTranscriptFiles.add(f);
      try {
        transcriptFileMtimes.set(f, fs.statSync(f).mtimeMs);
      } catch {
        /* ignore transient stat errors */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  projectScanTimerRef.current = setInterval(() => {
    scanForNewTranscriptFiles(
      projectDir,
      knownTranscriptFiles,
      transcriptFileMtimes,
      transcriptPollTimers,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
      waitingToIdleTimers,
    );
  }, PROJECT_SCAN_INTERVAL_MS);
}

function scanForNewTranscriptFiles(
  projectDir: string,
  knownTranscriptFiles: Set<string>,
  transcriptFileMtimes: Map<string, number>,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  let files: Array<{ filePath: string; mtimeMs: number }>;
  try {
    files = listTranscriptFiles(projectDir).map((filePath) => ({
      filePath,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    }));
  } catch {
    return;
  }

  for (const { filePath, mtimeMs } of files) {
    const prevMtime = transcriptFileMtimes.get(filePath) || 0;
    const isKnown = knownTranscriptFiles.has(filePath);

    if (!isKnown) {
      const attached = tryAttachTranscriptFile(
        filePath,
        projectDir,
        transcriptPollTimers,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        webview,
        persistAgents,
        waitingToIdleTimers,
      );
      if (attached) {
        knownTranscriptFiles.add(filePath);
      }
      transcriptFileMtimes.set(filePath, mtimeMs);
      continue;
    }

    // Resume/rebind flow: a pending agent can attach to an already-existing file
    // when that file receives fresh writes after the launch.
    if (
      mtimeMs > prevMtime &&
      hasPendingAgent(projectDir, agents) &&
      !isTranscriptOwned(filePath, agents)
    ) {
      const attached = attachPendingAgentToKnownTranscript(
        filePath,
        projectDir,
        transcriptPollTimers,
        activeAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        webview,
        persistAgents,
        waitingToIdleTimers,
      );
      if (attached) {
        transcriptFileMtimes.set(filePath, mtimeMs);
        continue;
      }
    }

    transcriptFileMtimes.set(filePath, mtimeMs);
  }
}

function listTranscriptFiles(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > TRANSCRIPT_SCAN_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Subagent transcripts are represented in parent progress events.
        if (entry.name === 'subagents') continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

function hasPendingAgent(projectDir: string, agents: Map<number, AgentState>): boolean {
  return findPendingAgentId(projectDir, agents) !== null;
}

function isTranscriptOwned(transcriptFile: string, agents: Map<number, AgentState>): boolean {
  for (const agent of agents.values()) {
    if (agent.transcriptFile === transcriptFile) return true;
  }
  return false;
}

function findPendingAgentId(projectDir: string, agents: Map<number, AgentState>): number | null {
  let candidateId: number | null = null;
  let candidateLaunchTimeMs = -1;
  for (const [id, agent] of agents) {
    if (agent.runtimeKind === 'stream-json') continue;
    if (agent.projectDir !== projectDir) continue;
    try {
      if (fs.existsSync(agent.transcriptFile)) continue;
    } catch {
      // If fs check fails, treat as not-yet-ready and allow reassignment.
    }
    const launchTime = agent.launchTimeMs || 0;
    if (launchTime > candidateLaunchTimeMs || candidateId === null) {
      candidateId = id;
      candidateLaunchTimeMs = launchTime;
    }
  }
  return candidateId;
}

function attachPendingAgentToKnownTranscript(
  transcriptFile: string,
  projectDir: string,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): boolean {
  const pendingAgentId = findPendingAgentId(projectDir, agents);
  if (pendingAgentId === null) return false;
  const pendingAgent = agents.get(pendingAgentId);
  if (!pendingAgent) return false;

  if (pendingAgent.launchTimeMs > 0) {
    try {
      const mtimeMs = fs.statSync(transcriptFile).mtimeMs;
      if (mtimeMs < pendingAgent.launchTimeMs) {
        return false;
      }
    } catch {
      return false;
    }
  }

  console.log(
    `[Pixel Agents] Known JSONL updated: ${path.basename(transcriptFile)}, attaching pending agent ${pendingAgentId}`,
  );
  activeAgentIdRef.current = pendingAgentId;
  reassignAgentToFile(
    pendingAgentId,
    transcriptFile,
    transcriptPollTimers,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
    persistAgents,
    waitingToIdleTimers,
  );
  return true;
}

function tryAttachTranscriptFile(
  transcriptFile: string,
  projectDir: string,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): boolean {
  if (isTranscriptOwned(transcriptFile, agents)) {
    return true;
  }

  if (activeAgentIdRef.current !== null && agents.has(activeAgentIdRef.current)) {
    console.log(
      `[Pixel Agents] New JSONL detected: ${path.basename(transcriptFile)}, reassigning to agent ${activeAgentIdRef.current}`,
    );
    reassignAgentToFile(
      activeAgentIdRef.current,
      transcriptFile,
      transcriptPollTimers,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
      waitingToIdleTimers,
    );
    return true;
  }

  const pendingAgentId = findPendingAgentId(projectDir, agents);
  if (pendingAgentId !== null) {
    console.log(
      `[Pixel Agents] New JSONL detected: ${path.basename(transcriptFile)}, attaching pending agent ${pendingAgentId}`,
    );
    activeAgentIdRef.current = pendingAgentId;
    reassignAgentToFile(
      pendingAgentId,
      transcriptFile,
      transcriptPollTimers,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
      waitingToIdleTimers,
    );
    return true;
  }

  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) return false;

  let owned = false;
  for (const agent of agents.values()) {
    if (agent.terminalRef === activeTerminal) {
      owned = true;
      break;
    }
  }
  if (owned) return false;

  adoptTerminalForFile(
    activeTerminal,
    transcriptFile,
    projectDir,
    nextAgentIdRef,
    agents,
    activeAgentIdRef,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
    persistAgents,
    waitingToIdleTimers,
  );
  return true;
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  transcriptFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    runtimeKind: 'transcript',
    projectDir,
    transcriptFile,
    launchTimeMs: Date.now(),
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(
    `[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(transcriptFile)}`,
  );
  webview?.postMessage({ type: 'agentCreated', id });

  startFileWatching(
    id,
    transcriptFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
    waitingToIdleTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers, webview, waitingToIdleTimers);
}

/**
 * Watch the agent-tools/ directory alongside a transcript. Cursor writes a new
 * .txt file there each time a tool completes, even when the JSONL is silent
 * (e.g. during bash/read execution). New files restart the idle timer so the
 * agent doesn't falsely transition to 'waiting' mid-tool-run.
 *
 * Returns a cleanup function.
 */
export function watchAgentToolsDir(
  projectDir: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): () => void {
  // projectDir is .../agent-transcripts — tools dir is one level up
  const toolsDir = path.join(path.dirname(projectDir), CURSOR_AGENT_TOOLS_SUBDIR);
  let knownFiles: Set<string> | null = null;
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function getFiles(): Set<string> {
    try {
      return new Set(fs.readdirSync(toolsDir).map((f) => path.join(toolsDir, f)));
    } catch {
      return new Set();
    }
  }

  function onActivity(): void {
    const current = getFiles();
    if (knownFiles === null) {
      knownFiles = current;
      return;
    }
    let hasNew = false;
    for (const f of current) {
      if (!knownFiles.has(f)) {
        hasNew = true;
        break;
      }
    }
    knownFiles = current;
    if (!hasNew) return;

    const webview = getWebview();
    // A new tool file appeared — restart idle timer for all currently-active agents
    for (const [agentId, agent] of agents) {
      if (!agent.isWaiting) {
        startWaitingTimer(
          agentId,
          TEXT_IDLE_DELAY_MS,
          agents,
          waitingTimers,
          webview,
          waitingToIdleTimers,
        );
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
      }
    }
  }

  knownFiles = getFiles();

  try {
    watcher = fs.watch(toolsDir, () => onActivity());
  } catch {
    /* directory may not exist yet */
  }

  pollTimer = setInterval(onActivity, FILE_WATCHER_POLL_INTERVAL_MS * 2);

  return () => {
    watcher?.close();
    if (pollTimer) clearInterval(pollTimer);
  };
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const tp = transcriptPollTimers.get(agentId);
  if (tp) {
    clearInterval(tp);
    transcriptPollTimers.delete(agentId);
  }

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);
  try {
    fs.unwatchFile(agent.transcriptFile);
  } catch {
    /* ignore */
  }

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, permissionTimers, webview);

  // Swap to new file
  agent.transcriptFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
    waitingToIdleTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers, webview, waitingToIdleTimers);
}
