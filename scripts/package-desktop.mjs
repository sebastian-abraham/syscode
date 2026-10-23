#!/usr/bin/env node
/**
 * Build the distributable desktop app for the machine you are on.
 *
 * `tauri build` alone is not enough for SysCode: the shell starts a *bundled* engine, and
 * the engine is a Node SEA built per platform (`.exe` on Windows). This script
 *
 *   1. builds the interface (apps/web/dist),
 *   2. builds the single-file engine + copies the interface beside it (dist/engine),
 *   3. asks Tauri to bundle both, with a generated config that maps
 *      dist/engine/<engine> -> engine/<engine> and dist/engine/web -> web,
 *   4. prints where the installer landed.
 *
 * The resource map lives here rather than in tauri.conf.json on purpose: `tauri dev`
 * validates resource paths at compile time, and a fresh clone has no dist/engine yet.
 * Keeping it out of the checked-in config is what lets `npm run dev` work before anything
 * has been packaged.
 *
 * Usage: node scripts/package-desktop.mjs [--target <triple>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const engineName = process.platform === 'win32' ? 'syscode-engine.exe' : 'syscode-engine';
const enginePath = path.join(repoRoot, 'dist', 'engine', engineName);
const webPath = path.join(repoRoot, 'dist', 'engine', 'web');

const TARGETS = {
  linux: ['deb', 'appimage'],
  win32: ['nsis'],
  darwin: ['dmg', 'app'],
};

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    // npm on Windows is a .cmd shim; Node refuses to spawn it without a shell.
    shell: process.platform === 'win32' && cmd === npmCmd,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`command failed (exit ${res.status})`);
}

function main() {
  const targets = TARGETS[process.platform];
  if (!targets) {
    console.error(`unsupported platform for packaging: ${process.platform}`);
    process.exit(1);
  }

  run(npmCmd, ['run', 'build:web']);
  run(process.execPath, [path.join(repoRoot, 'scripts', 'build-engine.mjs')]);

  if (!existsSync(enginePath)) throw new Error(`engine not built at ${enginePath}`);
  if (!existsSync(path.join(webPath, 'index.html'))) throw new Error(`interface not built at ${webPath}`);

  // Absolute paths: unambiguous no matter which config file Tauri merges them from.
  const override = {
    bundle: {
      targets,
      resources: {
        [enginePath]: `engine/${engineName}`,
        [webPath]: 'web',
      },
    },
  };
  const overridePath = path.join(repoRoot, 'dist', 'tauri-bundle.json');
  mkdirSync(path.dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, JSON.stringify(override, null, 2) + '\n');

  // Anything after `--` is forwarded to `tauri build` (e.g. `--bundles deb`, `--target ...`).
  const forwarded = process.argv.slice(2).filter((a) => a !== '--');
  run(npmCmd, ['run', 'build', '-w', '@syscode/desktop', '--', '--config', overridePath, ...forwarded]);

  const bundleDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle');
  console.log(`\n  installer(s) in ${bundleDir}`);
  console.log(`  targets: ${targets.join(', ')}`);
  console.log('  verify by launching it from a directory with no repository and no env vars.\n');
}

try {
  main();
} catch (err) {
  console.error(`\n  packaging failed: ${err.message}\n`);
  process.exit(1);
}
