import { invoke } from "@tauri-apps/api/core";
import * as dialogs from "@tauri-apps/plugin-dialog";
import { showToast } from "../stores/toastStore";

/** Keep OS-owned pickers out of presentation mode; feedback stays inside NexQ. */
async function guarded<T>(action: () => Promise<T>, cancelled: T): Promise<T> {
  try { await invoke("set_native_dialog_active", { active: true }); }
  catch (error) { showToast(String(error), "info"); return cancelled; }
  try { return await action(); }
  finally { await invoke("set_native_dialog_active", { active: false }); }
}
export const open: typeof dialogs.open = options => guarded(() => dialogs.open(options), null);
export const save: typeof dialogs.save = options => guarded(() => dialogs.save(options), null);
export const confirm: typeof dialogs.confirm = (message, options) => guarded(() => dialogs.confirm(message, options), false);
