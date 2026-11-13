import { expect, it, vi } from "vitest";
import { backgroundShortcutConflict, DEFAULT_BACKGROUND_SHORTCUTS as defaults, oncePerPress } from "./backgroundShortcuts";

it("rejects Select All, reserved actions, duplicate spellings and the privacy toggle", () => {
  expect(backgroundShortcutConflict("Ctrl+A", defaults, "screen")).toBeTruthy();
  expect(backgroundShortcutConflict("Ctrl+E", defaults, "screen")).toBeTruthy();
  expect(backgroundShortcutConflict("shift+ctrl+q", defaults, "screen")).toBeTruthy();
  expect(backgroundShortcutConflict("Ctrl+Shift+H", defaults, "screen", "CmdOrCtrl+Shift+H")).toBeTruthy();
  expect(backgroundShortcutConflict("A", defaults, "screen")).toBeTruthy();
  expect(backgroundShortcutConflict(defaults.screen, defaults, "screen", "CmdOrCtrl+Shift+H")).toBeNull();
});

it("held-key events run once, release permits a replacement and an error does not lock the shortcut", async () => {
  const action = vi.fn().mockRejectedValueOnce(new Error("cancelled")).mockResolvedValue(undefined);
  const handler = oncePerPress(action);
  handler({state:"Pressed"}); handler({state:"Pressed"});
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  handler({state:"Released"}); handler({state:"Pressed"});
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
});
