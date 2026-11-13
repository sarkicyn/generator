import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";

const shortcuts = vi.hoisted(() => new Map<string, (event: { state: string }) => void>());
const captureFailure = vi.hoisted(() => ({ message: "" }));
const emitted = vi.hoisted(() => [] as Array<[string, unknown]>);
const generatedRequests = vi.hoisted(() => [] as Array<{ customQuestion?: string; transcriptSegments: string; captureScreen?: boolean }>);
const actionConfigs = vi.hoisted(() => ({ value: { instructionPresets: {length:"standard"}, customInstructions:"", actions:{}, globalDefaults:{} } as Record<string, unknown> }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: async (key: string, handler: (event: { state: string }) => void) => { shortcuts.set(key, handler); },
  unregister: async (key: string) => { shortcuts.delete(key); },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
  emitTo: async (_target: string, event: string, payload?: unknown) => { emitted.push([event, payload]); },
  emit: async (event: string, payload?: unknown) => { emitted.push([event, payload]); },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { customQuestion?: string; transcriptSegments: string }) => {
    if (command === "get_action_configs") return JSON.stringify(actionConfigs.value);
    if (command === "update_action_configs") actionConfigs.value = JSON.parse((args as unknown as {configsJson:string}).configsJson);
    if (command === "generate_assist" && args) generatedRequests.push(args);
    if (command === "start_capture" && captureFailure.message) throw captureFailure.message;
    if (command === "start_meeting") {
      const meeting: Meeting = {
        id: "shortcut-meeting", title: "Shortcut meeting", start_time: "2026-10-24T00:00:00Z",
        end_time: null, duration_seconds: null, transcript: [], ai_interactions: [],
        summary: null, config_snapshot: null,
      };
      return JSON.stringify(meeting);
    }
    return null;
  },
}));

const stores: Array<{ getState: () => { stopTimer: () => void } }> = [];

async function mountWindow(label: "launcher" | "overlay") {
  // Static imports would share Zustand stores across the simulated webviews.
  vi.resetModules();
  vi.doMock("@tauri-apps/api/webviewWindow", () => ({
    getCurrentWebviewWindow: () => ({ label }),
    WebviewWindow: { getByLabel: async () => null },
  }));
  const { useGlobalShortcut } = await import("./useGlobalShortcut");
  const { useMeetingStore } = await import("../stores/meetingStore");
  const { useConfigStore } = await import("../stores/configStore");
  useConfigStore.setState({ stealthShortcut: "", meetingAudioConfig: null });
  stores.push(useMeetingStore);
  renderHook(() => useGlobalShortcut());
  if (label === "launcher") await waitFor(() => expect(shortcuts.has("CmdOrCtrl+,")).toBe(true));
  else await act(async () => {});
  return useMeetingStore;
}

beforeEach(() => {
  shortcuts.clear();
  captureFailure.message = "";
  generatedRequests.length = 0;
  actionConfigs.value = { instructionPresets: {length:"standard"}, customInstructions:"", actions:{}, globalDefaults:{} };
});
afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.getState().stopTimer();
  vi.restoreAllMocks();
});

it("starts recording in the launcher that owns Web Speech when the overlay loads last", async () => {
  const launcher = await mountWindow("launcher");
  shortcuts.delete("CmdOrCtrl+,");
  const overlay = await mountWindow("overlay");

  await act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  await waitFor(() => expect(launcher.getState().isRecording || overlay.getState().isRecording).toBe(true));
  await waitFor(() => expect(launcher.getState().isRecording).toBe(true));
  expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting");
  expect(overlay.getState().isRecording).toBe(false);
});

it("Ctrl+E has one launcher owner, routes the meeting to the overlay without focusing it and ignores a held key", async () => {
  const launcher = await mountWindow("launcher");
  launcher.setState({activeMeeting:{id:"evaluation-meeting"} as Meeting});
  shortcuts.delete("CmdOrCtrl+,");
  await mountWindow("overlay");
  const before=emitted.filter(([event])=>event==="nexq:evaluate_answer").length;
  await act(async()=>{
    shortcuts.get("CmdOrCtrl+E")!({state:"Pressed"});
    shortcuts.get("CmdOrCtrl+E")!({state:"Pressed"});
  });
  expect(emitted.filter(([event])=>event==="nexq:evaluate_answer").slice(before)).toEqual([["nexq:evaluate_answer",{meetingId:"evaluation-meeting"}]]);
  expect(generatedRequests).toHaveLength(0);
});

it("reports denied audio capture while retaining the created meeting", async () => {
  captureFailure.message = "System audio recording permission denied";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const launcher = await mountWindow("launcher");
  await act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  await waitFor(() => expect(launcher.getState().isRecording).toBe(true));
  // Every window is told (the overlay is the one on screen).
  await waitFor(() => expect(emitted).toEqual(expect.arrayContaining([
    ["capture_warning", expect.stringContaining("System audio recording permission denied")],
  ])));
  expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting");
});

it("Space selects the latest block with earlier paragraphs retained as reference and ignores key repeat", async () => {
  const meeting = await mountWindow("overlay");
  meeting.setState({ activeMeeting: { id: "active" } as Meeting, isRecording: true });
  const { useTranscriptStore } = await import("../stores/transcriptStore");
  useTranscriptStore.setState({ segments: [
    { id: "old", text: "Что такое стек?", speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9 },
    { id: "latest", text: "Что такое Large Object Heap?", speaker: "Them", timestamp_ms: 2000, is_final: true, confidence: 0.9 },
  ] });
  await act(async () => {
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    fireEvent.keyDown(window, { key: " ", code: "Space", repeat: true });
  });
  expect(generatedRequests).toHaveLength(1);
  expect(generatedRequests[0].customQuestion).toBe("Что такое Large Object Heap?");
  expect(JSON.parse(generatedRequests[0].transcriptSegments).map((s: { id: string }) => s.id)).toEqual(["old"]);
});

it("Space in text input or already handled by a control does not start another AI request", async () => {
  const meeting = await mountWindow("overlay");
  meeting.setState({ activeMeeting: { id: "active" } as Meeting, isRecording: true });
  const input = document.createElement("input");
  document.body.append(input);
  try {
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    const handled = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    await act(async () => {});
    expect(generatedRequests).toHaveLength(0);
  } finally {
    input.remove();
  }
});

it("Ctrl+S joins fragments into one request on a Russian keyboard without toggling stats or repeating", async () => {
  const meeting = await mountWindow("overlay");
  meeting.setState({ activeMeeting: { id: "active" } as Meeting, isRecording: true });
  const { useTranscriptStore } = await import("../stores/transcriptStore");
  useTranscriptStore.setState({ segments: [
    { id: "one", text: "Что такое Large", speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9 },
    { id: "two", text: "Object Heap? Как он работает?", speaker: "Them", timestamp_ms: 2000, is_final: true, confidence: 0.9 },
  ], selectedSegmentIds: ["two", "one"] });
  const { useMeetingShortcuts } = await import("./useMeetingShortcuts");
  const actions = { addBookmark: vi.fn(), toggleStats: vi.fn(), toggleBookmarks: vi.fn(), toggleMute: vi.fn(), closeAllPanels: vi.fn(), toggleDevLog: vi.fn() };
  renderHook(() => useMeetingShortcuts(actions));
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  document.body.append(checkbox);
  const key = new KeyboardEvent("keydown", { key: "ы", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => {
    checkbox.dispatchEvent(key);
    fireEvent.keyDown(window, { key: "ы", code: "KeyS", ctrlKey: true, repeat: true });
  });
  checkbox.remove();
  expect(key.defaultPrevented).toBe(true);
  expect(generatedRequests).toHaveLength(1);
  expect(generatedRequests[0].customQuestion).toBe("Что такое Large Object Heap? Как он работает?");
  expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
  expect(actions.toggleStats).not.toHaveBeenCalled();
  // Plain S still opens stats.
  fireEvent.keyDown(window, { key: "s", code: "KeyS" });
  expect(actions.toggleStats).toHaveBeenCalledOnce();
});

it("Ctrl+S ignores inputs, modified variants, handled events and windows without a session", async () => {
  const meeting = await mountWindow("overlay");
  const { useTranscriptStore } = await import("../stores/transcriptStore");
  useTranscriptStore.setState({ segments: [
    { id: "one", text: "Вопрос?", speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9 },
  ] });
  await act(async () => { fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true }); });
  meeting.setState({ activeMeeting: { id: "active" } as Meeting, isRecording: true });
  const input = document.createElement("input");
  document.body.append(input);
  try {
    await act(async () => {
      fireEvent.keyDown(input, { key: "s", code: "KeyS", ctrlKey: true });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true, altKey: true });
      fireEvent.keyDown(window, { key: "s", code: "KeyS" });
      const handled = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true });
      handled.preventDefault();
      window.dispatchEvent(handled);
    });
    expect(generatedRequests).toHaveLength(0);
  } finally {
    input.remove();
  }
});

it("Ctrl+A requests one screen answer on a Russian keyboard, ignoring repeat and the former shortcut", async () => {
  const meeting=await mountWindow("overlay");
  meeting.setState({activeMeeting:{id:"active"} as Meeting,isRecording:true});
    const key=new KeyboardEvent("keydown",{key:"ф",code:"KeyA",ctrlKey:true,bubbles:true,cancelable:true});
    await act(async()=>{
      window.dispatchEvent(key);
      fireEvent.keyDown(window,{key:"ф",code:"KeyA",ctrlKey:true,repeat:true});
      fireEvent.keyDown(window,{key:"Ы",code:"KeyS",ctrlKey:true,shiftKey:true});
      fireEvent.keyDown(window,{key:"Ф",code:"KeyA",ctrlKey:true,shiftKey:true});
    });
    expect(key.defaultPrevented).toBe(true);
    expect(generatedRequests).toHaveLength(1);
    expect(generatedRequests[0].captureScreen).toBe(true);
    expect(generatedRequests[0].customQuestion).toContain("снимок экрана");
});

it("Ctrl+A in a text field keeps Select All without taking a screenshot", async () => {
  const meeting=await mountWindow("overlay");
  meeting.setState({activeMeeting:{id:"active"} as Meeting,isRecording:true});
  for (const tag of ["input","textarea"]) {
    const field=document.createElement(tag); document.body.append(field);
    const key=new KeyboardEvent("keydown",{key:"a",code:"KeyA",ctrlKey:true,bubbles:true,cancelable:true});
    await act(async()=>{field.dispatchEvent(key);});
    expect(key.defaultPrevented).toBe(false);
    field.remove();
  }
  expect(generatedRequests).toHaveLength(0);
});

it("Ctrl+D clears all checked fragments on a Russian keyboard without sending and ignores text inputs or Shift", async () => {
  const meeting = await mountWindow("overlay");
  meeting.setState({ activeMeeting: { id: "active" } as Meeting, isRecording: true });
  const { useTranscriptStore } = await import("../stores/transcriptStore");
  useTranscriptStore.setState({ selectedSegmentIds: ["one", "two"] });
  const input = document.createElement("input");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  document.body.append(input, checkbox);
  try {
    fireEvent.keyDown(input, { key: "в", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(window, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["one", "two"]);
    const key = new KeyboardEvent("keydown", { key: "в", code: "KeyD", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { checkbox.dispatchEvent(key); });
    expect(key.defaultPrevented).toBe(true);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
    expect(generatedRequests).toHaveLength(0);
  } finally {
    input.remove();
    checkbox.remove();
  }
});

it("background question and screenshot shortcuts have one owner and send one intent per press", async () => {
  const launcher = await mountWindow("launcher");
  launcher.setState({ activeMeeting: { id: "background-session" } as Meeting });
  await waitFor(() => expect(shortcuts.has("CmdOrCtrl+Shift+A")).toBe(true));
  await mountWindow("overlay");
  const before = emitted.length;
  await act(async () => {
    for (const key of ["CmdOrCtrl+Shift+Q", "CmdOrCtrl+Shift+A"]) {
      shortcuts.get(key)!({ state: "Pressed" });
      shortcuts.get(key)!({ state: "Pressed" });
    }
  });
  expect(emitted.slice(before)).toEqual([
    ["nexq:background_assist", { meetingId: "background-session" }],
    ["nexq:background_screen", { meetingId: "background-session" }],
  ]);
  expect(shortcuts.has("CmdOrCtrl+A")).toBe(false);
});

it("background shortcuts do not submit anything without a live meeting", async () => {
  await mountWindow("launcher");
  await waitFor(() => expect(shortcuts.has("CmdOrCtrl+Shift+A")).toBe(true));
  const before = emitted.length;
  await act(async () => { shortcuts.get("CmdOrCtrl+Shift+A")!({ state: "Pressed" }); });
  expect(emitted.slice(before)).toEqual([]);
});

it("Ctrl+K toggles once per press during a session, keeps the running answer, and unregisters on end", async () => {
  const launcher = await mountWindow("launcher");
  expect(shortcuts.has("CmdOrCtrl+K")).toBe(false);
  await act(async () => { launcher.setState({activeMeeting:{id:"brief-session"} as Meeting}); });
  await waitFor(() => expect(shortcuts.has("CmdOrCtrl+K")).toBe(true));
  const { useStreamStore } = await import("../stores/streamStore");
  useStreamStore.setState({isStreaming:true});
  const before = emitted.length;
  await act(async () => {
    shortcuts.get("CmdOrCtrl+K")!({state:"Pressed"});
    shortcuts.get("CmdOrCtrl+K")!({state:"Pressed"});
  });
  await waitFor(() => expect(actionConfigs.value.instructionPresets).toEqual({length:"brief"}));
  expect(emitted.slice(before).filter(([event])=>event==="nexq:brief_mode_changed")).toHaveLength(1);
  expect(useStreamStore.getState().isStreaming).toBe(true);
  expect(generatedRequests).toHaveLength(0);
  await act(async () => {
    shortcuts.get("CmdOrCtrl+K")!({state:"Released"});
    shortcuts.get("CmdOrCtrl+K")!({state:"Pressed"});
  });
  await waitFor(() => expect(actionConfigs.value.instructionPresets).toEqual({length:"standard"}));
  await act(async () => { launcher.setState({activeMeeting:null}); });
  await waitFor(() => expect(shortcuts.has("CmdOrCtrl+K")).toBe(false));
});
