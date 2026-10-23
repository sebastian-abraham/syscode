# Running SysCode on your machine

Three commands on any OS:

```bash
npm install
npm run setup     # checks Node, Rust, the webview libraries; prints what is missing
npm run dev       # engine + canvas in a native window
```

`npm run setup` is optional but it is the fastest way to find out *why* something will not
build before you spend ten minutes on it. `npm run doctor` runs the same checks without
installing anything.

The first `npm run dev` compiles the Rust shell once (2–5 minutes, more on Windows). Every
run after that is a few seconds.

---

## 1. What you need

| | Windows 10/11 | macOS | Linux |
|---|---|---|---|
| **Node** | 24 LTS (or ≥ 22.18) | same | same |
| **Rust** | rustup + MSVC toolchain | rustup + Xcode CLT | rustup |
| **Webview** | WebView2 (built into Win 11) | WKWebView (in macOS) | `webkit2gtk-4.1` + `gtk3` |
| **Compiler** | "Desktop development with C++" workload | Xcode command line tools | `build-essential` / `base-devel` |
| **Git** | Git for Windows | preinstalled | package manager |
| **bash** (optional) | Git Bash or WSL | preinstalled | preinstalled |

Node ≥ 22.18 matters: the engine is TypeScript run directly by Node, with no build step, and
type stripping is on by default from that version. Node 24 LTS is the tested default.

---

## 2. Windows, step by step

Everything below is a normal user install; no admin shell is needed except where noted.

**1. Node 24 LTS**

```powershell
winget install OpenJS.NodeJS.LTS
```

or download the MSI from <https://nodejs.org/en/download>. Close and reopen the terminal
afterwards (`node -v` must print `v24.x` or newer).

**2. Rust with the MSVC toolchain**

```powershell
winget install --id Rustlang.Rustup -e
```

When rustup asks which toolchain to install, take the default (`1) Quick install via the
Visual Studio prerequisites`). If the Microsoft C++ build tools are not already on the
machine, install them:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

Then open the **Visual Studio Installer** and tick **Desktop development with C++**. Without
that workload the Rust link step fails with `link.exe not found` — the single most common
Windows build failure.

Reopen the terminal and check:

```powershell
rustc --version
cargo --version
```

**3. WebView2**

Windows 11 ships it. On Windows 10, if `npm run doctor` says it is missing, install the
Evergreen runtime: <https://developer.microsoft.com/microsoft-edge/webview2/>.

**4. Clone and run**

```powershell
git clone https://github.com/sebastian-abraham/syscode.git
cd syscode
npm install
npm run setup
npm run dev
```

A window titled **SysCode** opens on the map of `fixtures/demo-app`. The engine is a child
process on `http://127.0.0.1:4317`; the interface is served by Vite on `:5173` during
development.

**Windows notes that save time**

- **Long paths.** Rust builds can exceed the 260-character limit. Either clone somewhere
  short (`C:\dev\syscode`) or enable long paths:
  `git config --system core.longpaths true` plus the LongPathsEnabled policy.
- **Defender.** Real-time scanning makes the first Rust build noticeably slower. Excluding
  the repo folder (or `target/`) is optional, not required.
- **PowerShell blocks npm scripts** with an execution-policy error on some machines:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **`bash` scripts** (`scripts/smoke.sh`, `scripts/stability.sh`) need Git Bash or WSL.
  The app itself does not.

---

## 3. macOS

```bash
xcode-select --install          # compiler + CLT
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
brew install node               # or the pkg from nodejs.org
git clone https://github.com/sebastian-abraham/syscode.git
cd syscode && npm install && npm run setup && npm run dev
```

Nothing else is needed for the webview: macOS ships WKWebView.

---

## 4. Linux

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential curl wget file libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Arch/CachyOS:

```bash
sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 libsoup3 rust
```

Then:

```bash
git clone https://github.com/sebastian-abraham/syscode.git
cd syscode && npm install && npm run setup && npm run dev
```

On Wayland the window uses the native WebKitGTK webview; no XWayland needed.

---

## 5. What `npm run dev` actually does

```
npm run dev
  └─ npm run dev -w @syscode/desktop
       └─ tauri dev
            ├─ beforeDevCommand: Vite on http://localhost:5173
            └─ builds and runs the Rust shell, which
                 ├─ starts the engine: node packages/core/src/cli.ts serve <project> --port 4317
                 ├─ opens a window on http://localhost:5173
                 └─ stops the engine when the window closes
```

- **Which project opens.** `SYSCODE_PROJECT` if set; otherwise, inside a checkout,
  `fixtures/demo-app`; otherwise the last workspace folder. Switch projects from the start
  screen (project name in the header → start screen).
- **Do not run `npx tauri dev`.** `npx` resolves an unrelated npm package called `tauri`,
  and the error message ("could not determine executable to run") does not explain itself.
  The workspace script is the supported path.
- **The engine log** lives in your temp directory as `syscode-engine.log` — useful when the
  window says it is waiting for the engine.

To point it at your own code:

```bash
# macOS / Linux
SYSCODE_PROJECT=~/code/my-app npm run dev
```

```powershell
# Windows PowerShell
$env:SYSCODE_PROJECT="C:\code\my-app"; npm run dev
```

---

## 6. Running without the desktop shell

**Browser UI** (needs two terminals, or one with `&`):

```bash
npm run serve -- fixtures/demo-app      # engine on :4317
npm run dev:web                         # Vite on :5173, proxies /api to the engine
```

**Terminal only**, no UI at all:

```bash
node packages/core/src/cli.ts analyze fixtures/demo-app
node packages/core/src/cli.ts show fixtures/demo-app
node packages/core/src/cli.ts ask fixtures/demo-app "what depends on Persistence?"
```

**Connecting a model** is optional — the map works without one. In the app: start screen →
*Connect a model*, or set an env var:

```bash
SYSCODE_PROVIDER=opencode-go SYSCODE_MODEL=deepseek-v4.1-flash npm run serve -- fixtures/demo-app
```

Supported providers: `opencode-go`, `openai-compatible`, `anthropic`, `ollama` (local, no
key). Keys are read from the environment or `<project>/.syscode/config.json`, never
committed.

---

## 7. Building an installer

```bash
npm run package:desktop
```

That builds the interface, packs the engine into one executable (Node SEA), and asks Tauri
to bundle both. Output:

| OS | Artifact | Where |
|---|---|---|
| Linux | `.deb`, `.AppImage` | `apps/desktop/src-tauri/target/release/bundle/` |
| Windows | `-setup.exe` (NSIS) | `apps/desktop/src-tauri/target/release/bundle/nsis/` |
| macOS | `.dmg`, `.app` | `apps/desktop/src-tauri/target/release/bundle/dmg/` |

**Installers are per-OS**: a Windows installer must be built on Windows. The engine binary
is a copy of *that machine's* Node, so it cannot be cross-built reliably.

A packaged build ignores the repository entirely — the engine and the interface travel
inside the app.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `could not determine executable to run` | You ran `npx tauri dev`. Use `npm run dev`. |
| `resource path ... doesn't exist` during build | Old checkout where `tauri.conf.json` still listed bundle resources. Pull the latest, or run `npm run build:web && npm run build:engine`. |
| `link.exe not found` (Windows) | The MSVC build tools / "Desktop development with C++" workload is missing. |
| `error: linker ... not found` (Linux) | `build-essential` / `base-devel` is missing. |
| `webkit2gtk-4.1 was not found` | Install the webview dev packages (see §4). |
| Window opens on "Waiting for the engine" | Read `%TEMP%\syscode-engine.log` (Windows) or `/tmp/syscode-engine.log`. Usually a port conflict or a first map build still running. |
| First map takes minutes | With a model connected, a project it has not seen is mapped by the model (~1–2 min, ~14 calls). Later opens reuse the stored map. Force the fast deterministic path with `SYSCODE_MAPPER=heuristic`. |
| Port 4317 already in use | Windows: `netstat -ano \| findstr :4317` then `taskkill /PID <pid> /F`. Linux: `fuser -k 4317/tcp`. macOS: `lsof -ti:4317 \| xargs kill`. |
| Blank white window | Vite is not up (check the terminal) or the UI bundle is missing. `npm run dev` uses Vite; if you launched a packaged build, rebuild it. |
| `npm install` skips devDependencies | A global `omit=dev` in npm config. The repo's `.npmrc` sets `include=dev`; for ad-hoc installs pass `npm install --include=dev`. |
| Rust build is very slow the first time | Expected: ~400 crates. Cached afterwards. On Windows, Defender scanning the repo adds to it. |
| Everything compiles but the app opens the wrong folder | Set `SYSCODE_PROJECT` explicitly, or pick a project on the start screen. |

Still stuck? `npm run doctor` prints the versions it can see and names the missing piece;
paste its output and the engine log into an issue.
