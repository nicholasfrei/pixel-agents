import type * as vscode from 'vscode';

export interface AgentState {
  id: number;
  terminalRef: vscode.Terminal;
  runtimeKind: 'transcript' | 'stream-json';
  projectDir: string;
  transcriptFile: string;
  streamSessionId?: string;
  launchTimeMs: number;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Non-persisted cleanup hook for managed runtimes */
  runtimeHandle?: { dispose(): void };
}

export interface PersistedAgent {
  id: number;
  terminalName: string;
  transcriptFile: string;
  runtimeKind?: 'transcript' | 'stream-json';
  streamSessionId?: string;
  /** Backward compatibility with previously persisted schema */
  jsonlFile?: string;
  projectDir: string;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
}
