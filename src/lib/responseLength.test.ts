import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ set: async () => {} }) }));
vi.mock("./ipc", () => ({ updateActionConfigs: vi.fn().mockResolvedValue(undefined), getActionConfigs: vi.fn(), setCustomInstructions: vi.fn().mockResolvedValue(undefined) }));
import { RESPONSE_LENGTH_INSTRUCTIONS } from "./responseLength";
import { useAIActionsStore } from "../stores/aiActionsStore";

it("saved brief selection uses the actual native policy without losing custom instructions", () => {
  const store = useAIActionsStore.getState();
  store.setCustomInstructions("Use the terminology from my project.");
  store.setInstructionPresets({ tone:null, format:null, length:"brief", opinion:null });
  expect(store.getComposedInstructions()).toContain(RESPONSE_LENGTH_INSTRUCTIONS.brief);
  expect(store.getComposedInstructions()).toContain("Use the terminology from my project.");
});

it("switching length removes the brief constraints from the composed instructions", () => {
  const store = useAIActionsStore.getState();
  store.setInstructionPresets({ tone:null, format:null, length:"detailed", opinion:null });
  expect(store.getComposedInstructions()).toContain("Detailed responses.");
  expect(store.getComposedInstructions()).not.toContain(RESPONSE_LENGTH_INSTRUCTIONS.brief);
  store.setInstructionPresets({ tone:null, format:null, length:null, opinion:null });
  expect(store.getComposedInstructions()).not.toContain("Response length:");
});
