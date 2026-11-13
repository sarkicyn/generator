use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde::Serialize;
use tauri::{command, AppHandle, Emitter, Manager, Runtime, Window};
use tauri_plugin_store::StoreExt;

use crate::state::AppState;

/// Stealth mode ("Hide from screen share"): every NexQ window stays visible on
/// the user's own display but is left out of screen sharing, recordings and
/// screenshots.
///
/// - Windows: `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`
///   (Windows 10 version 2004 and later).
/// - macOS: `NSWindow.sharingType = NSWindowSharingNone`. Apps that capture
///   through ScreenCaptureKit on macOS 14+ may still see the window.
static STEALTH: AtomicBool = AtomicBool::new(false);
static NATIVE_DIALOGS: AtomicUsize = AtomicUsize::new(0);

/// Whether stealth mode is on (read when windows are created and menus built).
pub fn stealth_enabled() -> bool {
    STEALTH.load(Ordering::SeqCst)
}

/// What this platform offers, for the Settings note.
#[derive(Debug, Clone, Serialize)]
pub struct StealthSupport {
    pub supported: bool,
    pub enabled: bool,
    /// Caveat to show next to the toggle, if any.
    pub note: Option<String>,
}

fn support() -> StealthSupport {
    if cfg!(target_os = "windows") {
        StealthSupport {
            supported: true,
            enabled: stealth_enabled(),
            note: Some("Windows 10 версии 2004 и новее. Защита действует в программах, которые учитывают исключение окон из захвата. Проверьте изображение у зрителя перед демонстрацией.".to_string()),
        }
    } else if cfg!(target_os = "macos") {
        StealthSupport {
            supported: true,
            enabled: stealth_enabled(),
            note: Some(
                "Некоторые программы записи в macOS 14 и новее могут захватывать защищённые окна."
                    .to_string(),
            ),
        }
    } else {
        StealthSupport {
            supported: false,
            enabled: stealth_enabled(),
            note: Some("На этой платформе защита от захвата недоступна.".to_string()),
        }
    }
}

#[command]
pub fn get_stealth_support() -> StealthSupport {
    support()
}

/// Turn stealth mode on or off for every NexQ window (and for windows opened
/// later, see [`apply_to_new_window`]). All or nothing: if a window refuses,
/// the windows already changed are put back and the setting stays as it was.
/// Rebuilds the tray menu so its check mark follows.
#[command]
pub async fn set_stealth_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && !support().supported {
        return Err("Hiding from screen share isn't available on this platform".to_string());
    }
    // Window queries and native visibility callbacks run on the UI thread.
    // Do not hold a mutex while dispatching to it: a page-load callback could
    // otherwise wait for that mutex while the command waits for the UI thread.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let windows: Vec<(String, Window)> = main_app
            .webview_windows()
            .into_iter()
            .map(|(label, w)| (label, w.as_ref().window()))
            .collect();
        let previous = stealth_enabled();
        let result = (|| {
            if enabled && NATIVE_DIALOGS.load(Ordering::SeqCst) > 0 {
                return Err("Сначала закройте системное диалоговое окно, затем включите режим приватности".into());
            }
            for (_, window) in &windows { track_visibility(window)?; }
            transition(&windows, previous, enabled, apply_setting)?;
            // Persist natively too: tray changes and a quick exit must not
            // depend on a webview receiving an event and autosaving later.
            let saved = main_app.store(FRONTEND_STORE).map_err(|e| e.to_string()).and_then(|store| {
                store.set("stealthMode", serde_json::json!(enabled));
                store.save().map_err(|e| {
                    store.set("stealthMode", serde_json::json!(previous));
                    e.to_string()
                })
            });
            if let Err(error) = saved {
                let _ = transition(&windows, enabled, previous, apply_setting);
                return Err(format!("Не удалось сохранить режим приватности: {error}"));
            }
            Ok(())
        })();
        if result.is_ok() {
            STEALTH.store(enabled, Ordering::SeqCst);
            log::info!(
                "Stealth mode {}",
                if enabled { "on: windows hidden from screen capture" } else { "off" }
            );
        }
        let _ = sender.send(result);
    })
    .map_err(|e| format!("Couldn't schedule screen-share visibility change: {e}"))?;
    let result = receiver
        .await
        .map_err(|_| "Screen-share visibility change was interrupted".to_string())?;
    if result.is_ok() { let _ = app.emit("stealth_mode_changed", enabled); }
    if result.is_ok() {
        if let Some(tray) = app.tray_by_id("main") { let _ = tray.set_visible(!enabled); }
    }

    let meeting_active = app.state::<AppState>().meeting_active.load(Ordering::SeqCst);
    if let Err(e) = crate::commands::tray_commands::rebuild_tray_menu(app.clone(), meeting_active).await {
        log::warn!("Failed to refresh the tray menu after a stealth change: {e}");
    }
    result
}

/// Apply `enabled` to every window; on the first failure, restore `previous`
/// on the windows already changed. The error says whether that worked.
fn transition<W>(
    windows: &[(String, W)],
    previous: bool,
    enabled: bool,
    apply: impl Fn(&W, bool) -> Result<(), String>,
) -> Result<(), String> {
    for (i, (label, window)) in windows.iter().enumerate() {
        if let Err(e) = apply(window, enabled) {
            let not_restored: Vec<&str> = windows[..=i]
                .iter()
                .filter(|(_, w)| apply(w, previous).is_err())
                .map(|(l, _)| l.as_str())
                .collect();
            let state = if previous { "hidden from" } else { "visible in" };
            return Err(if not_restored.is_empty() {
                format!("Couldn't change screen-share visibility ({label}: {e}); NexQ is still {state} screen share")
            } else {
                format!(
                    "Couldn't change screen-share visibility ({label}: {e}), and these windows couldn't be put back: {}. Toggle it again or restart NexQ",
                    not_restored.join(", ")
                )
            });
        }
    }
    Ok(())
}

/// Apply the current stealth setting to a window that was just created
/// (e.g. the dev log window), so it is never captured before it is hidden.
pub fn apply_to_new_window<R: Runtime>(window: &Window<R>) {
    let target = window.clone();
    if let Err(e) = window.run_on_main_thread(move || {
        if let Err(e) = track_visibility(&target).and_then(|_| apply_setting(&target, stealth_enabled())) {
            if stealth_enabled() {
                let _ = target.set_always_on_top(false);
                let _ = target.hide();
                let _ = target.app_handle().emit("stealth_protection_error", "Не удалось защитить новое окно. Оно оставлено скрытым.");
            }
            log::warn!("Stealth mode: couldn't update window '{}': {e}", target.label());
        }
    }) {
        log::warn!("Stealth mode: couldn't reach the main thread: {e}");
    }
}

/// Call on the owning UI thread immediately before a dynamically created
/// hidden window is shown. The visibility hook protects its first frame.
pub fn prepare_on_ui<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    track_visibility(window)?;
    apply_setting(window, stealth_enabled())
}

/// Set a window's capture visibility for the stealth setting `on`.
///
/// Windows: only a window on screen is excluded. A hidden, transparent
/// WebView2 window that is excluded from capture leaves a blurred ghost of its
/// frame on the desktop (the overlay between meetings, the launcher during
/// one). [`track_visibility`] applies the setting as a window is shown and
/// clears it when the window is hidden.
fn apply_setting<R: Runtime>(window: &Window<R>, on: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    window.set_skip_taskbar(on || window.label() == "meeting-prompt").map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let on = on && window.is_visible().map_err(|e| format!("Couldn't query window visibility: {e}"))?;
    set_capture_excluded(window, on)
}

/// Keep a window's capture visibility in step with whether it is shown.
/// Called only on the thread owning the window.
#[cfg(target_os = "windows")]
fn track_visibility<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    visibility_hook::install(hwnd.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn track_visibility<R: Runtime>(_window: &Window<R>) -> Result<(), String> { Ok(()) }

/// Dynamic webviews are created hidden; await this before their first show.
#[command]
pub async fn prepare_private_window(app: AppHandle, label: String) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = handle.get_webview_window(&label).ok_or("Окно уже закрыто")?;
            track_visibility(&window.as_ref().window())?;
            apply_setting(&window.as_ref().window(), stealth_enabled())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "Не удалось подготовить защищённое окно".to_string())?
}

/// System file pickers are not Tauri windows and may be captured separately.
/// Serialize their lifetime with privacy toggles on the same UI thread.
#[command]
pub async fn set_native_dialog_active(app: AppHandle, active: bool) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = if active && stealth_enabled() {
            Err("В режиме приватности системные диалоги отключены. Добавьте файл перетаскиванием или временно выключите режим в настройках.".to_string())
        } else {
            if active { NATIVE_DIALOGS.fetch_add(1, Ordering::SeqCst); }
            else { NATIVE_DIALOGS.store(NATIVE_DIALOGS.load(Ordering::SeqCst).saturating_sub(1), Ordering::SeqCst); }
            Ok(())
        };
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "Не удалось проверить режим приватности".to_string())?
}

/// Used only to avoid hiding/showing already-protected windows for a screenshot.
pub fn capture_is_excluded<R: Runtime>(window: &Window<R>) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetWindowDisplayAffinity;
        let Ok(hwnd) = window.hwnd() else { return false };
        let mut affinity = 0u32;
        unsafe { GetWindowDisplayAffinity(windows::Win32::Foundation::HWND(hwnd.0 as *mut _), &mut affinity).is_ok() && affinity == 0x11 }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = window; false }
}

/// Capture-affinity policy shared by explicit setting changes and native
/// visibility callbacks. Native calls can synchronously re-enter the subclass;
/// record the newest request and apply it after the current call returns.
#[cfg(any(target_os = "windows", test))]
mod affinity_policy {
    #[derive(Debug, Default)]
    pub(super) struct AffinityState {
        applied: Option<bool>,
        desired: bool,
        applying: bool,
    }

    impl AffinityState {
        pub(super) fn request(&mut self, excluded: bool) -> Option<bool> {
            self.desired = excluded;
            self.begin()
        }

        fn begin(&mut self) -> Option<bool> {
            if self.applying || self.applied == Some(self.desired) {
                return None;
            }
            self.applying = true;
            Some(self.desired)
        }

        pub(super) fn complete(&mut self, attempt: bool, succeeded: bool) -> Option<bool> {
            self.applying = false;
            if succeeded {
                self.applied = Some(attempt);
            }
            // A failed attempt is retried by the next request, never in a busy
            // loop. A visibility request received during it must still drain.
            if self.desired != attempt {
                self.begin()
            } else {
                None
            }
        }
    }

    pub(super) fn before_visibility_change(show: bool, hide: bool, stealth: bool) -> Option<bool> {
        if hide {
            Some(false)
        } else if show {
            Some(stealth)
        } else {
            None
        }
    }
}

/// Follow capture visibility only. Desktop blur is deliberately absent:
/// changing undocumented composition attributes from a window-position callback
/// can leave WebView2's surface over the desktop and stall the UI thread.
#[cfg(target_os = "windows")]
mod visibility_hook {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::affinity_policy::{before_visibility_change, AffinityState};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, SWP_HIDEWINDOW, SWP_SHOWWINDOW, WINDOWPOS, WINDOW_DISPLAY_AFFINITY,
        WM_NCDESTROY, WM_WINDOWPOSCHANGING,
    };

    const SUBCLASS_ID: usize = 0x4E58_5153; // "NXQS"
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;
    const WDA_NONE: u32 = 0;

    #[derive(Default)]
    struct WindowState {
        hooked: bool,
        affinity: AffinityState,
    }

    // All callers are on the thread owning these HWNDs. A borrow is never held
    // across a Win32 call, so synchronous native callbacks cannot deadlock or
    // recursively apply the same capture transition.
    thread_local! {
        static WINDOWS: RefCell<HashMap<isize, WindowState>> = RefCell::new(HashMap::new());
    }

    /// Install once per window (page reloads call this again). Main thread only.
    pub(super) fn install(hwnd: isize) -> Result<(), String> {
        let installed = WINDOWS.with(|windows| {
            windows.borrow().get(&hwnd).map_or(false, |state| state.hooked)
        });
        if installed {
            return Ok(());
        }
        let ok = unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(subclass_proc), SUBCLASS_ID, 0) };
        if !ok.as_bool() {
            return Err("SetWindowSubclass failed".into());
        }
        WINDOWS.with(|windows| windows.borrow_mut().entry(hwnd).or_default().hooked = true);
        Ok(())
    }

    pub(super) fn set_affinity(hwnd: isize, excluded: bool) -> Result<(), String> {
        let mut next = WINDOWS.with(|windows| {
            windows.borrow_mut().entry(hwnd).or_default().affinity.request(excluded)
        });
        let mut failure = None;
        while let Some(attempt) = next {
            let affinity = WINDOW_DISPLAY_AFFINITY(if attempt { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
            let result = unsafe { SetWindowDisplayAffinity(HWND(hwnd as *mut _), affinity) }
                .map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"));
            let succeeded = result.is_ok();
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
            next = WINDOWS.with(|windows| {
                // WM_NCDESTROY may have removed this HWND during the native call.
                windows.borrow_mut().get_mut(&hwnd)
                    .and_then(|state| state.affinity.complete(attempt, succeeded))
            });
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_WINDOWPOSCHANGING if lparam.0 != 0 => {
                let pos = &mut *(lparam.0 as *mut WINDOWPOS);
                if let Some(excluded) = before_visibility_change(
                    pos.flags.contains(SWP_SHOWWINDOW),
                    pos.flags.contains(SWP_HIDEWINDOW),
                    super::stealth_enabled(),
                ) {
                    // Clear before hiding, rather than after Windows has
                    // composited a hidden transparent capture-excluded surface.
                    if let Err(error) = set_affinity(hwnd.0 as isize, excluded) {
                        log::warn!("Stealth mode: {error}");
                        // A failed show must not expose the first frame.
                        if excluded {
                            pos.flags.0 = (pos.flags.0 & !SWP_SHOWWINDOW.0) | SWP_HIDEWINDOW.0;
                        }
                    }
                }
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                WINDOWS.with(|windows| windows.borrow_mut().remove(&(hwnd.0 as isize)));
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// At startup, before the webviews load their settings: hide the windows
/// right away when stealth mode was saved on (the frontend's `config.json`
/// store, key `stealthMode`), so reopening NexQ mid-share never shows them.
pub fn restore_on_startup(app: &AppHandle) -> Result<(), String> {
    // Called from Tauri's setup callback on the owning UI thread.
    let saved_on = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(FRONTEND_STORE)).ok())
        .map_or(false, |text| saved_stealth(&text));
    if saved_on && !support().supported {
        return Err("Режим приватности не поддерживается на этой платформе".into());
    }
    let windows: Vec<(String, Window)> = app
        .webview_windows()
        .into_iter()
        .map(|(label, w)| (label, w.as_ref().window()))
        .collect();
    // Stealth is on from here, so windows shown later are hidden from capture.
    STEALTH.store(saved_on, Ordering::SeqCst);
    for (_, window) in &windows {
        track_visibility(window)?;
    }
    transition(&windows, false, saved_on, apply_setting)?;
    if let Some(tray) = app.tray_by_id("main") { let _ = tray.set_visible(!saved_on); }
    log::info!("Presentation privacy restored before first show: {saved_on}");
    Ok(())
}

/// The frontend config store file (src/stores/configStore.ts `STORE_FILE`).
const FRONTEND_STORE: &str = "config.json";

fn saved_stealth(store_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(store_json)
        .ok()
        .and_then(|v| v.get("stealthMode").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn set_capture_excluded<R: Runtime>(window: &Window<R>, excluded: bool) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| format!("no window handle: {e}"))?;
    visibility_hook::set_affinity(hwnd.0 as isize, excluded)
}

#[cfg(target_os = "macos")]
fn set_capture_excluded<R: Runtime>(window: &Window<R>, excluded: bool) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSWindowSharingType: 0 = None (left out of capture), 1 = ReadOnly (default).
    let sharing_type: usize = if excluded { 0 } else { 1 };
    let target = window.clone();
    // AppKit must only be touched from the main thread.
    window
        .run_on_main_thread(move || match target.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // SAFETY: `ptr` is the live NSWindow backing this Tauri window.
                let ns_window: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
                let _: () = unsafe { msg_send![ns_window, setSharingType: sharing_type] };
            }
            Ok(_) => log::warn!("Stealth mode: NSWindow pointer was null for '{}'", target.label()),
            Err(e) => log::warn!("Stealth mode: no NSWindow for '{}': {e}", target.label()),
        })
        .map_err(|e| format!("couldn't reach the main thread: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn set_capture_excluded<R: Runtime>(_window: &Window<R>, excluded: bool) -> Result<(), String> {
    if excluded {
        Err("not supported on this platform".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::affinity_policy::{before_visibility_change, AffinityState};
    use std::cell::RefCell;

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "interactive Windows affinity lifecycle check; synthetic windows only, no screenshots or requests"]
    fn native_privacy_protects_first_show_late_windows_and_repeated_hide_show() {
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::*;
        struct Fixture { windows: Vec<HWND>, previous: bool }
        impl Drop for Fixture {
            fn drop(&mut self) {
                for hwnd in &self.windows { unsafe { let _ = DestroyWindow(*hwnd); } }
                STEALTH.store(self.previous, Ordering::SeqCst);
            }
        }
        let mut fixture = Fixture { windows: vec![], previous: stealth_enabled() };
        STEALTH.store(true, Ordering::SeqCst);
        for _ in 0..2 {
            let hwnd = unsafe { CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, w!("STATIC"), w!("NexQ synthetic privacy test"), WS_POPUP, 10, 10, 64, 64, None, None, None, None).unwrap() };
            fixture.windows.push(hwnd);
            visibility_hook::install(hwnd.0 as isize).unwrap();
            for _ in 0..10 {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    let mut affinity = 0;
                    GetWindowDisplayAffinity(hwnd, &mut affinity).unwrap();
                    assert_eq!(affinity, 0x11, "window must be excluded on its first visible frame");
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    GetWindowDisplayAffinity(hwnd, &mut affinity).unwrap();
                    assert_eq!(affinity, 0, "hidden surfaces must release affinity to avoid desktop ghosts");
                }
            }
        }
    }

    /// Fake windows: (fails_when_set_to, current state).
    fn windows(specs: &[(&str, Option<bool>)]) -> Vec<(String, (Option<bool>, RefCell<bool>))> {
        specs
            .iter()
            .map(|(l, fail)| (l.to_string(), (*fail, RefCell::new(false))))
            .collect()
    }

    fn apply(w: &(Option<bool>, RefCell<bool>), on: bool) -> Result<(), String> {
        if w.0 == Some(on) {
            return Err("refused".into());
        }
        *w.1.borrow_mut() = on;
        Ok(())
    }

    #[test]
    fn all_windows_change_together() {
        let ws = windows(&[("launcher", None), ("overlay", None)]);
        assert!(transition(&ws, false, true, apply).is_ok());
        assert!(ws.iter().all(|(_, w)| *w.1.borrow()));
    }

    #[test]
    fn a_refusal_rolls_back_the_windows_already_changed() {
        let ws = windows(&[("launcher", None), ("overlay", Some(true))]);
        let err = transition(&ws, false, true, apply).unwrap_err();
        assert!(err.contains("still visible in"), "{err}");
        assert!(ws.iter().all(|(_, w)| !*w.1.borrow()));
    }

    #[test]
    fn a_failed_rollback_names_the_windows_left_changed() {
        // launcher accepts "on" but refuses going back to "off".
        let ws = windows(&[("launcher", Some(false)), ("overlay", Some(true))]);
        let err = transition(&ws, false, true, apply).unwrap_err();
        assert!(err.contains("couldn't be put back: launcher"), "{err}");
    }

    #[test]
    fn saved_setting_is_read_from_the_frontend_store() {
        assert!(saved_stealth(r#"{"stealthMode":true,"theme":"dark"}"#));
        assert!(!saved_stealth(r#"{"stealthMode":false}"#));
        assert!(!saved_stealth("{}"));
        assert!(!saved_stealth("not json"));
    }

    #[test]
    fn hide_clears_capture_before_windows_hides_the_surface() {
        assert_eq!(before_visibility_change(false, true, true), Some(false));
        assert_eq!(before_visibility_change(false, true, false), Some(false));
        // Hide wins even if a malformed or combined event also says show.
        assert_eq!(before_visibility_change(true, true, true), Some(false));
    }

    #[test]
    fn show_restores_the_current_setting_and_plain_moves_do_nothing() {
        assert_eq!(before_visibility_change(true, false, true), Some(true));
        assert_eq!(before_visibility_change(true, false, false), Some(false));
        assert_eq!(before_visibility_change(false, false, true), None);
        assert_eq!(before_visibility_change(false, false, false), None);
    }

    #[test]
    fn repeated_visibility_events_do_not_repeat_native_calls() {
        let mut state = AffinityState::default();
        let mut native_calls = Vec::new();
        for desired in [false, false, true, true, true, false, false] {
            if let Some(attempt) = state.request(desired) {
                native_calls.push(attempt);
                assert_eq!(state.complete(attempt, true), None);
            }
        }
        assert_eq!(native_calls, [false, true, false]);
    }

    #[test]
    fn a_reentrant_hide_is_applied_after_the_current_native_call() {
        let mut state = AffinityState::default();
        assert_eq!(state.request(true), Some(true));
        // A native SetWindowDisplayAffinity callback requests hide while the
        // first call is on the stack. It must not recursively call Win32.
        assert_eq!(state.request(false), None);
        assert_eq!(state.request(false), None);
        assert_eq!(state.complete(true, true), Some(false));
        assert_eq!(state.request(false), None);
        assert_eq!(state.complete(false, true), None);
        assert_eq!(state.request(false), None);
    }

    #[test]
    fn reentrant_visibility_changes_coalesce_to_the_newest_request() {
        let mut state = AffinityState::default();
        assert_eq!(state.request(true), Some(true));
        assert_eq!(state.request(false), None);
        assert_eq!(state.request(true), None);
        assert_eq!(state.complete(true, true), None);
        assert_eq!(state.request(true), None);
    }

    #[test]
    fn failed_native_attempt_is_retried_without_a_busy_loop() {
        let mut state = AffinityState::default();
        assert_eq!(state.request(true), Some(true));
        assert_eq!(state.complete(true, false), None);
        assert_eq!(state.request(true), Some(true));
        assert_eq!(state.complete(true, true), None);
        assert_eq!(state.request(true), None);
        // A failed clear must retain the old cached state, so the next hide
        // attempts it again instead of wrongly assuming the surface is clear.
        assert_eq!(state.request(false), Some(false));
        assert_eq!(state.complete(false, false), None);
        assert_eq!(state.request(false), Some(false));
        assert_eq!(state.complete(false, true), None);
    }

    #[test]
    fn a_failed_native_attempt_still_drains_a_reentrant_hide() {
        let mut state = AffinityState::default();
        assert_eq!(state.request(true), Some(true));
        assert_eq!(state.request(false), None);
        assert_eq!(state.complete(true, false), Some(false));
        assert_eq!(state.complete(false, true), None);
        assert_eq!(state.request(false), None);
    }
}
