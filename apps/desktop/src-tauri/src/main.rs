// SysCode desktop shell.
//
// The engine and the interface are deliberately separate (see docs/CONTRACT.md):
// this shell starts the local engine if it is not already listening, points the
// webview at it, and gets out of the way. If no engine can be started it says so
// instead of pretending — the window still opens and shows the retry state.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 4317;
/// Where the `SYSCODE_FPS_PROBE` harness writes its measurement.
const FPS_PROBE_FILE: &str = "/tmp/syscode-fps.json";

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

/// Unlock high-refresh rendering.
///
/// WebKitGTK keeps an internal feature named `PreferPageRenderingUpdatesNear60FPS`
/// (identifier `PreferPageRenderingUpdatesNear60FPS`, status STABLE, **default
/// enabled**) that clamps page rendering updates to roughly 60fps regardless of
/// the display refresh rate. It is the same knob the macOS
/// `tauri-plugin-macos-fps` flips to unlock ProMotion; on GTK it is still on, so
/// a 120Hz panel gets ~60fps. WebKitGTK 2.42+ exposes features through
/// `webkit_settings_get_all_features()` / `webkit_settings_set_feature_enabled()`,
/// which the `webkit2gtk` Rust crate (2.0.x) does not bind yet, so we call the C
/// API directly. The symbols live in the `webkit2gtk-4.1` library the crate
/// already links.
#[cfg(target_os = "linux")]
mod fps {
    use std::ffi::c_void;
    use webkit2gtk::glib::translate::ToGlibPtr;
    use webkit2gtk::WebViewExt;

    #[link(name = "webkit2gtk-4.1")]
    extern "C" {
        fn webkit_settings_get_all_features() -> *mut c_void;
        fn webkit_feature_list_get_length(list: *mut c_void) -> u32;
        fn webkit_feature_list_get(list: *mut c_void, index: u32) -> *mut c_void;
        fn webkit_feature_get_identifier(feature: *mut c_void) -> *const std::os::raw::c_char;
        fn webkit_settings_set_feature_enabled(
            settings: *mut c_void,
            feature: *mut c_void,
            enabled: i32,
        );
        fn webkit_feature_list_unref(list: *mut c_void);
    }

    /// Disable `PreferPageRenderingUpdatesNear60FPS` on the live WebView settings.
    /// Returns `true` if the feature was found and switched off.
    pub fn disable_60fps_cap(webview: &webkit2gtk::WebView) -> bool {
        let settings = match webview.settings() {
            Some(s) => s,
            None => return false,
        };
        let raw_settings: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
        let raw_settings = raw_settings as *mut c_void;
        let mut disabled = false;
        unsafe {
            let list = webkit_settings_get_all_features();
            if list.is_null() {
                return false;
            }
            let count = webkit_feature_list_get_length(list);
            for index in 0..count {
                let feature = webkit_feature_list_get(list, index);
                if feature.is_null() {
                    continue;
                }
                let identifier = webkit_feature_get_identifier(feature);
                if identifier.is_null() {
                    continue;
                }
                if std::ffi::CStr::from_ptr(identifier).to_string_lossy()
                    == "PreferPageRenderingUpdatesNear60FPS"
                {
                    webkit_settings_set_feature_enabled(raw_settings, feature, 0);
                    disabled = true;
                    break;
                }
            }
            webkit_feature_list_unref(list);
        }
        disabled
    }
}

/// First index of `needle` in `haystack` (used to find the HTTP header terminator).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Parse `Content-Length` from a raw HTTP header block.
fn header_content_length(headers: &[u8]) -> usize {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            return rest.trim().parse().unwrap_or(0);
        }
    }
    0
}

/// One-shot HTTP listener used only by the FPS harness. The injected page script
/// POSTs its measured result here (a cross-origin `no-cors` POST is a CORS-simple
/// request, so it is delivered without a preflight), we persist it to
/// `FPS_PROBE_FILE` and print it, then exit so an automated run terminates.
fn start_probe_listener(app: tauri::AppHandle) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fps probe listener");
    let port = listener.local_addr().expect("fps probe addr").port();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(pair) => pair,
                Err(_) => break,
            };
            let mut buf: Vec<u8> = Vec::new();
            let mut header_end: Option<usize> = None;
            let mut content_length: usize = 0;
            loop {
                let mut chunk = [0u8; 4096];
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        buf.extend_from_slice(&chunk[..read]);
                        if header_end.is_none() {
                            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                                header_end = Some(pos + 4);
                                content_length = header_content_length(&buf[..pos + 4]);
                            }
                        }
                        if let Some(end) = header_end {
                            if buf.len() >= end + content_length {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let request = String::from_utf8_lossy(&buf).to_string();
            let body = match header_end {
                Some(end) => {
                    let stop = (end + content_length).min(buf.len());
                    String::from_utf8_lossy(&buf[end..stop]).trim().to_string()
                }
                None => String::new(),
            };
            let request_line = request.lines().next().unwrap_or("").to_string();
            println!(
                "[syscode][fps] probe connection: {} bytes, {} bytes body ({request_line:?})",
                buf.len(),
                body.len()
            );
            let _ = stream.write_all(
                b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.flush();
            if !body.is_empty() {
                if body.contains("\"href\":\"about") {
                    println!("[syscode][fps] ignoring blank-document report: {body}");
                    continue;
                }
                let _ = std::fs::write(FPS_PROBE_FILE, &body);
                println!("[syscode][fps] {body}");
                println!("[syscode][fps] wrote {FPS_PROBE_FILE}");
                std::thread::sleep(Duration::from_millis(200));
                // Quit through the event loop (main thread) rather than std::process::exit
                // from this thread, so GTK/WebKit tear down cleanly.
                app.exit(0);
            }
        }
        eprintln!("[syscode][fps] probe listener timed out with no report");
    });
    port
}

/// Injected into the page by the harness: after load + a short warm-up, count
/// `requestAnimationFrame` callbacks for ~3s and report the rate to the listener.
fn probe_script(port: u16) -> String {
    format!(
        r#"(function(){{
  if (location.protocol === 'about:') return; // initial blank document; wait for the real page
  if (window.__SYSCODE_FPS_PROBE__) return;
  window.__SYSCODE_FPS_PROBE__ = true;
  var PORT = {port};
  var WARMUP_MS = 500, MEASURE_MS = 3000;
  function report(payload) {{
    try {{
      fetch('http://127.0.0.1:' + PORT + '/fps', {{
        method: 'POST',
        mode: 'no-cors',
        headers: {{ 'Content-Type': 'text/plain' }},
        body: JSON.stringify(payload)
      }}).catch(function(){{}});
    }} catch (e) {{}}
  }}
  function measure() {{
    var start = performance.now(), frames = 0;
    function tick() {{
      frames++;
      var now = performance.now();
      if (now - start >= MEASURE_MS) {{
        var ms = now - start;
        report({{
          fps: Math.round((frames * 1000 / ms) * 100) / 100,
          frames: frames,
          ms: Math.round(ms * 100) / 100,
          href: location.href
        }});
        return;
      }}
      requestAnimationFrame(tick);
    }}
    requestAnimationFrame(tick);
  }}
  function begin() {{ setTimeout(measure, WARMUP_MS); }}
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin, {{ once: true }});
}})();"#
    )
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

            // Applied as early as the webview exists, so it governs the first paint.
            // Set SYSCODE_FPS_FIX=0 to measure the un-patched (60fps-capped) behaviour.
            let fix_enabled = std::env::var("SYSCODE_FPS_FIX")
                .map(|v| v != "0")
                .unwrap_or(true);
            if fix_enabled {
                let _ = window.with_webview(|webview| {
                    #[cfg(target_os = "linux")]
                    {
                        let disabled = fps::disable_60fps_cap(&webview.inner());
                        println!(
                            "[syscode][fps] PreferPageRenderingUpdatesNear60FPS disabled = {disabled}"
                        );
                    }
                    #[cfg(not(target_os = "linux"))]
                    let _ = &webview;
                });
            }

            let _ = window.set_focus();

            // Objective FPS harness: inert unless SYSCODE_FPS_PROBE is set.
            if std::env::var("SYSCODE_FPS_PROBE").is_ok() {
                let probe_port = start_probe_listener(app.handle().clone());
                // Keep the window mapped, on screen and focused so WebKit does not
                // throttle rendering because it believes the window is hidden.
                let _ = window.set_always_on_top(true);
                let _ = window.show();
                let _ = window.set_focus();
                println!("[syscode][fps] probe armed on 127.0.0.1:{probe_port}");
                let probe_window = window.clone();
                std::thread::spawn(move || {
                    // Re-inject until the real interface (the engine URL) is the live
                    // document and the probe reports; the in-page guard makes repeats
                    // harmless. The listener exits the process on success.
                    let deadline = Instant::now() + Duration::from_secs(40);
                    let mut announced = false;
                    while Instant::now() < deadline {
                        let url = probe_window.url().map(|u| u.to_string()).unwrap_or_default();
                        if url.contains("127.0.0.1") {
                            if !announced {
                                println!("[syscode][fps] evaluating probe (url={url:?})");
                                announced = true;
                            }
                            let _ = probe_window.eval(&probe_script(probe_port));
                        }
                        std::thread::sleep(Duration::from_millis(1200));
                    }
                    eprintln!("[syscode][fps] probe window loop ended without a report");
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the SysCode desktop shell");
}
