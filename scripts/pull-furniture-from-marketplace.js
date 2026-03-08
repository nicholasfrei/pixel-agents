#!/usr/bin/env node
/**
 * Download the published Pixel Agents .vsix from the marketplace and copy
 * the furniture assets (catalog + PNGs) into webview-ui/public/assets/furniture/.
 *
 * The marketplace build includes the full furniture catalog; this avoids
 * running the import pipeline or needing the Donarg tileset.
 *
 * Usage: node scripts/pull-furniture-from-marketplace.js
 *
 * Requires: unzip (macOS/Linux) or 7z (Windows) for unpacking .vsix.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const VERSION = '1.0.2';
const VSIX_URL = `https://pablodelucca.gallery.vsassets.io/_apis/public/gallery/publisher/pablodelucca/extension/pixel-agents/${VERSION}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage`;
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMP_VSIX = path.join(REPO_ROOT, 'temp-pixel-agents-marketplace.vsix');
const TEMP_EXTRACT = path.join(REPO_ROOT, 'temp-vsix-extract');
const FURNITURE_SRC = path.join(TEMP_EXTRACT, 'extension', 'dist', 'assets', 'furniture');
const FURNITURE_DST = path.join(REPO_ROOT, 'webview-ui', 'public', 'assets', 'furniture');

function download(url) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(TEMP_VSIX);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirect = res.headers.location;
          return https.get(redirect, (r) => r.pipe(file).on('finish', () => file.close(resolve)));
        }
        res
          .pipe(file)
          .on('finish', () => file.close(resolve))
          .on('error', reject);
      })
      .on('error', reject);
  });
}

function rm(dirOrFile) {
  if (fs.existsSync(dirOrFile)) {
    fs.rmSync(dirOrFile, { recursive: true });
  }
}

function main() {
  console.log('\n📦 Pull furniture from Pixel Agents marketplace build\n');
  console.log('  URL:', VSIX_URL);
  console.log('  Out:', FURNITURE_DST);
  console.log('');

  if (!fs.existsSync(path.join(REPO_ROOT, 'webview-ui', 'public', 'assets'))) {
    fs.mkdirSync(path.join(REPO_ROOT, 'webview-ui', 'public', 'assets'), { recursive: true });
  }

  download(VSIX_URL)
    .then(() => {
      console.log('  Downloaded .vsix');
      rm(TEMP_EXTRACT);
      fs.mkdirSync(TEMP_EXTRACT, { recursive: true });
      const { execSync } = require('child_process');
      execSync(`unzip -o -q "${TEMP_VSIX}" -d "${TEMP_EXTRACT}"`, { stdio: 'inherit' });
      console.log('  Unpacked .vsix');

      if (!fs.existsSync(FURNITURE_SRC)) {
        console.error('  ❌ extension/dist/assets/furniture not found inside .vsix');
        process.exit(1);
      }

      rm(FURNITURE_DST);
      fs.cpSync(FURNITURE_SRC, FURNITURE_DST, { recursive: true });
      console.log('  Copied furniture to webview-ui/public/assets/furniture/');

      rm(TEMP_VSIX);
      rm(TEMP_EXTRACT);
      console.log('\n✅ Done. Run npm run build (or vsce package) and reload the extension.\n');
    })
    .catch((err) => {
      console.error('  ❌', err.message);
      process.exit(1);
    });
}

main();
