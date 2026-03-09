import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  CURSOR_LAUNCH_COMMAND_TEMPLATE,
  CURSOR_TRANSCRIPTS_ROOT_DIR,
  CURSOR_TRANSCRIPTS_SUBDIR,
  JSONL_POLL_INTERVAL_MS,
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { ensureProjectScan, readNewLines, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { isStreamJsonLaunchCommand, StreamJsonTerminalRuntime } from './streamJsonRuntime.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

function normalizeLegacyProjectDir(projectDir: string): string {
  const marker = `${path.sep}${CURSOR_TRANSCRIPTS_ROOT_DIR}${path.sep}-`;
  if (!projectDir.includes(marker)) return projectDir;
  return projectDir.replace(marker, `${path.sep}${CURSOR_TRANSCRIPTS_ROOT_DIR}${path.sep}`);
}

function resolveProjectDir(projectDir: string): string {
  const normalizedLegacy = normalizeLegacyProjectDir(projectDir);
  if (normalizedLegacy !== projectDir) {
    try {
      if (fs.existsSync(normalizedLegacy)) {
        return normalizedLegacy;
      }
    } catch {
      /* ignore fs errors and continue */
    }
  }
  try {
    if (fs.existsSync(projectDir)) return projectDir;
  } catch {
    /* ignore fs errors and continue */
  }
  return getTranscriptProjectDirPath() || normalizedLegacy;
}

function remapTranscriptFilePath(
  transcriptFile: string,
  originalProjectDir: string,
  resolvedProjectDir: string,
): string {
  const normalizedLegacy = normalizeLegacyProjectDir(transcriptFile);
  if (normalizedLegacy !== transcriptFile) {
    transcriptFile = normalizedLegacy;
  }
  if (
    originalProjectDir &&
    resolvedProjectDir &&
    originalProjectDir !== resolvedProjectDir &&
    transcriptFile.startsWith(originalProjectDir + path.sep)
  ) {
    return path.join(resolvedProjectDir, path.basename(transcriptFile));
  }
  return transcriptFile;
}

export function getTranscriptProjectDirPath(cwd?: string): string | null {
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return null;
  const config = vscode.workspace.getConfiguration('pixel-agents');
  const rootOverride = config.get<string>('cursorTranscriptsRootDir');
  const subdirOverride = config.get<string>('cursorTranscriptsSubdir');
  const rootDir = rootOverride?.trim() || CURSOR_TRANSCRIPTS_ROOT_DIR;
  const subdir = subdirOverride?.trim() || CURSOR_TRANSCRIPTS_SUBDIR;
  const sanitized = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
  const normalized = sanitized.replace(/^-+/, '').replace(/-+$/, '');

  // Cursor hash naming can vary across versions/platforms. Prefer whichever
  // candidate already exists so we reliably attach to live transcripts.
  const candidates = Array.from(new Set([normalized, sanitized]));
  for (const dirName of candidates) {
    const candidateDir = path.join(os.homedir(), rootDir, dirName, subdir);
    try {
      if (fs.existsSync(candidateDir)) {
        console.log(`[Pixel Agents] Project dir: ${workspacePath} → ${dirName}`);
        return candidateDir;
      }
    } catch {
      /* ignore fs errors and keep trying candidates */
    }
  }

  const fallbackDir = path.join(os.homedir(), rootDir, normalized, subdir);
  console.log(`[Pixel Agents] Project dir (fallback): ${workspacePath} → ${normalized}`);
  return fallbackDir;
}

function getLaunchCommandTemplate(): string {
  const config = vscode.workspace.getConfiguration('pixel-agents');
  return config.get<string>('cursorLaunchCommand', CURSOR_LAUNCH_COMMAND_TEMPLATE).trim();
}

function getLaunchCommand(sessionId: string): string {
  const template = getLaunchCommandTemplate();
  return template.includes('{sessionId}')
    ? template.replaceAll('{sessionId}', sessionId)
    : template;
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownTranscriptFiles: Set<string>,
  transcriptFileMtimes: Map<string, number>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  folderPath?: string,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folderPath || folders?.[0]?.uri.fsPath;
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const sessionId = crypto.randomUUID();
  const commandTemplate = getLaunchCommandTemplate();
  const launchCommand = isStreamJsonLaunchCommand(commandTemplate)
    ? commandTemplate
    : getLaunchCommand(sessionId);
  const terminalName = `${TERMINAL_NAME_PREFIX} #${idx}`;
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;

  if (isStreamJsonLaunchCommand(launchCommand)) {
    const id = nextAgentIdRef.current++;
    const runtime = new StreamJsonTerminalRuntime(
      id,
      cwd || process.cwd(),
      launchCommand,
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      pty: runtime,
    });
    const agent: AgentState = {
      id,
      terminalRef: terminal,
      runtimeKind: 'stream-json',
      projectDir: getTranscriptProjectDirPath(cwd) || cwd || '',
      transcriptFile: '',
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
      folderName,
      runtimeHandle: runtime,
    };
    agents.set(id, agent);
    activeAgentIdRef.current = id;
    persistAgents();
    console.log(
      `[Pixel Agents] Agent ${id}: created managed stream-json terminal ${terminal.name}`,
    );
    webview?.postMessage({ type: 'agentCreated', id, folderName });
    terminal.show();
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd,
  });
  terminal.show();
  terminal.sendText(launchCommand);

  const projectDir = getTranscriptProjectDirPath(cwd);
  if (!projectDir) {
    console.log(`[Pixel Agents] No project dir, cannot track agent`);
    return;
  }

  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  // Only pre-register when we explicitly passed this session ID through launch command.
  if (launchCommand.includes(sessionId)) {
    knownTranscriptFiles.add(expectedFile);
  }

  // Create agent immediately (before transcript file exists)
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    runtimeKind: 'transcript',
    projectDir,
    transcriptFile: expectedFile,
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
    folderName,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name}`);
  webview?.postMessage({ type: 'agentCreated', id, folderName });

  ensureProjectScan(
    projectDir,
    knownTranscriptFiles,
    transcriptFileMtimes,
    transcriptPollTimers,
    projectScanTimers,
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

  // Poll for the specific transcript file to appear
  const pollTimer = setInterval(() => {
    try {
      if (fs.existsSync(agent.transcriptFile)) {
        console.log(
          `[Pixel Agents] Agent ${id}: found transcript file ${path.basename(agent.transcriptFile)}`,
        );
        clearInterval(pollTimer);
        transcriptPollTimers.delete(id);
        startFileWatching(
          id,
          agent.transcriptFile,
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
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  transcriptPollTimers.set(id, pollTimer);
}

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop transcript poll timer
  const jpTimer = transcriptPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  transcriptPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);
  if (agent.transcriptFile) {
    try {
      fs.unwatchFile(agent.transcriptFile);
    } catch {
      /* ignore */
    }
  }

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers, waitingToIdleTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  agent.runtimeHandle?.dispose();

  // Remove from maps
  agents.delete(agentId);
  persistAgents();
}

export function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      terminalName: agent.terminalRef.name,
      transcriptFile: agent.transcriptFile,
      runtimeKind: agent.runtimeKind,
      streamSessionId: agent.streamSessionId,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
    });
  }
  context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  knownTranscriptFiles: Set<string>,
  transcriptFileMtimes: Map<string, number>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  transcriptPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  webview: vscode.Webview | undefined,
  doPersist: () => void,
  waitingToIdleTimers?: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  const restoredProjectDirs = new Set<string>();

  for (const p of persisted) {
    if (p.runtimeKind === 'stream-json') continue;
    const terminal = liveTerminals.find((t) => t.name === p.terminalName);
    if (!terminal) continue;

    const resolvedProjectDir = resolveProjectDir(p.projectDir);
    const restoredTranscriptFile = remapTranscriptFilePath(
      p.transcriptFile || p.jsonlFile || '',
      p.projectDir,
      resolvedProjectDir,
    );

    const agent: AgentState = {
      id: p.id,
      terminalRef: terminal,
      runtimeKind: 'transcript',
      projectDir: resolvedProjectDir,
      transcriptFile: restoredTranscriptFile,
      streamSessionId: p.streamSessionId,
      launchTimeMs: 0,
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
      folderName: p.folderName,
    };

    agents.set(p.id, agent);
    knownTranscriptFiles.add(agent.transcriptFile);
    try {
      transcriptFileMtimes.set(agent.transcriptFile, fs.statSync(agent.transcriptFile).mtimeMs);
    } catch {
      /* transcript may not exist yet */
    }
    console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}"`);

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Cursor Agent #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDirs.add(agent.projectDir);

    // Start file watching if transcript exists, skipping to end of file
    try {
      if (fs.existsSync(agent.transcriptFile)) {
        const stat = fs.statSync(agent.transcriptFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          agent.transcriptFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
          waitingToIdleTimers,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.transcriptFile)) {
              console.log(`[Pixel Agents] Restored agent ${p.id}: found transcript file`);
              clearInterval(pollTimer);
              transcriptPollTimers.delete(p.id);
              const stat = fs.statSync(agent.transcriptFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.transcriptFile,
                agents,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
                webview,
                waitingToIdleTimers,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        transcriptPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  doPersist();

  // Start project scans for /clear detection across all restored projects.
  if (restoredProjectDirs.size === 0) {
    const defaultProjectDir = getTranscriptProjectDirPath();
    if (defaultProjectDir) {
      restoredProjectDirs.add(defaultProjectDir);
    }
  }

  for (const scanProjectDir of restoredProjectDirs) {
    ensureProjectScan(
      scanProjectDir,
      knownTranscriptFiles,
      transcriptFileMtimes,
      transcriptPollTimers,
      projectScanTimers,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      doPersist,
      waitingToIdleTimers,
    );
  }
}

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = context.workspaceState.get<
    Record<string, { palette?: number; seatId?: string }>
  >(WORKSPACE_KEY_AGENT_SEATS, {});

  // Include folderName per agent
  const folderNames: Record<number, string> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
  });

  sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
      });
    }
    // Re-send status so UI matches extension state (fixes stale idle after panel refresh)
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    } else if (agent.activeToolStatuses.size > 0) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'active',
      });
    } else {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'idle',
      });
    }
  }
}

export function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const layout = migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout,
  });
}
