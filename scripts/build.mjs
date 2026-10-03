// scripts/build.mjs
// Builds the MV3 extension with esbuild.
// Outputs:
//   dist/background.js    — service worker
//   dist/content.js       — single bundled content script (replaces 10 files)
//   dist/manifest.json    — patched manifest referencing dist/
// Usage: node scripts/build.mjs [--watch] [--sourcemap]

import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = process.argv.includes('--watch');
const SOURCEMAP = process.argv.includes('--sourcemap');
const OUT_DIR = path.join(ROOT, 'dist');

const STATIC_FILES = [
  ['styles/table.css', 'styles/table.css'],
  ['styles/fetcher.css', 'styles/fetcher.css'],
  ['images/icon128.png', 'images/icon128.png']
];

const sharedOptions = {
  bundle: true,
  format: 'iife',
  // ES2024 lib features (Promise.withResolvers in queue.ts) need Chrome 119+.
  target: 'chrome120',
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
  minify: true,
  sourcemap: SOURCEMAP
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

async function assertFile(relativePath) {
  try {
    await stat(path.join(ROOT, relativePath));
  } catch {
    throw new Error(`Missing build input: ${relativePath}`);
  }
}

/**
 * Copy static assets and write the dist manifest. Runs in watch mode too —
 * esbuild watches sources only, so without this a CSS edit would need a
 * manual restart to reach dist/.
 */
async function copyStatic() {
  await mkdir(path.join(OUT_DIR, 'styles'), { recursive: true });
  await mkdir(path.join(OUT_DIR, 'images'), { recursive: true });
  for (const [from, to] of STATIC_FILES) {
    await copyFile(path.join(ROOT, from), path.join(OUT_DIR, to));
  }

  const manifestRaw = await readFile(path.join(ROOT, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  // Version is owned by package.json; the manifest must match or the store
  // rejects the update.
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    console.log(`[build] manifest version ${manifest.version} → ${pkg.version}`);
    manifest.version = pkg.version;
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error('manifest.content_scripts must be a non-empty array');
  }
  // dist ships one bundled content script; sources are always replaced by it.
  manifest.content_scripts = manifest.content_scripts.map((cs) => ({
    ...cs,
    js: ['content.js']
  }));

  const missingAssets = [];
  for (const cs of manifest.content_scripts) {
    for (const asset of [...(cs.js ?? []), ...(cs.css ?? [])]) {
      try {
        await stat(path.join(OUT_DIR, asset));
      } catch {
        missingAssets.push(asset);
      }
    }
  }
  for (const icon of Object.values(manifest.icons ?? {})) {
    try {
      await stat(path.join(OUT_DIR, icon));
    } catch {
      missingAssets.push(icon);
    }
  }
  if (missingAssets.length > 0) {
    throw new Error(`manifest references assets missing from dist: ${missingAssets.join(', ')}`);
  }

  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('[build] manifest.json patched and written');
}

async function run() {
  for (const [from] of STATIC_FILES) {
    await assertFile(from);
  }
  await assertFile('manifest.json');
  await assertFile('package.json');

  if (!WATCH) {
    // Stale artifacts from renamed/removed sources would otherwise survive
    // and get packaged.
    await rm(OUT_DIR, { recursive: true, force: true });
  }
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