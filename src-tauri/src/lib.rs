use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// PDF paths received before the frontend was ready (cold-start argv on
/// Windows/Linux, RunEvent::Opened on macOS). Drained once by `pending_files`.
struct PendingFiles(Mutex<Vec<String>>);

/// Extract file paths from a raw argument list. Skips the binary name and
/// `-`-prefixed flags; the OS may hand us plain paths or `file://` URLs.
fn paths_from_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| {
            match tauri::Url::parse(&arg) {
                // Windows paths like C:\x.pdf parse as scheme "c" — only
                // treat genuine file:// URLs as URLs.
                Ok(url) if url.scheme() == "file" => url
                    .to_file_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or(arg),
                _ => arg,
            }
        })
        .collect()
}

#[tauri::command]
fn pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
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
    tauri::Builder::default()
        // Must be the first plugin registered (documented requirement).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let paths = paths_from_args(argv.into_iter());
            if !paths.is_empty() {
                app.state::<PendingFiles>().0.lock().unwrap().extend(paths.clone());
                let _ = app.emit("open-file", paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFiles(Mutex::new(paths_from_args(std::env::args()))))
        .invoke_handler(tauri::generate_handler![pending_files, save_pdf])
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
