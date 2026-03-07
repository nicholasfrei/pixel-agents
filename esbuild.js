const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy one directory's contents into dist/assets
 */
function copyAssetDirectoryContents(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) {
    return false;
  }

  fs.mkdirSync(dstDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    fs.cpSync(srcPath, dstPath, { recursive: true });
  }

  return true;
}

/**
 * Copy bundled webview assets plus repo-root imported assets to dist/assets
 */
function copyAssets() {
  const webviewAssetsDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const repoAssetsDir = path.join(__dirname, 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');

  if (fs.existsSync(dstDir)) {
    fs.rmSync(dstDir, { recursive: true });
  }

  const copiedWebviewAssets = copyAssetDirectoryContents(webviewAssetsDir, dstDir);
  const copiedRepoAssets = copyAssetDirectoryContents(repoAssetsDir, dstDir);

  if (copiedWebviewAssets || copiedRepoAssets) {
    console.log('✓ Copied bundled assets to dist/assets/');
    if (copiedRepoAssets) {
      console.log('✓ Included repo-root assets/ in dist/assets/');
    }
  } else {
    console.log('ℹ️  No assets folder found (optional)');
  }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // Copy assets after build
    copyAssets();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
