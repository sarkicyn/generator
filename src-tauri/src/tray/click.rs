use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Toggle the app as a whole, restoring the meeting window when one is active.
pub fn handle_single_click(app: &AppHandle) {
    let shown = ["launcher", "overlay"].iter().any(|label| {
        app.get_webview_window(label).map(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
        }).unwrap_or(false)
    });
    if shown {
        crate::hide_all(app);
    } else {
        crate::show_for_second_launch(app);
    }
}

/// Middle-click: toggle mic mute during meeting. No-op when idle.
pub fn handle_middle_click(app: &AppHandle) {
    let state = app.state::<AppState>();
    let tray_mgr = state.tray_manager.clone();

    let mgr = tray_mgr.lock().unwrap();
    if let Some(ref manager) = *mgr {
        if manager.meeting_active {
            let _ = app.emit("tray_toggle_mic", ());
        }
    }
}
