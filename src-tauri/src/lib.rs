use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// PDF paths received before the frontend was ready (cold-start argv on
/// Windows/Linux, RunEvent::Opened on macOS). Drained once by `pending_files`.
struct PendingFiles(Mutex<Vec<String>>);

/// Output path of a cold-start `--combine <out.pdf> <files…>` request. The
/// files themselves travel through `PendingFiles`; the frontend asks for this
/// first and, when it is set, sends them to Combine Files instead of opening
/// them as tabs. Drained once by `combine_request`.
struct CombineRequest(Mutex<Option<String>>);

/// Splits a raw argument list into file paths and, when `--combine <out>` is
/// present, the PDF those files should be combined into (parsed here so the
/// output path is never mistaken for a file to open). Skips the binary name
/// and any other `-`-prefixed flag; the OS may hand us plain paths or
/// `file://` URLs.
fn parse_args<I>(args: I) -> (Vec<String>, Option<String>)
where
    I: IntoIterator<Item = String>,
{
    let mut paths = Vec::new();
    let mut combine = None;
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--combine" {
            combine = args.next();
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        paths.push(match tauri::Url::parse(&arg) {
            // Windows paths like C:\x.pdf parse as scheme "c" — only
            // treat genuine file:// URLs as URLs.
            Ok(url) if url.scheme() == "file" => url
                .to_file_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(arg),
            _ => arg,
        });
    }
    (paths, combine)
}

#[tauri::command]
fn pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

#[tauri::command]
fn combine_request(state: tauri::State<CombineRequest>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Writes the saved PDF bytes to disk. The bytes arrive as the raw invoke
/// body (no JSON serialization of megabytes of data); the destination path
/// arrives percent-encoded in a header because invoke headers are ASCII-only.
/// The write is atomic: a sibling temp file is written first, then renamed
/// over the target, so a crash mid-write can never leave a corrupt PDF.
#[tauri::command]
fn save_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-save-path")
        .ok_or("missing x-save-path header")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected binary body".into());
    };
    let target = std::path::Path::new(&path);
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(".nb-saving");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (cold_paths, cold_combine) = parse_args(std::env::args());
    tauri::Builder::default()
        // Must be the first plugin registered (documented requirement).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let (paths, combine) = parse_args(argv.into_iter());
            if let Some(out) = combine {
                let _ = app.emit("combine-files", serde_json::json!({ "out": out, "paths": paths }));
            } else if !paths.is_empty() {
                app.state::<PendingFiles>().0.lock().unwrap().extend(paths.clone());
                let _ = app.emit("open-file", paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The main window is declared in tauri.conf.json with `create: false`
        // so it can be built here with a navigation guard. PDFs carry links to
        // arbitrary websites; the frontend opens those in the system browser,
        // and this guard is the backstop that keeps the webview itself on the
        // app's own origin no matter what gets clicked. Navigating away would
        // replace the viewer (and destroy every open tab and the app's own JS)
        // with the linked website.
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .expect("main window config missing from tauri.conf.json")
                .clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_navigation(|url| {
                    // tauri://localhost on macOS/Linux, http://tauri.localhost
                    // on Windows. `tauri dev` serves the frontend from a local
                    // HTTP server instead, which only debug builds may load.
                    url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                        || (cfg!(debug_assertions)
                            && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))
                })
                .build()?;
            Ok(())
        })
        .manage(PendingFiles(Mutex::new(cold_paths)))
        .manage(CombineRequest(Mutex::new(cold_combine)))
        .invoke_handler(tauri::generate_handler![pending_files, save_pdf, combine_request])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers opened files as an event, not argv; it can fire
            // before the frontend is ready, hence the buffer + emit pair.
            // The Opened variant does not exist on Windows/Linux builds.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    _app.state::<PendingFiles>().0.lock().unwrap().extend(paths.clone());
                    let _ = _app.emit("open-file", paths);
                }
            }
        });
}
