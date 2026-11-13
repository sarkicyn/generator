import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useMeetingStore } from "./meetingStore";
import { useConfigStore } from "./configStore";
import type { Meeting } from "../lib/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {} }) }));
const meeting = (id="one", topic="Old topic"): Meeting => ({ id,topic,title:"Meeting",start_time:"2026-10-31T00:00:00Z",end_time:null,duration_seconds:null,transcript:[],ai_interactions:[],summary:null,config_snapshot:null });

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === "start_meeting") return JSON.stringify(meeting("one", (args as {topic?:string})?.topic ?? ""));
    return undefined;
  });
  useMeetingStore.setState({ activeMeeting:null,draftTopic:"",overlayMeetingId:null });
  useConfigStore.setState({ meetingAudioConfig:null });
});
afterEach(() => { useMeetingStore.getState().stopTimer(); });

it("sends the draft topic when starting through the shared shortcut flow, then clears it for the next recording", async () => {
  useMeetingStore.getState().setDraftTopic("  Собеседование по C#  ");
  await useMeetingStore.getState().startMeetingFlow();
  expect(invoke).toHaveBeenCalledWith("start_meeting", {title:undefined,topic:"Собеседование по C#"});
  expect(useMeetingStore.getState().activeMeeting?.topic).toBe("Собеседование по C#");
  expect(useMeetingStore.getState().draftTopic).toBe("");
});

it("keeps the saved topic when saving a live edit fails", async () => {
  useMeetingStore.setState({activeMeeting:meeting()});
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Save failed"));
  await expect(useMeetingStore.getState().updateTopic("New topic")).rejects.toThrow("Save failed");
  expect(useMeetingStore.getState().activeMeeting?.topic).toBe("Old topic");
});

it("never applies late topic events or saves to a different meeting", async () => {
  useMeetingStore.setState({activeMeeting:meeting()});
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => {finish=resolve;}));
  const saving=useMeetingStore.getState().updateTopic("Updated old topic");
  useMeetingStore.setState({activeMeeting:meeting("two","Second recording")});
  finish();
  await saving;
  useMeetingStore.getState().syncTopic("one","Late event");
  expect(useMeetingStore.getState().activeMeeting?.topic).toBe("Second recording");
  useMeetingStore.getState().syncTopic("two","Current event");
  expect(useMeetingStore.getState().activeMeeting?.topic).toBe("Current event");
});
