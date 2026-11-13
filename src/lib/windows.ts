/**
 * Window switching helpers for the two-window Tauri layout.
 *
 * Keeping show/hide/focus in one place prevents the React view state from
 * drifting away from the actual native windows.
 */
import { logToFile } from "./logger";

let hideAfterMeetingEnd = false;
let meetingPlacement: { id: string; promise: Promise<void> } | null = null;
export function setHideAfterMeetingEnd(hide: boolean): void { hideAfterMeetingEnd = hide; }

/** Automatic return after saving: Ctrl+M leaves both windows in the tray. */
export async function showAfterMeetingEnd(): Promise<void> {
  if (!hideAfterMeetingEnd) return showLauncherWindow();
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await hideOverlayWindow();
  await (await WebviewWindow.getByLabel("launcher"))?.hide();
}

/** Show the launcher window and hide the overlay (whichever window asks). */
export async function showLauncherWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const launcher = await WebviewWindow.getByLabel("launcher");
  const overlay = await WebviewWindow.getByLabel("overlay");

  if (overlay) {
    await overlay.setAlwaysOnTop(false).catch(() => {});
    await overlay.hide().catch(() => {});
  }
  if (launcher) {
    await launcher.show().catch(() => {});
    await launcher.unminimize().catch(() => {});
    await launcher.setFocus().catch(() => {});
  }
}

/**
 * Show the overlay window and hide the launcher. Only the overlay window's
 * own view decides what it renders, so callers outside it should use
 * {@link showMeetingOverlay}.
 */
export async function showOverlayWindow(meetingId?: string): Promise<void> {
  hideAfterMeetingEnd = false;
  logToFile("info", "windows", "Showing the overlay window");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const overlay = await WebviewWindow.getByLabel("overlay");
  const launcher = await WebviewWindow.getByLabel("launcher");

  if (!overlay) return; // Keep the launcher usable if its companion is unavailable.
  if (meetingId) {
    try {
      if (meetingPlacement?.id !== meetingId) {
        const { placeSessionWindow } = await import("./sessionWindowPlacement");
        // First show of each recording only; returning from hide preserves any
        // position/size the user chose manually during that recording.
        if (meetingPlacement?.id !== meetingId) {
          meetingPlacement = { id: meetingId, promise: placeSessionWindow(overlay, launcher) };
        }
      }
      await meetingPlacement?.promise;
    } catch (error) {
      if (meetingPlacement?.id === meetingId) meetingPlacement = null;
      logToFile("warn", "windows", `Не удалось разместить окно сессии: ${String(error)}`);
    }
    // Ending the recording while monitor/size queries are pending must not
    // resurrect either window after Ctrl+M.
    const { useMeetingStore } = await import("../stores/meetingStore");
    if (useMeetingStore.getState().activeMeeting?.id !== meetingId) return;
  }
  try {
    await overlay.setAlwaysOnTop(true).catch(() => {});
    await overlay.show();
    await overlay.unminimize().catch(() => {});
    await overlay.setFocus().catch(() => {});
  } catch (error) {
    await overlay.setAlwaysOnTop(false).catch(() => {});
    throw error;
  }
  await launcher?.hide().catch(() => {});
}

/** Release the overlay's topmost surface before hiding it to the tray. */
export async function hideOverlayWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const overlay = await WebviewWindow.getByLabel("overlay");
  if (!overlay) return;
  await overlay.setAlwaysOnTop(false).catch(() => {});
  await overlay.hide().catch(() => {});
}

/** Window -> overlay window: bring back the floating meeting overlay. */
export const SHOW_MEETING_OVERLAY_EVENT = "nexq:show_meeting_overlay";

/**
 * Bring back the floating meeting overlay from any window (launcher RETURN,
 * Ctrl+B, tray). The overlay window switches itself to the meeting view and
 * shows; without a running meeting it shows the launcher instead.
 */
export async function showMeetingOverlay(): Promise<void> {
  hideAfterMeetingEnd = false;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(SHOW_MEETING_OVERLAY_EVENT);
}

/** Whether the overlay window is on screen. */
export async function isOverlayVisible(): Promise<boolean> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const overlay = await WebviewWindow.getByLabel("overlay");
  return overlay ? overlay.isVisible().catch(() => false) : false;
}

/**
 * Speakers, bookmarks, action items and topic sections are edited in the
 * overlay window. When a meeting ends, both windows may run endMeetingFlow
 * (tray Stop, update restart), and saving them replaces all rows — so exactly
 * one window persists them: the overlay, or the launcher only when no overlay
 * window has taken the meeting.
 */
export function shouldPersistOverlayData(windowLabel: string, overlayActive: boolean): boolean {
  if (windowLabel === "overlay") return true;
  return !overlayActive;
}

/**
 * How a window ends the running meeting: by itself, or through every window
 * (the tray's Stop path) when it is not the overlay and the overlay took the
 * meeting — the overlay holds data only it saves (see
 * shouldPersistOverlayData), so it must run its own endMeetingFlow.
 */
export function meetingEndRoute(windowLabel: string, overlayActive: boolean): "here" | "all_windows" {
  return windowLabel !== "overlay" && overlayActive ? "all_windows" : "here";
}

/**
 * What the meeting shortcut (Ctrl+M) does: end the running meeting, start
 * one, or nothing while a deferred quit is pending (NexQ is about to exit).
 */
export function meetingShortcutAction(hasMeeting: boolean, quitPending: boolean): "end" | "start" | "ignore" {
  if (hasMeeting) return "end";
  return quitPending ? "ignore" : "start";
}

/**
 * Whether the user can see a window right now (shown and not minimized).
 * An unknown window or a failed query counts as not shown.
 */
export async function isWindowShown(label: string): Promise<boolean> {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = await WebviewWindow.getByLabel(label);
    if (!win) return false;
    return (await win.isVisible()) && !(await win.isMinimized());
  } catch {
    return false;
  }
}
