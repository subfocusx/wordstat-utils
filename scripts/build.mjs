// scripts/build.mjs
// Builds the MV3 extension with esbuild.
// Outputs:
//   dist/background.js    — service worker
//   dist/content.js       — single bundled content script (replaces 10 files)
//   dist/manifest.json    — patched manifest referencing dist/

import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = process.argv.includes('--watch');
const OUT_DIR = path.join(ROOT, 'dist');

const sharedOptions = {
  bundle: true,
  format: 'iife',
  target: 'chrome100',
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
  minify: true,
  // Avoid generating a sourcemap by default; enable with --sourcemap if needed.
  sourcemap: false
};

const buildOptions = [
  {
    ...sharedOptions,
    entryPoints: [path.join(ROOT, 'src', 'background.ts')],
    outfile: path.join(OUT_DIR, 'background.js')
  },
  {
    ...sharedOptions,
    entryPoints: [path.join(ROOT, 'src', 'content', 'index.ts')],
    outfile: path.join(OUT_DIR, 'content.js')
  }
];

async function copyStatic() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.join(OUT_DIR, 'styles'), { recursive: true });
  await mkdir(path.join(OUT_DIR, 'images'), { recursive: true });
  // CSS goes to dist/styles/* to match manifest.json paths.
  await copyFile(path.join(ROOT, 'styles', 'table.css'), path.join(OUT_DIR, 'styles', 'table.css'));
  await copyFile(path.join(ROOT, 'styles', 'fetcher.css'), path.join(OUT_DIR, 'styles', 'fetcher.css'));
  await copyFile(path.join(ROOT, 'images', 'icon128.png'), path.join(OUT_DIR, 'images', 'icon128.png'));
  // Patch manifest.json: replace content_scripts.js array with ['content.js'].
  const manifestRaw = await readFile(path.join(ROOT, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  manifest.content_scripts = manifest.content_scripts.map((cs) => ({
    ...cs,
    js: ['content.js']
  }));
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('[build] manifest.json patched and written');
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  if (WATCH) {
    const ctxs = await Promise.all(buildOptions.map((opts) => context(opts)));
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log('[build] watching for changes…');
  } else {
    await Promise.all(buildOptions.map((opts) => build(opts)));
  }
  await copyStatic();
  if (!WATCH) console.log('[build] done →', OUT_DIR);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});