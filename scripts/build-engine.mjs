#!/usr/bin/env node
/**
 * Build the SysCode engine as a single, self-contained executable.
 *
 * The engine is TypeScript driven directly by Node in development (Node 26 strips
 * types), but a distributable desktop app cannot rely on a system Node or on the
 * source checkout being present. This script turns the engine into a Node Single
 * Executable Application (SEA): esbuild collapses `packages/core/src/cli.ts` and every
 * dependency (including the `typescript` runtime) into one CJS file, and that file is
 * embedded into a copy of the Node binary. The result runs with neither node_modules
 * nor `node` on PATH.
 *
 * Node 25.5+ builds the executable itself via `--build-sea`, which is the path used
 * here. For older Node (where `--build-sea` does not exist) we fall back to the
 * documented manual route: prepare a blob with `--experimental-sea-config` and inject
 * it with `postject`. Both produce the same kind of artifact.
 *
 * Output (all under dist/, which is gitignored):
 *   dist/engine/syscode-engine   the standalone engine executable
 *   dist/engine/web/             the built interface, served by that engine
 *
 * Usage: node scripts/build-engine.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'dist', 'engine');
const entry = path.join(repoRoot, 'packages/core/src/cli.ts');
const bundlePath = path.join(outDir, 'cli.cjs');
const seaConfigPath = path.join(outDir, 'sea-config.json');
const blobPath = path.join(outDir, 'syscode-engine.blob');
const enginePath = path.join(outDir, 'syscode-engine');
const webSrc = path.join(repoRoot, 'apps/web/dist');
const webDest = path.join(outDir, 'web');

/** The fuse Node's SEA loader looks for; the manual `postject` path writes the blob at it. */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args, opts = {}) {
  const shown = [cmd, ...args].join(' ');
  console.log(`\n$ ${shown}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`command failed (exit ${res.status}): ${shown}`);
  return res;
}

/** Run without throwing, so the caller can decide whether to fall back. */
function tryRun(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: res.status === 0 && !res.error, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

function resolveBin(pkg) {
  const pkgJson = path.join(repoRoot, 'node_modules', pkg, 'package.json');
  if (!existsSync(pkgJson)) throw new Error(`${pkg} is not installed — run \`npm install\` first`);
  const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[pkg];
  const bin = path.join(repoRoot, 'node_modules', pkg, rel);
  // esbuild's bin is a native executable; postject's is a JS file needing node.
  return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
}

function main() {
  if (!existsSync(entry)) throw new Error(`engine entry not found: ${entry}`);
  if (!existsSync(path.join(webSrc, 'index.html'))) {
    throw new Error(`the interface is not built (${webSrc}/index.html missing) — run \`npm run build:web\` first`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Bundle the engine (and typescript) into one CJS file. node:* stays external —
  //    Node provides those builtins inside the SEA binary.
  const esbuild = resolveBin('esbuild');
  run(esbuild[0], [
    ...esbuild.slice(1),
    entry,
    '--bundle',
    '--platform=node',
    '--target=node26',
    '--format=cjs',
    `--outfile=${bundlePath}`,
    '--external:node:*',
    // import.meta is emptied for CJS output; http.ts guards it, so silence the note.
    '--log-override:empty-import-meta=silent',
  ]);

  // 2. Describe the SEA blob. `output` is the final executable for `--build-sea`, and
  //    the intermediate blob for the manual postject route.
  const seaConfig = {
    main: bundlePath,
    output: enginePath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2) + '\n');

  // 3. Build the executable. Node's own `--build-sea` (v25.5+) writes the finished
  //    binary directly; if this Node predates it, fall back to blob + postject.
  const builtIn = tryRun(process.execPath, [`--build-sea=${seaConfigPath}`]);
  if (builtIn.ok) {
    console.log('\n  used Node\'s built-in --build-sea');
  } else {
    console.log('\n  --build-sea unavailable; falling back to blob + postject');
    writeFileSync(seaConfigPath, JSON.stringify({ ...seaConfig, output: blobPath }, null, 2) + '\n');
    run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
    cpSync(process.execPath, enginePath);
    const postject = resolveBin('postject');
    run(postject[0], [...postject.slice(1), enginePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE]);
  }

  // 4. Make it executable and ship the interface beside it. The desktop shell points
  //    SYSCODE_WEB at this directory so the engine serves the bundled UI.
  chmodSync(enginePath, 0o755);
  cpSync(webSrc, webDest, { recursive: true });

  const size = statSync(enginePath).size;
  console.log(`\n  built ${enginePath}  (${(size / 1e6).toFixed(1)} MB)`);
  console.log(`  bundled interface ${webDest}\n`);
}

main();
