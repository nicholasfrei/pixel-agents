# Reloading furniture assets from scratch

If furniture shows **blank** in the UI, the extension is either missing PNGs or the catalog doesn’t match the files. Use the direct office import flow to regenerate everything.

## What you need

- **Office Interior Tileset (16×16)** by Donarg from [itch.io](https://donarg.itch.io/officetileset)
- A local copy of the source art, ideally in `~/Downloads/Office Tileset`

## Import assets

From the project root:

```bash
npm run import-office-assets -- "~/Downloads/Office Tileset"
npm run build
```

What this does:

- Reads `Office Tileset All 16x16 no shadow.png` from the given folder
- Detects individual furniture regions automatically
- Writes extracted PNGs to `assets/furniture/misc/`
- Generates `assets/furniture/furniture-catalog.json`
- Bundles those assets into `dist/assets/` on build

You can also pass a direct PNG path instead of a folder.

## Reload the extension

- If using **Extension Development Host**: press **F5** or use the reload action
- Otherwise reload the VS Code window or reopen the Pixel Agents panel

## Notes

- Imported art shows up in the editor under the `Misc` tab
- Built-in desks and chairs remain available as fallbacks
- The importer currently assigns generic labels and default metadata

## Where assets load from

- **Development/runtime fallback**: repo-root `assets/furniture/furniture-catalog.json`
- **Built extension**: `dist/assets/furniture/furniture-catalog.json`

If something still shows blank, check the Extension Host console for `[AssetLoader]` messages about missing files or catalog entries.
