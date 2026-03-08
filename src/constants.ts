// ── Timing (ms) ──────────────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 1000;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
// After file data stops arriving, treat the turn as complete.
// Cursor CLI transcripts use role+message (no top-level tool_use); assistant
// content has type "text" or "thinking". We treat those + progress records as
// activity (active status). File silence is the turn-end signal when
// turn_duration is absent. Tools can be silent 30-60s+ while running, so we use
// a longer delay to avoid false 'waiting' during tool execution.
/** Delay (ms) before showing "Waiting for input" after transcript goes silent. 30 seconds. */
export const TEXT_IDLE_DELAY_MS = 30000;
/** After this long in "Waiting for input" state, character returns to idle (no bubble). 15 minutes. */
export const WAITING_TO_IDLE_DELAY_MS = 15 * 60 * 1000;
// Secondary activity signal: new files in agent-tools/ mean tools are running.
// This extends the idle timer by another TEXT_IDLE_DELAY_MS when fired.
export const CURSOR_AGENT_TOOLS_SUBDIR = 'agent-tools';
export const TRANSCRIPT_SCAN_MAX_DEPTH = 3;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 128;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_PATTERN_COUNT = 7;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_CLOSE_PANEL = 'pixel-agents.closePanel';
export const COMMAND_OPEN_TAB = 'pixel-agents.openTab';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';
export const TERMINAL_NAME_PREFIX = 'Cursor Agent';

// ── Cursor Integration Defaults ───────────────────────────────
export const CURSOR_TRANSCRIPTS_ROOT_DIR = '.cursor/projects';
export const CURSOR_TRANSCRIPTS_SUBDIR = 'agent-transcripts';
export const CURSOR_LAUNCH_COMMAND_TEMPLATE = 'agent';
