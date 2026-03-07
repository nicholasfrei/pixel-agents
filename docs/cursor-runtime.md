# Cursor Runtime Contract

This extension now targets Cursor transcripts and launch semantics.

## Default launch command

- Setting: `pixel-agents.cursorLaunchCommand`
- Default: `agent`
- Optional: include `{sessionId}` in your command template if your CLI supports explicit resume/session IDs.

## Transcript discovery

- Root setting: `pixel-agents.cursorTranscriptsRootDir` (default `.cursor/projects`)
- Subdirectory setting: `pixel-agents.cursorTranscriptsSubdir` (default `agent-transcripts`)
- Effective default path:
  `~/.cursor/projects/<workspace-hash>/agent-transcripts/*.jsonl`

`<workspace-hash>` uses the workspace sanitizer and normalizes leading/trailing dashes.
The extension also probes both normalized and legacy variants to attach reliably.

## Rollover / reassignment behavior

- The watcher seeds all existing `.jsonl` files.
- New `.jsonl` files in the transcript directory are treated as session rollovers:
  - If an agent is focused, it is reassigned to the new transcript.
  - If no agent is focused, Pixel Agents attempts to adopt the active terminal.
- Known `.jsonl` files are also re-checked for fresh writes so a pending agent can attach
  when `agent --resume <id>` appends to an existing transcript file.

## Fixture samples

Sample transcript fixtures live in `fixtures/cursor-transcripts/`. They match the **cursor-cli file-based format**: one JSON object per line, using **`role`** (`"user"` / `"assistant"`) and **`message.content`** as an array of blocks with **`type: "text"`** and **`text: "..."`**. Real transcripts are at `~/.cursor/projects/<project-hash>/agent-transcripts/*.jsonl`.

- `text_turn.jsonl`: one user line, then assistant lines (text only).
- `tool_turn.jsonl`: user prompt then assistant text lines; cursor-cli does not write top-level tool_use, so tool turns appear as text-only.
- `subagent_turn.jsonl`: user prompt then multiple assistant text lines (e.g. subtask described in plain text).
