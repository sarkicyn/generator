import { beforeEach, expect, it, vi } from "vitest";
import type { AllActionConfigs } from "../lib/types";
const state = vi.hoisted(() => ({ saved: null as AllActionConfigs | null, backend: null as AllActionConfigs | null, listeners: [] as Array<(cfg:AllActionConfigs)=>void>, refuse:false }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({
  get: async () => state.saved,
  set: async (_key:string, value:AllActionConfigs) => {state.saved=structuredClone(value); state.listeners.forEach(fn=>fn(structuredClone(value)));},
  onKeyChange: async (_key:string, fn:(cfg:AllActionConfigs)=>void) => {state.listeners.push(fn); return ()=>{};},
}) }));
vi.mock("../lib/ipc", () => ({
  getActionConfigs: async () => structuredClone(state.backend),
  updateActionConfigs: async (cfg:AllActionConfigs) => {if(state.refuse) throw new Error("backend unavailable"); state.backend=structuredClone(cfg);},
  setCustomInstructions: vi.fn().mockResolvedValue(undefined),
}));
async function openWindow() {
  vi.resetModules();
  const { useAIActionsStore: store } = await import("./aiActionsStore");
  state.saved ??= structuredClone(store.getState().configs);
  await store.getState().loadConfigs();
  return store;
}
beforeEach(() => {state.saved=null; state.backend=null; state.listeners=[]; state.refuse=false;});

it("uses fresh backend settings, syncs both windows, preserves other presets and persists across reopen", async () => {
  const launcher=await openWindow(), overlay=await openWindow();
  state.backend!.instructionPresets={tone:"professional",format:"bullets",length:"detailed",opinion:null};
  state.backend!.customInstructions="Use my project terminology.";
  const original=structuredClone(state.backend!);
  expect(await launcher.getState().toggleBriefResponse()).toBe(true);
  expect(state.backend).toEqual({...original,instructionPresets:{...original.instructionPresets,length:"brief"}});
  expect(overlay.getState().configs.instructionPresets.length).toBe("brief");
  expect((await openWindow()).getState().configs.instructionPresets.length).toBe("brief");
  expect(await launcher.getState().toggleBriefResponse()).toBe(false);
  expect(state.saved!.instructionPresets.length).toBe("standard");
  expect(overlay.getState().configs.instructionPresets.length).toBe("standard");
  expect(state.saved!.customInstructions).toBe(original.customInstructions);
});

it("does not show or persist a changed mode when the backend refuses the toggle", async () => {
  const store=await openWindow();
  const original=structuredClone(state.saved);
  state.refuse=true;
  await expect(store.getState().toggleBriefResponse()).rejects.toThrow("backend unavailable");
  expect(state.saved).toEqual(original);
  expect(store.getState().configs).toEqual(original);
});
