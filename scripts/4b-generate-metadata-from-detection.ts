/**
 * Generate minimal tileset-metadata-final.json from tileset-detection-output.json
 *
 * Use this to skip the interactive stages (2–4) and export with default names
 * and category "misc". Run after 1-detect-assets.ts and before 5-export-assets.ts.
 *
 * Usage:
 *   npx ts-node scripts/4b-generate-metadata-from-detection.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const TILE_SIZE = 16;
const detectionPath = join(__dirname, '.tileset-working', 'tileset-detection-output.json');
const outputPath = join(__dirname, '.tileset-working', 'tileset-metadata-final.json');

interface DetectionAsset {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paddedX: number;
  paddedY: number;
  paddedWidth: number;
  paddedHeight: number;
}

interface DetectionOutput {
  version: number;
  timestamp: string;
  sourceFile: string;
  tileset: { width: number; height: number };
  backgroundColor: string;
  assets: DetectionAsset[];
}

interface MetadataAsset {
  id: string;
  paddedX: number;
  paddedY: number;
  paddedWidth: number;
  paddedHeight: number;
  name: string;
  label: string;
  category: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  discard: boolean;
  colorEditable?: boolean;
  backgroundTiles?: number;
  canPlaceOnSurfaces?: boolean;
  partOfGroup?: boolean;
  groupId?: string | null;
}

function footprintTiles(pixels: number): number {
  return Math.max(1, Math.ceil(pixels / TILE_SIZE));
}

console.log('\n📋 Generate metadata from detection (skip stages 2–4)\n');
console.log(`   Reading: ${detectionPath}`);

const detection: DetectionOutput = JSON.parse(readFileSync(detectionPath, 'utf-8'));
const assets: MetadataAsset[] = detection.assets.map((a) => {
  const num = a.id.replace(/^ASSET_/, '');
  return {
    id: a.id,
    paddedX: a.paddedX,
    paddedY: a.paddedY,
    paddedWidth: a.paddedWidth,
    paddedHeight: a.paddedHeight,
    name: a.id,
    label: `Office Asset ${num}`,
    category: 'misc',
    footprintW: footprintTiles(a.paddedWidth),
    footprintH: footprintTiles(a.paddedHeight),
    isDesk: false,
    canPlaceOnWalls: false,
    discard: false,
    colorEditable: false,
    backgroundTiles: 0,
    canPlaceOnSurfaces: false,
    partOfGroup: false,
    groupId: null,
  };
});

const output = {
  version: 1,
  timestamp: new Date().toISOString(),
  sourceFile: detection.sourceFile,
  tileset: detection.tileset,
  backgroundColor: detection.backgroundColor,
  assets,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`   Written: ${outputPath}`);
console.log(`   Assets: ${assets.length} (all category: misc, discard: false)`);
console.log('\n✅ Next: npx ts-node scripts/5-export-assets.ts\n');
