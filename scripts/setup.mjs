#!/usr/bin/env node
/**
 * One command to make this checkout runnable on the machine you are on.
 *
 * Checks the four things that actually break a first run — Node's version, the Rust
 * toolchain, the platform's webview libraries, and a shell for the verification scripts —
 * installs the dependencies (including devDependencies, which a global `omit=dev` would
 * otherwise skip), and prints the two commands to start the app.
 *
 * Usage:
 *   node scripts/setup.mjs            # check + install
 *   node scripts/setup.mjs --check    # check only, change nothing   (npm run doctor)
 *   node scripts/setup.mjs --no-install
 *
 * Exit code 1 means something is genuinely missing; warnings do not fail.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check') || args.has('--doctor');
const noInstall = args.has('--no-install') || checkOnly;
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const MIN_NODE = [22, 18];
const problems = [];
const warnings = [];

function line(ok, label, detail = '') {
  console.log(`  ${ok === true ? '[ok]' : ok === false ? '[!!]' : '[--]'}  ${label}${detail ? `  ${detail}` : ''}`);
}

function capture(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, {
    encoding: 'utf8',
    shell: isWin && cmd === npmCmd,
    ...opts,
  });
  if (res.error) return { ok: false, error: res.error.message };
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(), status: res.status };
}

function run(cmd, argv) {
  const res = spawnSync(cmd, argv, { stdio: 'inherit', cwd: repoRoot, shell: isWin && cmd === npmCmd });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${res.status}`);
}

/* --------------------------------------------------------------- versions -- */

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const good = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  line(good, 'Node', `v${process.versions.node}`);
  if (!good) {
    problems.push(
      `Node ${MIN_NODE.join('.')}+ is required (type stripping runs the engine's TypeScript directly).\n` +
        '      Install Node 24 LTS from https://nodejs.org/en/download and reopen the terminal.',
    );
  }
  return good;
}

function checkNpm() {
  const res = capture(npmCmd, ['--version']);
  line(res.ok, 'npm', res.ok ? `v${res.out}` : 'not found');
  if (!res.ok) problems.push('npm is missing — reinstall Node from https://nodejs.org (it ships npm).');
}

function checkRust() {
  const rustc = capture('rustc', ['--version']);
  const cargo = capture('cargo', ['--version']);
  line(rustc.ok && cargo.ok, 'Rust toolchain', rustc.ok ? rustc.out.replace('rustc ', '') : 'not found');
  if (!rustc.ok || !cargo.ok) {
    if (isWin) {
      problems.push(
        'Rust is missing. Install it with:\n' +
          '        winget install --id Rustlang.Rustup -e\n' +
          '      then install the MSVC toolchain when rustup asks (press 1 + Enter), and reopen the terminal.\n' +
          '      rustup needs the "Desktop development with C++" workload — if it is missing, run the\n' +
          '      Visual Studio Build Tools installer and tick that workload.',
      );
    } else if (process.platform === 'darwin') {
      problems.push('Rust is missing: install Xcode command line tools (`xcode-select --install`), then https://rustup.rs');
    } else {
      problems.push('Rust is missing: install it with https://rustup.rs (or `sudo pacman -S rust`).');
    }
  }
  if (isWin && rustc.ok) {
    const toolchain = capture('rustup', ['show', 'active-toolchain']);
    if (toolchain.ok && !toolchain.out.includes('msvc')) {
      warnings.push(
        `your Rust toolchain is "${toolchain.out.split(/\s+/)[0]}". Tauri needs the MSVC target:\n` +
          '      rustup default stable-x86_64-pc-windows-msvc',
      );
    }
  }
  return rustc.ok && cargo.ok;
}

/* ------------------------------------------------------------ platform -- */

function checkWindowsExtras() {
  // WebView2 ships with Windows 11; on Windows 10 it may be absent. The EdgeUpdate client
  // key is the documented place to look, machine-wide and per-user.
  const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  const sites = [
    ['reg', ['query', `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`, '/v', 'pv']],
    ['reg', ['query', `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`, '/v', 'pv']],
  ];
  const found = sites.some(([cmd, argv]) => capture(cmd, argv).ok);
  line(found, 'WebView2 runtime', found ? '' : 'not detected');
  if (!found) {
    warnings.push(
      'WebView2 was not detected. Windows 11 includes it; on Windows 10 install the Evergreen\n' +
        '      runtime: https://developer.microsoft.com/microsoft-edge/webview2/',
    );
  }
}

function checkLinuxExtras() {
  const webkit = capture('pkg-config', ['--exists', 'webkit2gtk-4.1']);
  const gtk = capture('pkg-config', ['--exists', 'gtk+-3.0']);
  line(webkit.ok && gtk.ok, 'webkit2gtk-4.1 + gtk3');
  if (!webkit.ok || !gtk.ok) {
    problems.push(
      'the system webview libraries are missing. Install them with:\n' +
        '        CachyOS/Arch:  sudo pacman -S webkit2gtk-4.1 gtk3 libsoup3\n' +
        '        Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev',
    );
  }
}

function checkMacExtras() {
  const xcode = capture('xcode-select', ['-p']);
  line(xcode.ok, 'Xcode command line tools', xcode.ok ? xcode.out : 'not installed');
  if (!xcode.ok) problems.push('install the command line tools: xcode-select --install');
}

function checkShell() {
  const bash = capture('bash', ['--version']);
  line(bash.ok, 'bash (verification scripts)', bash.ok ? '' : 'not on PATH');
  if (!bash.ok) {
    warnings.push(
      'scripts/smoke.sh and scripts/stability.sh need bash. On Windows use Git Bash or WSL;\n' +
        '      the app itself does not need them.',
    );
  }
}

/* ---------------------------------------------------------------- install -- */

function install() {
  const hasModules = existsSync(path.join(repoRoot, 'node_modules'));
  console.log(`\n  ${hasModules ? 'updating' : 'installing'} dependencies (this is the long one on a fresh clone)\n`);
  run(npmCmd, ['install', '--include=dev']);
}

/* ------------------------------------------------------------------- main -- */

function main() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  console.log(`\nSysCode setup — ${process.platform} ${process.arch}, ${pkg.name} ${pkg.version}\n`);

  const nodeOk = checkNode();
  checkNpm();
  checkRust();
  if (isWin) checkWindowsExtras();
  else if (process.platform === 'linux') checkLinuxExtras();
  else if (process.platform === 'darwin') checkMacExtras();
  checkShell();

  if (!nodeOk) {
    console.log('\n  stopping: nothing else can be checked until Node is current.\n');
    process.exit(1);
  }

  if (!noInstall) install();

  if (problems.length) {
    console.log('\n  Blocking problems:\n');
    for (const p of problems) console.log(`    - ${p}`);
    console.log('');
    process.exit(1);
  }
  if (warnings.length) {
    console.log('\n  Warnings (the app still runs; these may bite later):\n');
    for (const w of warnings) console.log(`    - ${w}`);
    console.log('');
  }

  console.log('\n  Ready. From this directory:\n');
  console.log('    npm run dev              desktop app: engine + canvas in a native window');
  console.log('    npm run dev:web          browser UI at http://localhost:5173 (needs an engine)');
  console.log('    npm run serve -- fixtures/demo-app    engine only, on http://127.0.0.1:4317');
  console.log('    npm run doctor           re-run these checks without changing anything');
  console.log('\n  First run is slow (Rust compiles the shell once); later runs are seconds.\n');
}

main();
