import { normalizeAccelerator, reservedShortcutAction } from "./shortcutLabel";

export const DEFAULT_BACKGROUND_SHORTCUTS = {
  assist: "CmdOrCtrl+Shift+Q",
  screen: "CmdOrCtrl+Shift+A",
  visibility: "CmdOrCtrl+Shift+B",
};
export type BackgroundShortcuts = typeof DEFAULT_BACKGROUND_SHORTCUTS;
export type BackgroundAction = keyof BackgroundShortcuts;
export const BACKGROUND_LABELS: Record<BackgroundAction, string> = {
  assist: "Ответить на последний блок",
  screen: "Снимок экрана → ответ модели",
  visibility: "Показать или скрыть NexQ",
};

export function backgroundShortcutConflict(key: string, bindings: BackgroundShortcuts, action?: BackgroundAction, stealthKey = ""): string | null {
  const normalized = normalizeAccelerator(key);
  if (!/^(CmdOrCtrl|Ctrl|Super|Alt)\+/.test(normalized)) return "Сочетание должно содержать Ctrl, Alt или Win";
  const reserved = reservedShortcutAction(key);
  if (reserved) return `Сочетание уже используется: ${reserved}`;
  if (stealthKey && normalizeAccelerator(stealthKey) === normalized) return "Сочетание используется для режима приватности";
  const taken = (Object.keys(bindings) as BackgroundAction[]).find(a => a !== action && normalizeAccelerator(bindings[a]) === normalized);
  return taken ? `Сочетание уже используется: ${BACKGROUND_LABELS[taken]}` : null;
}

/** Windows emits repeated Pressed events while held. Each action runs once per press. */
export function oncePerPress(action: () => void | Promise<void>) {
  let held = false;
  return (event: { state: string }) => {
    if (event.state !== "Pressed") { held = false; return; }
    if (held) return;
    held = true;
    Promise.resolve().then(action).catch(() => {});
  };
}
