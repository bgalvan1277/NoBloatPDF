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

// async: creating a webview window inside a synchronous command deadlocks
// the webview initialization on Windows (wry re-entrancy) — the shell
// appears but stays blank and unresponsive.
#[tauri::command]
async fn show_about(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("about") {
        let _ = win.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        "about",
        tauri::WebviewUrl::App("about.html".into()),
    )
    .title("About No Bloat PDF")
    .inner_size(500.0, 720.0)
    .resizable(false)
    .build();
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
        .invoke_handler(tauri::generate_handler![pending_files, show_about])
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
