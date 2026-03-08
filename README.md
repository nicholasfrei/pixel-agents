# Pixel Agents

A VS Code extension that turns your AI coding agents into animated pixel art characters in a virtual office.

Each Cursor agent terminal you open spawns a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when writing code, reading when searching files, waiting when it needs your attention.

This is the source code for the free [Pixel Agents extension for VS Code](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). Install from the marketplace (full furniture catalog included), or download the `.vsix` from [GitHub Releases](https://github.com/nicholasfrei/pixel-agents/releases) and use **Extensions: Install from VSIX...**.


![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **One agent, one character** — every Cursor agent terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.105.0 or later (or Cursor)
- Cursor with agent/terminal workflow available

## Getting Started

If you just want to use Pixel Agents, the easiest way is to download the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). If you want to play with the code, develop, or contribute, then:

### Install from source

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
2. Click **+ Agent** to spawn a new Cursor agent terminal and its character
3. Start coding with Cursor Agent mode — watch the character react in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project and available via the extension is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. The tileset is not included in this repository due to its license. To use Pixel Agents locally with the full set of office furniture and decorations, purchase the tileset and import it directly. 

The importer reads `Office Tileset All 16x16 no shadow.png`, auto-detects the furniture sprites, writes them to `assets/furniture/`, and bundles them into `dist/assets/` on build. Imported assets currently land in the `Misc` category by default, while the built-in desks and chairs remain available as fallbacks.

If you have experience creating pixel art office assets and would like to contribute freely usable tilesets for the community, that would be hugely appreciated.

The extension will still work without the tileset — you'll get the default characters and basic layout, but the full furniture catalog requires the imported assets.

## How It Works

Pixel Agents watches Cursor transcript files (`~/.cursor/projects/<project-hash>/agent-transcripts/*.jsonl`) to track what each agent is doing. Status is derived from:

- **Thinking…** — transcript file is being written but no complete JSONL line yet (streaming).
- **Active** — complete transcript lines (assistant text, tool use, or progress) have been parsed; character shows tool activity when available.
- **Waiting for input** — no new transcript data for 30 seconds, or Cursor sent a turn-end signal; character shows a green checkmark bubble and an optional sound. After 15 minutes in this state, the character returns to **idle** (bubble clears, no "Waiting for input" label).

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

- **TODO: Fix the "Active" status for Cursor CLI** — In practice, Cursor CLI transcripts often do not include top-level tool-use records; only text/thinking and sometimes progress. The extension infers activity from assistant text, thinking blocks, progress records, and partial-line streaming, but the "Active" stage (with tool-specific labels) may not appear. Improving this requires either better signals from Cursor or alternative detection (e.g. terminal output or agent-tools directory).

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — release history
- [docs/asset-import.md](docs/asset-import.md) — getting furniture assets (pull from marketplace or 6-stage pipeline); reload the extension if the UI shows blank
- [docs/cursor-runtime.md](docs/cursor-runtime.md) — Cursor transcript paths and launch settings

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync** — the way agents are connected to Cursor terminal instances is not super robust and sometimes desyncs, especially when terminals are rapidly opened/closed or restored across sessions.
- **Cursor CLI status ("Active" stage)** — Cursor CLI transcript format does not expose top-level tool-use in the JSONL; the extension uses assistant text, thinking blocks, progress records, and partial-line streaming to show "Thinking…" and "Waiting for input", but the **Active** stage (with tool labels like "Reading file", "Running command") often does not appear. See TODO above.
- **Heuristic-based status detection** — Turn boundaries rely on explicit turn-end records when present and a 30-second idle timer when the transcript goes silent; after 15 minutes in "Waiting for input" the character returns to idle. Brief state misfires are still possible.
- **Platform testing** — the extension has been tested on Windows 11 and macOS. Linux may work but is less tested; there could be differences in file watching, paths, or terminal behavior.

## Roadmap

There are several areas where contributions would be very welcome:

- **Improve agent-terminal reliability** — more robust connection and sync between characters and Cursor agent terminals
- **Better status detection** — find or propose clearer signals for agent state transitions (waiting, done, permission needed). **Cursor CLI:** fix "Active" status so tool-specific activity is shown when the agent is replying or using tools (see TODO in How It Works).
- **Community assets** — freely usable pixel art tilesets or characters that anyone can use without purchasing third-party assets
- **Agent creation and definition** — define agents with custom skills, system prompts, names, and skins before launching them
- **Desks as directories** — click on a desk to select a working directory, drag and drop agents or click-to-assign to move them to specific desks/projects
- **Agent teams** — visualize multi-agent coordination and communication in Cursor workflows
- **Git worktree support** — agents working in different worktrees to avoid conflict from parallel work on the same files
- **Support for other agentic frameworks** — [OpenCode](https://github.com/nichochar/opencode), or really any kind of agentic experiment you'd want to run inside a pixel art interface (see [simile.ai](https://simile.ai/) for inspiration)

If any of these interest you, feel free to open an issue or submit a PR.

## License

This project is licensed under the [MIT License](LICENSE).
