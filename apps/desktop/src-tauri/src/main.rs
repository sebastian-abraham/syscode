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

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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

/// How the shell reaches an engine.
enum Engine {
    /// A standalone engine executable (the packaged app ships one).
    Bundled(PathBuf),
    /// A source checkout driven by the system's node.
    NodeScript(PathBuf),
}

/// Walk up from a starting directory looking for a SysCode source checkout.
fn find_repo_root_from(start: &std::path::Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..12 {
        if dir.join("packages/core/src/cli.ts").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn repo_root() -> PathBuf {
    if let Ok(dir) = std::env::var("SYSCODE_REPO") {
        let p = PathBuf::from(dir);
        if p.join("packages/core/src/cli.ts").exists() {
            return p;
        }
    }
    // A source checkout can be found from either the working directory (running from a
    // terminal) or the executable's location (launched from a file manager, where the
    // working directory is the home folder or /). The executable path needs more levels
    // than the old fixed depth allowed: target/release/ sits six below the repo root.
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    for start in starts {
        if let Some(root) = find_repo_root_from(&start) {
            return root;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The project the shell opens when nothing more specific is given.
///
/// A source checkout is preferred (dev mode is unchanged). A packaged app has no
/// checkout, and its process working directory is the read-only install directory
/// (AppRun `chdir`s into the AppImage mount), so pointing the engine there fails when it
/// tries to create `.syscode`. Fall back to a writable, SysCode-owned workspace; the
/// start screen opens a real project from there.
fn default_project() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_repo_root_from(&cwd) {
            return root;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(root) = find_repo_root_from(dir) {
                return root;
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let workspace = PathBuf::from(home).join(".local/share/syscode/workspace");
        if std::fs::create_dir_all(&workspace).is_ok() {
            return workspace;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Locate an engine, in order of who is most likely to be right:
///
/// 1. `SYSCODE_ENGINE` — an explicit override always wins.
/// 2. A source checkout, because a checkout means someone is working on this engine and
///    expects their edits to take effect. `tauri build` leaves the bundled engine next to
///    the binary, so a copy being present says nothing about which one is wanted.
/// 3. The bundled engine beside the executable — the installed app's payload.
fn find_engine() -> Option<Engine> {
    if let Ok(path) = std::env::var("SYSCODE_ENGINE") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(Engine::Bundled(p));
        }
    }

    let script = repo_root().join("packages/core/src/cli.ts");
    if script.exists() {
        return Some(Engine::NodeScript(script));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Packaged layouts: next to the binary, or in a resources folder.
            for rel in ["syscode-engine", "engine/syscode-engine", "../Resources/syscode-engine", "../resources/engine/syscode-engine"] {
                let candidate = dir.join(rel);
                if candidate.exists() {
                    return Some(Engine::Bundled(candidate));
                }
            }
        }
    }

    None
}

/// A source checkout is present, so this is a development run rather than an installed app.
fn checkout_present() -> bool {
    if let Ok(cwd) = std::env::current_dir() {
        if find_repo_root_from(&cwd).is_some() {
            return true;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if find_repo_root_from(dir).is_some() {
                return true;
            }
        }
    }
    false
}

/// Point the shell at the engine and interface Tauri bundled into the app's resource
/// directory, when they are actually there.
///
/// A packaged app keeps its payload under `resource_dir()` (on Linux the AppImage mount
/// or `/usr/lib/<identifier>`), not next to the binary, so the beside-the-executable
/// fallbacks in `find_engine()` cannot see it. Exporting `SYSCODE_ENGINE` here lets the
/// existing override branch pick the bundled engine up, and the engine the shell spawns
/// inherits `SYSCODE_WEB` for the bundled interface. Explicit overrides always win.
///
/// A checkout wins over the bundled copies. `tauri build` leaves the resources next to the
/// binary, so their presence is not proof that this is an installed app — and someone
/// running the release binary from the repository is editing that source, not the engine
/// frozen into a previous bundle.
fn configure_bundled_resources(app: &tauri::AppHandle) {
    if checkout_present() {
        return;
    }
    let dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let engine = dir.join("engine").join("syscode-engine");
    if engine.exists() && std::env::var_os("SYSCODE_ENGINE").is_none() {
        std::env::set_var("SYSCODE_ENGINE", &engine);
    }
    let web = dir.join("web");
    if web.join("index.html").exists() && std::env::var_os("SYSCODE_WEB").is_none() {
        std::env::set_var("SYSCODE_WEB", &web);
    }
}

fn spawn_engine(project: &str, port: u16) -> Result<(String, Option<Child>), String> {
    if port_open(port) {
        return Ok((format!("engine already listening on {port}"), None));
    }
    let engine = find_engine().ok_or_else(|| {
        "no SysCode engine found. Set SYSCODE_ENGINE to a standalone engine, SYSCODE_REPO to a \
         checkout, or start one with `npm run serve`."
            .to_string()
    })?;

    let log = std::env::temp_dir().join("syscode-engine.log");
    let out = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    let mut command = match &engine {
        Engine::Bundled(path) => {
            let mut c = Command::new(path);
            c.arg("serve")
                .arg(project)
                .arg("--port")
                .arg(port.to_string());
            c
        }
        Engine::NodeScript(script) => {
            let mut c = Command::new("node");
            c.arg(script)
                .arg("serve")
                .arg(project)
                .arg("--port")
                .arg(port.to_string());
            c
        }
    };

    // The engine must not outlive the app: an abrupt kill (crash, SIGKILL, a terminal
    // Ctrl-C) never reaches the exit handler that takes the child down, and the leftover
    // engine keeps holding the port. PR_SET_PDEATHSIG ties it to this process.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let child = command
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if port_open(port) {
            let how = match &engine {
                Engine::Bundled(_) => "bundled engine",
                Engine::NodeScript(_) => "engine from the source checkout",
            };
            return Ok((format!("started the {how} on {port}"), Some(child)));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "the engine did not come up on {port}; see {}",
        log.display()
    ))
}

#[tauri::command]
fn engine_status(port: Option<u16>) -> serde_json::Value {
    let p = port.unwrap_or(DEFAULT_PORT);
    let engine = find_engine();
    let (kind, path) = match &engine {
        Some(Engine::Bundled(path)) => ("bundled", Some(path.display().to_string())),
        Some(Engine::NodeScript(path)) => ("node", Some(path.display().to_string())),
        None => ("none", None),
    };
    serde_json::json!({
        "running": port_open(p),
        "url": format!("http://127.0.0.1:{p}"),
        "repo": repo_root().display().to_string(),
        "engineKind": kind,
        "enginePath": path,
    })
}

/// Start the engine on demand — the interface calls this from its waiting state, so a
/// failed start is something the developer can retry and read the reason for, instead of
/// a window pointed at a port nobody is listening on.
///
/// `project` may be omitted: the shell falls back to the project it was launched for.
#[tauri::command]
async fn start_engine(
    state: tauri::State<'_, EngineProcess>,
    project: Option<String>,
    port: Option<u16>,
) -> Result<String, String> {
    let p = port.unwrap_or(DEFAULT_PORT);
    let target = project
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("SYSCODE_PROJECT").ok())
        .unwrap_or_else(|| default_project().display().to_string());
    let (message, child) = spawn_engine(&target, p)?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut previous) = guard.take() {
        let _ = previous.kill();
    }
    *guard = child;
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

/// Native folder picker for the start screen ("Open a folder").
///
/// Runs as an async command on purpose: Tauri executes these off the main thread,
/// which is what makes the blocking dialog safe to call. Returns `None` when the
/// developer cancels, so the interface can leave the field alone rather than
/// clearing it.
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.display().to_string())
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
        // gsize, not u32: it is size_t (64-bit here). Reading only the low half of the
        // return value happens to work for small lists, which is exactly the kind of thing
        // that stops working on a bigger list.
        fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
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
                let feature = webkit_feature_list_get(list, index as u32);
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

/// Injected into the page by the harness: after load + a short warm-up, sample
/// `requestAnimationFrame` deltas for a few seconds and report the distribution.
///
/// An average frame rate hides stutter: a page can tick at 120fps and still drop a 50ms
/// frame every second, which is what a person actually notices. So report the spread —
/// median, p95, worst, and how many frames missed the display's own interval.
fn probe_script(port: u16) -> String {
    format!(
        r#"(function(){{
  if (location.protocol === 'about:') return; // initial blank document; wait for the real page
  if (window.__SYSCODE_FPS_PROBE__) return;
  window.__SYSCODE_FPS_PROBE__ = true;
  var PORT = {port};
  var WARMUP_MS = 500, MEASURE_MS = 4000;
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
  // Synthetic interaction: selection repaints the scaled layer, which is the case the
  // owner reports as stuttery.
  function interact() {{
    try {{
      var nodes = document.querySelectorAll('.react-flow__node');
      if (!nodes.length) return false;
      var n = nodes[Math.floor(Math.random() * nodes.length)];
      var r = n.getBoundingClientRect();
      var b = {{ bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 }};
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {{
        n.dispatchEvent(t.indexOf('pointer') === 0
          ? new PointerEvent(t, {{ bubbles: b.bubbles, cancelable: b.cancelable, clientX: b.clientX, clientY: b.clientY, pointerId: 1, isPrimary: true, pointerType: 'mouse' }})
          : new MouseEvent(t, b));
      }});
      return true;
    }} catch (e) {{ return false; }}
  }}
  // The interface opens on its project picker, so the map is not on screen yet. Open the
  // first project before measuring, or the numbers describe the picker instead of the canvas.
  function openProject(then) {{
    if (document.querySelector('.react-flow__node')) return then();
    // The picker lists the current project (with its own Open button) and then recents, and
    // a recent can be an empty folder. Try each until one actually renders a map, or the
    // measurement describes an empty canvas.
    var list = [].slice.call(document.querySelectorAll('button')).filter(function(b) {{
      return (b.textContent || '').trim() === 'Open';
    }});
    list = list.concat([].slice.call(document.querySelectorAll('.recent__body--button')));
    list = list.concat([].slice.call(document.querySelectorAll('[class*="recent"] button')));
    if (!list.length) return then();
    var i = 0;
    function tryNext() {{
      if (i >= list.length) return then();
      var el = list[i++];
      try {{ el.click(); }} catch (e) {{}}
      var waited = 0;
      var iv = setInterval(function() {{
        waited += 250;
        if (document.querySelector('.react-flow__node')) {{ clearInterval(iv); return then(); }}
        if (waited > 6000) {{ clearInterval(iv); tryNext(); }}
      }}, 250);
    }}
    tryNext();
  }}
  function measure() {{
    var start = performance.now(), frames = 0, last = start, deltas = [];
    var interacted = 0;
    var withInput = location.search.indexOf('interact') !== -1 || window.__SYSCODE_FPS_INTERACT__;
    function tick() {{
      var now = performance.now();
      deltas.push(now - last);
      last = now;
      frames++;
      if (withInput && frames % 30 === 0 && interact()) interacted++;
      if (now - start >= MEASURE_MS) {{
        var ms = now - start;
        var sorted = deltas.slice(1).sort(function(a, b) {{ return a - b; }});
        var at = function(q) {{ return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 100) / 100 : null; }};
        var over = function(ms) {{ return sorted.filter(function(d) {{ return d > ms; }}).length; }};
        report({{
          fps: Math.round((frames * 1000 / ms) * 100) / 100,
          frames: frames,
          ms: Math.round(ms * 100) / 100,
          median: at(0.5),
          p95: at(0.95),
          worst: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : null,
          missed120: over(9.5),
          missed60: over(18),
          long: over(33),
          interacted: interacted,
          nodes: document.querySelectorAll('.react-flow__node').length,
          // How many node cards fall outside the canvas box. The window is handed its real
          // size after the first paint, so a map fitted to the earlier size ends up clipped;
          // this is the number that says whether the re-fit is doing its job.
          outside: (function() {{
            var pane = document.querySelector('.react-flow');
            if (!pane) return null;
            var pr = pane.getBoundingClientRect();
            var n = 0;
            document.querySelectorAll('.react-flow__node').forEach(function(el) {{
              var r = el.getBoundingClientRect();
              if (r.right > pr.right + 2 || r.left < pr.left - 2 || r.bottom > pr.bottom + 2 || r.top < pr.top - 2) n++;
            }});
            return n;
          }})(),
          viewport: (function() {{
            var vp = document.querySelector('.react-flow__viewport');
            return vp ? getComputedStyle(vp).transform : null;
          }})(),
          canvas: (function() {{
            var pane = document.querySelector('.react-flow');
            if (!pane) return null;
            var r = pane.getBoundingClientRect();
            return Math.round(r.width) + 'x' + Math.round(r.height);
          }})(),
          href: location.href
        }});
        return;
      }}
      requestAnimationFrame(tick);
    }}
    requestAnimationFrame(tick);
  }}
  function begin() {{ setTimeout(function() {{
    openProject(function() {{
      // Hold mode: set the view up (optionally zoomed in) and leave the window alone, so a
      // screenshot can be taken of the real renderer instead of a guess about it.
      if (window.__SYSCODE_FPS_HOLD__) {{
        var zi = document.querySelector('.react-flow__controls-zoomin');
        var zo = document.querySelector('.react-flow__controls-zoomout');
        var n = window.__SYSCODE_FPS_ZOOM__ || 0;
        if (n === -2) {{
          // Wheel zoom, not the +/- buttons: React Flow takes a different path for it, and
          // it is what a person actually does.
          var pane = document.querySelector('.react-flow__pane') || document.querySelector('.react-flow');
          if (!pane) return;
          var r = pane.getBoundingClientRect();
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var dir = -1;
          setInterval(function() {{
            pane.dispatchEvent(new WheelEvent('wheel', {{
              bubbles: true, cancelable: true, clientX: cx, clientY: cy,
              deltaY: dir * 120, deltaMode: 0
            }}));
            dir = -dir;
          }}, 700);
          return;
        }}
        if (n < 0) {{
          // Keep zooming in and out forever: a settled screenshot cannot show a raster
          // that is only stale between two interactions.
          var up = true;
          setInterval(function() {{
            var b = up ? zi : zo;
            if (b) b.click();
            up = !up;
          }}, 700);
          return;
        }}
        for (var i = 0; i < n && zi; i++) zi.click();
        return;
      }}
      measure();
    }});
  }}, WARMUP_MS); }}
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
        std::env::var("SYSCODE_PROJECT").unwrap_or_else(|_| default_project().display().to_string());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            engine_status,
            start_engine,
            stop_engine,
            pick_directory
        ])
        .setup(move |app| {
            // Make the bundled engine + interface discoverable before the first spawn.
            configure_bundled_resources(app.handle());
            let spawn_result = spawn_engine(&project, port);
            match spawn_result {
                Ok((msg, child)) => {
                    println!("[syscode] {msg}");
                    // Hold the child so closing the window takes the engine down with it
                    // instead of leaving a process holding the port.
                    if let Some(state) = app.try_state::<EngineProcess>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = child;
                        }
                    }
                }
                Err(err) => eprintln!("[syscode] engine unavailable: {err}"),
            }
            let init = format!(
                "window.__SYSCODE_API_BASE__ = 'http://127.0.0.1:{port}'; window.__SYSCODE_DESKTOP__ = true; window.__SYSCODE_FPS_INTERACT__ = {}; window.__SYSCODE_FPS_HOLD__ = {}; window.__SYSCODE_FPS_ZOOM__ = {};",
                std::env::var("SYSCODE_FPS_INTERACT").is_ok(),
                std::env::var("SYSCODE_FPS_HOLD").is_ok(),
                std::env::var("SYSCODE_FPS_ZOOM").ok().and_then(|v| v.parse::<i32>().ok()).unwrap_or(0)
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
        .build(tauri::generate_context!())
        .expect("error while building the SysCode desktop shell");

    // Take the engine down with the window rather than leaving a process holding the port.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<EngineProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
