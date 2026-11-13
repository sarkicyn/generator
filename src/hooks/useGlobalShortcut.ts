import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { isQuitPending } from "../lib/ipc";
import { runLatestAssist, runMergedAssist, runScreenAssist, runUserAction } from "../lib/userAction";
import { isOverlayVisible, meetingShortcutAction, showAfterMeetingEnd, showLauncherWindow, showMeetingOverlay, hideOverlayWindow } from "../lib/windows";
import { endMeetingFromThisWindow } from "./useUpdater";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useAnswerEvaluationStore } from "../stores/answerEvaluationStore";
import { reservedShortcutAction } from "../lib/shortcutLabel";
import { backgroundShortcutConflict, oncePerPress, type BackgroundAction } from "../lib/backgroundShortcuts";

let registrationQueue = Promise.resolve();

/** Ctrl+M: end the running meeting (in every window that holds it) or start one. */
async function toggleMeetingFromShortcut(): Promise<void> {
  const store = useMeetingStore.getState();
  const quitPending = store.activeMeeting ? false : await isQuitPending().catch(() => false);
  switch (meetingShortcutAction(!!store.activeMeeting, quitPending)) {
    case "end":
      if (!(await endMeetingFromThisWindow(true))) {
        showToast("Couldn't finish saving the meeting", "error");
      } else await showAfterMeetingEnd();
      break;
    case "start":
      await store.startMeetingFlow();
      break;
    case "ignore":
      break;
  }
}

/** Stealth shortcut: hide NexQ from screen sharing, or show it again. */
export async function toggleStealthMode(): Promise<void> {
  const config = useConfigStore.getState();
  const enabled = !config.stealthMode;
  try {
    await config.setStealthMode(enabled);
    showToast(enabled ? "Режим приватности включён" : "Режим приватности выключен", "info");
  } catch (e) {
    showToast(`Не удалось изменить режим приватности: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export function useGlobalShortcut() {
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);
  const backgroundShortcuts = useConfigStore((s) => s.backgroundShortcuts);
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id);

  // Reserve Ctrl+K system-wide only during a session. Outside a session the
  // browser/editor keeps its usual shortcut. Held-key repeat is ignored.
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "launcher" || !activeMeetingId) return;
    let disposed = false;
    let registered = false;
    let busy = false;
    const key = "CmdOrCtrl+K";
    registrationQueue = registrationQueue.then(async () => {
      if (disposed) return;
      try {
        await register(key, oncePerPress(async () => {
          if (busy || useMeetingStore.getState().activeMeeting?.id !== activeMeetingId) return;
          busy = true;
          try {
            const enabled = await useAIActionsStore.getState().toggleBriefResponse();
            const message = enabled ? "Краткий ответ включён · Ctrl+K" : "Краткий ответ выключен — обычная длина · Ctrl+K";
            showToast(message, "info");
            await emitTo("overlay", "nexq:brief_mode_changed", { meetingId: activeMeetingId, message });
          } catch {
            const message = "Не удалось переключить краткий ответ";
            showToast(message, "error");
            await emitTo("overlay", "nexq:brief_mode_changed", { meetingId: activeMeetingId, message, error: true });
          } finally { busy = false; }
        }));
        registered = true;
      } catch {
        const message = "Не удалось подключить Ctrl+K: сочетание занято другой программой";
        showToast(message, "error");
        await emitTo("overlay", "nexq:brief_mode_changed", { meetingId: activeMeetingId, message, error: true }).catch(() => {});
      }
    });
    return () => {
      disposed = true;
      registrationQueue = registrationQueue.then(async () => {
        if (registered) await unregister(key).catch(() => {});
      });
    };
  }, [activeMeetingId]);

  // Only the permanent launcher owns system-wide registrations. The overlay
  // owns the transcript and runs AI requests without being focused or shown.
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "launcher") return;
    let disposed = false;
    const owned: string[] = [];
    let meetingBusy = false;
    const send = async (event: string) => {
      const meetingId = useMeetingStore.getState().activeMeeting?.id;
      if (meetingId) await emitTo("overlay", event, { meetingId });
    };
    const defs: Array<{ key: string; action: () => void | Promise<void> }> = [
      { key: "CmdOrCtrl+E", action: () => send("nexq:evaluate_answer") },
      { key: "CmdOrCtrl+M", action: async () => {
        if (meetingBusy) return;
        meetingBusy = true;
        try { await toggleMeetingFromShortcut(); } finally { meetingBusy = false; }
      } },
      { key: "CmdOrCtrl+B", action: async () => {
        if (await isOverlayVisible()) await showLauncherWindow();
        else if (useMeetingStore.getState().activeMeeting) await showMeetingOverlay();
      } },
      { key: "CmdOrCtrl+,", action: () => {
        const store = useMeetingStore.getState();
        store.setSettingsOpen(!store.settingsOpen);
      } },
    ];
    if (stealthShortcut && !reservedShortcutAction(stealthShortcut)) {
      defs.push({ key: stealthShortcut, action: toggleStealthMode });
    }
    const actions: Record<BackgroundAction, () => Promise<void>> = {
      assist: () => send("nexq:background_assist"),
      screen: () => send("nexq:background_screen"),
      visibility: async () => {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const launcher = await WebviewWindow.getByLabel("launcher");
        const launcherShown = launcher && await launcher.isVisible() && !(await launcher.isMinimized());
        if (await isOverlayVisible() || launcherShown) {
          await hideOverlayWindow();
          await launcher?.hide();
        } else if (useMeetingStore.getState().activeMeeting) await showMeetingOverlay();
        else await showLauncherWindow();
      },
    };
    for (const action of Object.keys(actions) as BackgroundAction[]) {
      const key = backgroundShortcuts[action];
      const conflict = backgroundShortcutConflict(key, backgroundShortcuts, action, stealthShortcut);
      if (conflict) {
        showToast(`Не подключено ${key}: ${conflict}`, "error");
      } else defs.push({ key, action: actions[action] });
    }
    // Serialize unregister/register across rapid settings changes and React remounts.
    registrationQueue = registrationQueue.then(async () => {
      for (const { key, action } of defs) {
        if (disposed) break;
        try {
          await register(key, oncePerPress(action));
          owned.push(key);
        } catch {
          showToast(`Не удалось подключить ${key}. Возможно, сочетание занято другой программой. Измените его в настройках.`, "error");
        }
      }
    });
    return () => {
      disposed = true;
      registrationQueue = registrationQueue.then(async () => {
        for (const key of owned) await unregister(key).catch(() => {});
      });
    };
  }, [stealthShortcut, backgroundShortcuts]);

  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "overlay") return;
    let disposed = false;
    const stops: Array<() => void> = [];
    listen<{ meetingId: string; message: string; error?: boolean }>("nexq:brief_mode_changed", event => {
      if (event.payload.meetingId === useMeetingStore.getState().activeMeeting?.id) {
        showToast(event.payload.message, event.payload.error ? "error" : "info");
      }
    }).then(stop => { if (disposed) stop(); else stops.push(stop); });
    const actions: Record<string, () => Promise<void>> = {
      "nexq:evaluate_answer": () => useAnswerEvaluationStore.getState().run(),
      "nexq:background_assist": () => runLatestAssist(),
      "nexq:background_screen": () => runScreenAssist(),
    };
    for (const [event, action] of Object.entries(actions)) {
      listen<{ meetingId: string }>(event, (message) => {
        if (message.payload.meetingId === useMeetingStore.getState().activeMeeting?.id) {
          action().catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
        }
      }).then(stop => { if (disposed) stop(); else stops.push(stop); });
    }
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);

  // Window-level shortcuts (work when window is active/focused)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;

      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if ((tag === "INPUT" && !(["KeyS", "KeyD", "KeyA"].includes(e.code) && (e.target as HTMLInputElement).type === "checkbox")) || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;

      // Check action visibility from the AI actions store
      const actions = useAIActionsStore.getState().configs.actions;
      const isVisible = (mode: string) => actions[mode]?.visible !== false;

      switch (e.code) {
        case "KeyA":
          if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (!e.repeat) runScreenAssist().catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
          break;
        case "KeyD":
          if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
          e.preventDefault();
          if (!e.repeat) useTranscriptStore.getState().clearSelection();
          break;
        case "KeyS":
          if (e.repeat || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
          if (isVisible("Assist")) {
            e.preventDefault();
            runMergedAssist().catch((error) => showToast(error instanceof Error ? error.message : "Не удалось отправить объединённую расшифровку", "error"));
          }
          break;
        case "Space":
          if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
          if (isVisible("Assist")) {
            e.preventDefault();
            runLatestAssist().catch((error) => showToast(error instanceof Error ? error.message : "Не удалось отправить последний вопрос", "error"));
          }
          break;
        case "Numpad1":
        case "Digit1":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("WhatToSay")) {
            e.preventDefault();
            runUserAction("WhatToSay").catch(() => {});
          }
          break;
        case "Numpad2":
        case "Digit2":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Shorten")) {
            e.preventDefault();
            runUserAction("Shorten").catch(() => {});
          }
          break;
        case "Numpad3":
        case "Digit3":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("FollowUp")) {
            e.preventDefault();
            runUserAction("FollowUp").catch(() => {});
          }
          break;
        case "Numpad4":
        case "Digit4":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Recap")) {
            e.preventDefault();
            runUserAction("Recap").catch(() => {});
          }
          break;
        case "Numpad5":
        case "Digit5":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("AskQuestion")) {
            e.preventDefault();
            // Open/focus the Ask input instead of triggering generation directly
            window.dispatchEvent(new Event("nexq:toggle-ask-input"));
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
