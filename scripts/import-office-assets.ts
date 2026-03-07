import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { PNG } from 'pngjs';

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface DetectedAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  paddedX: number;
  paddedY: number;
  paddedWidth: number;
  paddedHeight: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls?: boolean;
}

const DEFAULT_SOURCE_DIR = join(homedir(), 'Downloads', 'Office Tileset');
const PREFERRED_SOURCE_FILES = [
  'Office Tileset All 16x16 no shadow.png',
  'Office Tileset All 16x16.png',
];
const GENERATED_ID_PREFIX = 'OFFICE_IMPORT_';
const GENERATED_FILE_PREFIX = 'office_import_';
const TILE_SIZE = 16;
const OUTPUT_ROOT = resolve(process.cwd(), 'assets', 'furniture');
const OUTPUT_CATEGORY = 'misc';
const OUTPUT_CATEGORY_DIR = join(OUTPUT_ROOT, OUTPUT_CATEGORY);
const OUTPUT_CATALOG_PATH = join(OUTPUT_ROOT, 'furniture-catalog.json');

function normalizeInputPath(input: string): string {
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2));
  }
  return resolve(input);
}

function resolveSourcePng(inputArg?: string): string {
  const candidate = normalizeInputPath(inputArg || DEFAULT_SOURCE_DIR);

  if (existsSync(candidate)) {
    const preferredFile = PREFERRED_SOURCE_FILES.map((file) => join(candidate, file)).find((file) =>
      existsSync(file),
    );
    if (preferredFile) return preferredFile;
  }

  if (existsSync(candidate) && candidate.toLowerCase().endsWith('.png')) {
    return candidate;
  }

  for (const file of PREFERRED_SOURCE_FILES) {
    const fullPath = join(DEFAULT_SOURCE_DIR, file);
    if (existsSync(fullPath)) return fullPath;
  }

  throw new Error(
    `Could not find a source PNG. Expected one of: ${PREFERRED_SOURCE_FILES.join(', ')}`,
  );
}

function footprintTiles(pixels: number): number {
  return Math.max(1, Math.ceil(pixels / TILE_SIZE));
}

function colorKey(pixel: Pixel): string {
  return `${pixel.r},${pixel.g},${pixel.b},${pixel.a}`;
}

function detectAssets(png: PNG): Array<Omit<DetectedAsset, 'file'>> {
  const { width, height, data } = png;

  function getPixel(x: number, y: number): Pixel {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const idx = (y * width + x) * 4;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
  }

  function sameColor(a: Pixel, b: Pixel): boolean {
    return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  }

  const colorCounts = new Map<string, number>();
  let hasTransparentPixels = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = getPixel(x, y);
      if (pixel.a === 0) hasTransparentPixels = true;
      const key = colorKey(pixel);
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
  }

  let background: Pixel = { r: 0, g: 0, b: 0, a: 0 };
  if (!hasTransparentPixels) {
    let bestKey = '';
    let bestCount = -1;
    for (const [key, count] of colorCounts) {
      if (count > bestCount) {
        bestKey = key;
        bestCount = count;
      }
    }
    const [r, g, b, a] = bestKey.split(',').map(Number);
    background = { r, g, b, a };
  }

  const visited = new Uint8Array(width * height);

  function floodFill(startX: number, startY: number): Array<[number, number]> {
    const region: Array<[number, number]> = [];
    const queue: Array<[number, number]> = [[startX, startY]];

    while (queue.length > 0) {
      const [x, y] = queue.shift()!;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const idx = y * width + x;
      if (visited[idx]) continue;

      const pixel = getPixel(x, y);
      if (sameColor(pixel, background)) continue;

      visited[idx] = 1;
      region.push([x, y]);

      queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    return region;
  }

  const detected: Array<Omit<DetectedAsset, 'file'>> = [];
  let nextId = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;

      const pixel = getPixel(x, y);
      if (sameColor(pixel, background)) continue;

      const region = floodFill(x, y);
      if (region.length === 0) continue;

      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (const [px, py] of region) {
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }

      const assetWidth = maxX - minX + 1;
      const assetHeight = maxY - minY + 1;
      const paddedWidth = Math.ceil(assetWidth / TILE_SIZE) * TILE_SIZE;
      const paddedHeight = Math.ceil(assetHeight / TILE_SIZE) * TILE_SIZE;
      const paddedX = Math.max(0, minX - Math.floor((paddedWidth - assetWidth) / 2));
      const paddedY = Math.max(0, minY - (paddedHeight - assetHeight));

      const suffix = String(nextId).padStart(3, '0');
      const id = `${GENERATED_ID_PREFIX}${suffix}`;
      const name = `${GENERATED_FILE_PREFIX}${suffix}`;

      detected.push({
        id,
        name,
        label: `Office Asset ${suffix}`,
        category: OUTPUT_CATEGORY,
        paddedX,
        paddedY,
        paddedWidth,
        paddedHeight,
        footprintW: footprintTiles(paddedWidth),
        footprintH: footprintTiles(paddedHeight),
        isDesk: false,
        canPlaceOnWalls: false,
      });
      nextId++;
    }
  }

  detected.sort((a, b) => a.paddedY - b.paddedY || a.paddedX - b.paddedX);
  return detected;
}

function extractAssetPng(
  tileset: PNG,
  asset: Pick<DetectedAsset, 'paddedX' | 'paddedY' | 'paddedWidth' | 'paddedHeight'>,
): Buffer {
  const out = new PNG({ width: asset.paddedWidth, height: asset.paddedHeight });
  const { width: tilesetWidth, height: tilesetHeight, data } = tileset;

  for (let y = 0; y < asset.paddedHeight; y++) {
    for (let x = 0; x < asset.paddedWidth; x++) {
      const sourceX = asset.paddedX + x;
      const sourceY = asset.paddedY + y;
      const dstIdx = (y * asset.paddedWidth + x) << 2;

      if (sourceX < 0 || sourceX >= tilesetWidth || sourceY < 0 || sourceY >= tilesetHeight) {
        out.data[dstIdx] = 0;
        out.data[dstIdx + 1] = 0;
        out.data[dstIdx + 2] = 0;
        out.data[dstIdx + 3] = 0;
        continue;
      }

      const srcIdx = (sourceY * tilesetWidth + sourceX) << 2;
      out.data[dstIdx] = data[srcIdx];
      out.data[dstIdx + 1] = data[srcIdx + 1];
      out.data[dstIdx + 2] = data[srcIdx + 2];
      out.data[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return PNG.sync.write(out);
}

function deletePreviouslyGeneratedFiles(): void {
  if (!existsSync(OUTPUT_CATEGORY_DIR)) return;

  for (const entry of readdirSync(OUTPUT_CATEGORY_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(GENERATED_FILE_PREFIX) || !entry.name.endsWith('.png')) continue;
    rmSync(join(OUTPUT_CATEGORY_DIR, entry.name));
  }
}

function readExistingCatalog(): CatalogEntry[] {
  if (!existsSync(OUTPUT_CATALOG_PATH)) return [];

  const parsed = JSON.parse(readFileSync(OUTPUT_CATALOG_PATH, 'utf-8')) as {
    assets?: CatalogEntry[];
  };
  return Array.isArray(parsed.assets) ? parsed.assets : [];
}

function main(): void {
  const sourcePngPath = resolveSourcePng(process.argv[2]);
  const sourceName = basename(sourcePngPath);

  console.log('\n📦 Import office assets (no AI)\n');
  console.log(`Source: ${sourcePngPath}`);

  mkdirSync(OUTPUT_CATEGORY_DIR, { recursive: true });
  const png = PNG.sync.read(readFileSync(sourcePngPath));
  const detected = detectAssets(png);

  console.log(`Detected ${detected.length} assets from ${sourceName}`);
  console.log(`Writing PNGs to ${OUTPUT_CATEGORY_DIR}`);

  deletePreviouslyGeneratedFiles();

  const importedCatalogEntries: CatalogEntry[] = [];
  for (const asset of detected) {
    const filename = `${asset.name}.png`;
    const filePath = join(OUTPUT_CATEGORY_DIR, filename);
    writeFileSync(filePath, extractAssetPng(png, asset));

    importedCatalogEntries.push({
      id: asset.id,
      name: asset.name,
      label: asset.label,
      category: asset.category,
      file: `furniture/${asset.category}/${filename}`,
      width: asset.paddedWidth,
      height: asset.paddedHeight,
      footprintW: asset.footprintW,
      footprintH: asset.footprintH,
      isDesk: asset.isDesk,
    });
  }

  const existingEntries = readExistingCatalog().filter(
    (entry) => !entry.id.startsWith(GENERATED_ID_PREFIX),
  );
  const mergedEntries = [...existingEntries, ...importedCatalogEntries].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const categories = Array.from(new Set(mergedEntries.map((entry) => entry.category))).sort();

  mkdirSync(OUTPUT_ROOT, { recursive: true });
  writeFileSync(
    OUTPUT_CATALOG_PATH,
    JSON.stringify(
      {
        version: 1,
        timestamp: new Date().toISOString(),
        totalAssets: mergedEntries.length,
        categories,
        assets: mergedEntries,
      },
      null,
      2,
    ),
  );

  console.log(`Generated ${OUTPUT_CATALOG_PATH}`);
  console.log('\nNext steps:');
  console.log('  1. Run `npm run build`');
  console.log('  2. Reload the extension window or Extension Development Host');
  console.log('  3. Open the layout editor and look in the `Misc` tab for the imported art\n');
}

main();
