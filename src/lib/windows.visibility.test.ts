import { beforeEach, describe, expect, it, vi } from "vitest";

const { events, windows } = vi.hoisted(() => ({
  events: [] as string[],
  windows: new Map<string, Record<string, ReturnType<typeof vi.fn>>>(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: async (label: string) => windows.get(label) ?? null },
}));
vi.mock("./logger", () => ({ logToFile: vi.fn() }));
import { hideOverlayWindow, showLauncherWindow, showOverlayWindow, setHideAfterMeetingEnd, showAfterMeetingEnd } from "./windows";

beforeEach(() => {
  setHideAfterMeetingEnd(false);
  events.length = 0;
  windows.clear();
  for (const label of ["launcher", "overlay"]) {
    windows.set(label, Object.fromEntries(["show", "hide", "unminimize", "setFocus", "setAlwaysOnTop"].map(action => [
      action, vi.fn(async (...args: unknown[]) => { events.push(`${label}.${action}${args.length ? `:${args[0]}` : ""}`); }),
    ])));
  }
});

describe("window visibility and desktop ownership", () => {
  it("Ctrl+M hides both windows even when automatic end notifications repeat", async () => {
    setHideAfterMeetingEnd(true);
    await showAfterMeetingEnd();
    await showAfterMeetingEnd();
    expect(events).toEqual([
      "overlay.setAlwaysOnTop:false", "overlay.hide", "launcher.hide",
      "overlay.setAlwaysOnTop:false", "overlay.hide", "launcher.hide",
    ]);
  });
  it("a new meeting restores the normal return-to-menu behavior", async () => {
    setHideAfterMeetingEnd(true);
    await showOverlayWindow();
    events.length = 0;
    await showAfterMeetingEnd();
    expect(events).toEqual(["overlay.setAlwaysOnTop:false", "overlay.hide", "launcher.show", "launcher.unminimize", "launcher.setFocus"]);
  });
  it("drops the overlay topmost state before hiding it and focusing the dashboard", async () => {
    await showLauncherWindow();
    expect(events).toEqual(["overlay.setAlwaysOnTop:false", "overlay.hide", "launcher.show", "launcher.unminimize", "launcher.setFocus"]);
  });
  it("restores topmost only when showing a meeting and then hides the dashboard", async () => {
    await showOverlayWindow();
    expect(events).toEqual(["overlay.setAlwaysOnTop:true", "overlay.show", "overlay.unminimize", "overlay.setFocus", "launcher.hide"]);
  });
  it("hides without destroying the webview that owns meeting data", async () => {
    await hideOverlayWindow();
    expect(events).toEqual(["overlay.setAlwaysOnTop:false", "overlay.hide"]);
  });
  it("never hides the only usable window when its overlay is unavailable", async () => {
    windows.delete("overlay");
    await showOverlayWindow();
    expect(events).toEqual([]);
  });
  it("releases topmost and keeps the dashboard when native show fails", async () => {
    windows.get("overlay")!.show.mockRejectedValueOnce(new Error("window unavailable"));
    await expect(showOverlayWindow()).rejects.toThrow("window unavailable");
    expect(events).toEqual(["overlay.setAlwaysOnTop:true", "overlay.setAlwaysOnTop:false"]);
  });
  it("still hides the overlay when the topmost adjustment fails", async () => {
    windows.get("overlay")!.setAlwaysOnTop.mockRejectedValueOnce(new Error("already hidden"));
    await hideOverlayWindow();
    expect(events).toEqual(["overlay.hide"]);
  });
});
