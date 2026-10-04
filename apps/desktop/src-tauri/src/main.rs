// SysCode desktop shell.
//
// The engine and the interface are deliberately separate (see docs/CONTRACT.md):
// this shell starts the local engine if it is not already listening, points the
// webview at it, and gets out of the way. If no engine can be started it says so
// instead of pretending — the window still opens and shows the retry state.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 4317;

struct EngineProcess(Mutex<Option<Child>>);

fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    match addr.parse() {
        Ok(sock) => TcpStream::connect_timeout(&sock, Duration::from_millis(400)).is_ok(),
        Err(_) => false,
    }
}

fn repo_root() -> PathBuf {
    if let Ok(dir) = std::env::var("SYSCODE_REPO") {
        return PathBuf::from(dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("packages/core/src/cli.ts").exists() {
            return cwd;
        }
    }
    // apps/desktop/src-tauri → repo root
    let mut dir = std::env::current_exe().unwrap_or_default();
    for _ in 0..5 {
        dir.pop();
        if dir.join("packages/core/src/cli.ts").exists() {
            return dir;
        }
    }
    PathBuf::from(".")
}

fn engine_script() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SYSCODE_ENGINE") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    let candidate = repo_root().join("packages/core/src/cli.ts");
    candidate.exists().then_some(candidate)
}

fn spawn_engine(project: &str, port: u16) -> Result<String, String> {
    if port_open(port) {
        return Ok(format!("engine already listening on {port}"));
    }
    let script = engine_script().ok_or_else(|| {
        "could not find the SysCode engine (packages/core/src/cli.ts). Set SYSCODE_ENGINE or SYSCODE_REPO, or start it yourself with `npm run serve`.".to_string()
    })?;
    let log = std::env::temp_dir().join("syscode-engine.log");
    let out = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    Command::new("node")
        .arg(&script)
        .arg("serve")
        .arg(project)
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("could not start node: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if port_open(port) {
            return Ok(format!("engine started on {port}"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "engine did not come up on {port}; see {}",
        log.display()
    ))
}

#[tauri::command]
fn engine_status(port: Option<u16>) -> serde_json::Value {
    let p = port.unwrap_or(DEFAULT_PORT);
    serde_json::json!({
        "running": port_open(p),
        "url": format!("http://127.0.0.1:{p}"),
        "repo": repo_root().display().to_string(),
        "engineScript": engine_script().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
fn start_engine(
    state: tauri::State<'_, EngineProcess>,
    project: String,
    port: Option<u16>,
) -> Result<String, String> {
    let p = port.unwrap_or(DEFAULT_PORT);
    let message = spawn_engine(&project, p)?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // the child is detached on purpose: it outlives a window reload
    Ok(message)
}

#[tauri::command]
fn stop_engine(state: tauri::State<'_, EngineProcess>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        return Ok("engine stopped".into());
    }
    Ok("no engine started by this window".into())
}

fn main() {
    let port: u16 = std::env::var("SYSCODE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let project =
        std::env::var("SYSCODE_PROJECT").unwrap_or_else(|_| repo_root().display().to_string());

    tauri::Builder::default()
        .manage(EngineProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![engine_status, start_engine, stop_engine])
        .setup(move |app| {
            let spawn_result = spawn_engine(&project, port);
            match &spawn_result {
                Ok(msg) => println!("[syscode] {msg}"),
                Err(err) => eprintln!("[syscode] engine unavailable: {err}"),
            }
            let init = format!(
                "window.__SYSCODE_API_BASE__ = 'http://127.0.0.1:{port}'; window.__SYSCODE_DESKTOP__ = true;",
            );

            // If the engine is up, load the interface *from* it: same origin, so the API
            // calls need no CORS, and the window always matches the running engine rather
            // than whatever was baked into this binary. Otherwise fall back to the
            // embedded build, which shows its own "waiting for the engine" state.
            let url = if port_open(port) {
                match format!("http://127.0.0.1:{port}").parse() {
                    Ok(parsed) => WebviewUrl::External(parsed),
                    Err(_) => WebviewUrl::App("index.html".into()),
                }
            } else {
                WebviewUrl::App("index.html".into())
            };

            let window = WebviewWindowBuilder::new(app, "main", url)
                .title("SysCode")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1080.0, 680.0)
                .theme(Some(tauri::Theme::Dark))
                .initialization_script(&init)
                .build()?;
            let _ = window.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the SysCode desktop shell");
}
