import { expect, it, vi, beforeEach } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save, open: vi.fn(), confirm: vi.fn() }));
vi.mock("../stores/toastStore", () => ({ showToast: vi.fn() }));
import { save as guardedSave } from "./privacyDialogs";
beforeEach(() => { invoke.mockReset(); save.mockReset(); });
it("does not open an unprotected system dialog when native privacy mode refuses it", async () => {
  invoke.mockRejectedValueOnce("Режим приватности включён");
  expect(await guardedSave()).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
it("releases the native dialog guard after a cancelled or failed picker", async () => {
  invoke.mockResolvedValue(undefined); save.mockResolvedValueOnce(null);
  await guardedSave();
  expect(invoke.mock.calls).toEqual([["set_native_dialog_active", {active:true}], ["set_native_dialog_active", {active:false}]]);
  invoke.mockClear(); save.mockRejectedValueOnce(new Error("picker failed"));
  await expect(guardedSave()).rejects.toThrow("picker failed");
  expect(invoke).toHaveBeenLastCalledWith("set_native_dialog_active", {active:false});
});
