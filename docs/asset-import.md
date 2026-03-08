# Furniture import

How to get furniture assets into the Pixel Agents extension.

**Quick option:** Pre-built [GitHub Releases](https://github.com/nicholasfrei/pixel-agents/releases) include a `.vsix` with the full furniture catalog—no import needed if you install from the Releases page.

---

## Recommended: Pull from the published extension (most efficient)

The **most efficient way** to get the correct furniture is to pull it from the [official Pixel Agents extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) on the VS Code Marketplace. That build ships with the full furniture catalog (the [Office Interior Tileset 16x16](https://donarg.itch.io/officetileset) by Donarg, processed by the maintainer). There is no OSS version of that tileset; the upstream repo does not include it due to license.

**One command** (from repo root):

```bash
node scripts/pull-furniture-from-marketplace.js
```

The script downloads the current marketplace `.vsix`, extracts it, and copies `extension/dist/assets/furniture` into `webview-ui/public/assets/furniture/`. Then run `npx @vscode/vsce@2.26.0 package` (or `npm run build`) and reload the extension.

**Manual alternative** — if you prefer not to run the script:

1. Open [Pixel Agents on the Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) and click **Download Extension** under Resources.
2. Rename the `.vsix` to `.zip` and unzip. The furniture is at `extension/dist/assets/furniture/`.
3. Copy that folder into `webview-ui/public/assets/furniture/` (or `assets/furniture/` at repo root), then build and reload.

---

## Other options: local import pipelines

If you have the [Office Tileset](https://donarg.itch.io/officetileset) PNG (or a similar tileset) and want to import from source instead of pulling from the marketplace:

**On this branch (main):** The repo has both the **original 6-stage pipeline** (scripts 0–5 and `scripts/.tileset-working/`) restored from commit e7a95c6 and the **single-script** flow (`scripts/import-office-assets.ts`). Furniture is loaded from `dist/assets/furniture/` after `npm run build` (build copies repo `assets/` and webview public assets into `dist/assets/`).

---

## Current branch (main): single-script import

This is the flow that matches the import script and assets on this branch (refactored fork). It uses one script and writes to repo-root `assets/furniture/`.

### Source file

- **Tileset**: `Office Tileset All 16x16 no shadow.png`
- **Example location**: `~/Downloads/Office Tileset/Office Tileset All 16x16 no shadow.png`

The script looks in that folder by default, or you can pass the PNG path explicitly.

### Steps

1. **Run the import** (from repo root):
   ```bash
   npm run import-office-assets
   ```
   Or with an explicit path:
   ```bash
   npm run import-office-assets -- "/Users/nicholas/Downloads/Office Tileset/Office Tileset All 16x16 no shadow.png"
   ```
   - Reads the PNG, detects assets with flood-fill, writes `assets/furniture/misc/office_import_001.png` … `office_import_*.png` and `assets/furniture/furniture-catalog.json`.

2. **Build the extension**
   ```bash
   npm run build
   ```
   Copies `assets/` (and webview public assets) to `dist/assets/`.

3. **Reload the extension**  
   Reload the Extension Development Host. Open the Pixel Agents panel and the layout editor; imported furniture appears in the **Misc** tab.

### Paths (current branch)

| What | Path |
|------|------|
| Source PNG | Your file (e.g. `~/Downloads/Office Tileset/Office Tileset All 16x16 no shadow.png`) |
| Script | `scripts/import-office-assets.ts` |
| Output PNGs | `assets/furniture/misc/office_import_*.png` |
| Catalog | `assets/furniture/furniture-catalog.json` |
| At runtime | Extension loads from `dist/assets/furniture/` (after `npm run build`) |

---

## Original 6-stage pipeline (restored on main)

These files were restored from commit e7a95c6 and are present on main:

- `scripts/0-import-tileset.ts` – CLI wrapper for the pipeline
- `scripts/1-detect-assets.ts` – Flood-fill detection from tileset PNG
- `scripts/2-asset-editor.html` – Edit bounds/erase pixels
- `scripts/3-vision-inspect.ts` – Vision-based metadata (optional)
- `scripts/4-review-metadata.html` – Review/edit metadata (optional)
- `scripts/5-export-assets.ts` – Export PNGs + catalog to `webview-ui/public/assets/furniture/`
- `scripts/.tileset-working/*.json` – Detection and metadata from the original run
- `scripts/4b-generate-metadata-from-detection.ts` – Generate minimal metadata from detection (skip stages 2–4)

To use the 6-stage flow: put the tileset at `webview-ui/public/assets/office_tileset_16x16.png`, run 1 → 4b → 5 (or run 2–4 for full editing), then `npm run build`. Build copies webview public assets and repo `assets/` into `dist/assets/`, so furniture from either location is loaded by the extension.

---

## Original fork commit only (reference)

When you are on the **original fork** commit (e7a95c6) itself, the repo has the same scripts; the only difference is that commit’s esbuild copies only `webview-ui/public/assets/` to dist (no repo-root `assets/`). On main, esbuild copies both.

On the original fork:

- **Tileset location**: Copy your PNG to `webview-ui/public/assets/office_tileset_16x16.png`.
- **Quick path**: Run `1-detect-assets.ts` → `4b-generate-metadata-from-detection.ts` → `5-export-assets.ts` → `npm run build` → reload. (On that commit, build only copies `webview-ui/public/assets/` to `dist/assets/`.)
- **Full path**: Same plus optional stages 2–4 (asset editor, vision inspect, metadata review).

Details for the original pipeline (paths, stage order, and that build only copies webview public assets) are in git history at the original fork commit; the `4b` script in this repo is intended for use when you have that commit checked out.
