// Two windows (launcher + overlay) each have their own configStore. They meet
// in the plugin-store: a write in one window emits `store://change` to every
// window, and `onKeyChange` applies it. This models that with one shared map
// and a broadcast to every window's listeners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
      // Like the Rust side: every window (the writer included) hears the change.
      for (const l of keyListeners) if (l.key === key) l.cb(structuredClone(value));
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      keyListeners.push({ key, cb });
      return () => {};
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

/** A window: a fresh module graph (own Zustand store) that has loaded its config. */
async function openWindow() {
  vi.resetModules();
  const { useConfigStore } = await import("./configStore");
  await useConfigStore.getState().loadConfig();
  return useConfigStore;
}

describe("configStore: active LLM across windows", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    invoke.mockClear();
    saved.set("llmProvider", "ollama");
    saved.set("llmModel", "llama3.2");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a provider set in one window reaches the other", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    expect(overlay.getState().llmProvider).toBe("ollama");

    launcher.getState().setLLMProvider("claude_cli");
    launcher.getState().setLLMModel("haiku", "claude_cli");

    await vi.waitFor(() => expect(overlay.getState().llmProvider).toBe("claude_cli"));
    expect(overlay.getState().llmModel).toBe("haiku");
  });

  it("the Claude model catalog fetched by the launcher reaches the overlay and the next start", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    expect(overlay.getState().claudeModels).toBeNull();
    const catalog = [
      {
        value: "haiku",
        resolved_model: "claude-haiku-4-5-20251001",
        display_name: "Haiku 4.5",
        description: "",
        supports_effort: false,
        effort_levels: [],
      },
    ];
    launcher.getState().setClaudeModels(catalog);
    await vi.waitFor(() => expect(overlay.getState().claudeModels).toEqual(catalog));
    const nextStart = await openWindow();
    expect(nextStart.getState().claudeModels).toEqual(catalog);
  });

  it("the transcript scope picked in the overlay reaches the launcher and the next start", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    expect(overlay.getState().contextScope).toEqual({ kind: "default", minutes: 5 });
    expect(overlay.getState().contextScopeSticky).toBe(true);

    overlay.getState().setContextScope({ kind: "minutes", minutes: 10 });
    overlay.getState().setContextScopeSticky(false);
    await vi.waitFor(() => expect(launcher.getState().contextScope).toEqual({ kind: "minutes", minutes: 10 }));
    expect(launcher.getState().contextScopeSticky).toBe(false);

    const nextStart = await openWindow();
    expect(nextStart.getState().contextScope).toEqual({ kind: "minutes", minutes: 10 });
    expect(nextStart.getState().contextScopeSticky).toBe(false);
  });

  it("a malformed saved scope falls back to the default", async () => {
    saved.set("contextScope", { kind: "bogus", minutes: 3 });
    const w = await openWindow();
    expect(w.getState().contextScope).toEqual({ kind: "default", minutes: 5 });
  });

  it("activating in either window updates the backend and both windows", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();

    // Settings (launcher) → Claude.
    await launcher.getState().activateLLMProvider("claude_cli");
    expect(invoke).toHaveBeenCalledWith("set_llm_provider", { provider: JSON.stringify({ provider_type: "claude_cli" }), modelId: "haiku" });
    await vi.waitFor(() => expect(overlay.getState().llmProvider).toBe("claude_cli"));
    expect(launcher.getState().verifiedCloudProviders).toContain("claude_cli");

    // Footer (overlay) → back to Ollama with its last model.
    await overlay.getState().activateLLMProvider("ollama");
    await vi.waitFor(() => expect(launcher.getState().llmProvider).toBe("ollama"));
    expect(launcher.getState().llmModel).toBe("llama3.2");
    expect(invoke).toHaveBeenCalledWith("set_llm_provider", { provider: JSON.stringify({ provider_type: "ollama" }), modelId: "llama3.2" });
  });

  it("persists OpenAI and its model as one selection, restores it in another window and after restart", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    const observed: string[] = [];
    const stop = overlay.subscribe((state) => observed.push(`${state.llmProvider}/${state.llmModel}`));
    await launcher.getState().activateLLMProvider("openai", { model: "gpt-saved" });
    expect(saved.get("activeLLMSelection")).toEqual({ provider: "openai", model: "gpt-saved" });
    expect(overlay.getState()).toMatchObject({ llmProvider: "openai", llmModel: "gpt-saved" });
    expect(observed).not.toContain("openai/llama3.2");
    stop();
    // An older copy's separate legacy keys must not override the committed pair.
    saved.set("llmProvider", "ollama"); saved.set("llmModel", "");
    const restarted = await openWindow();
    expect(restarted.getState()).toMatchObject({ llmProvider: "openai", llmModel: "gpt-saved" });
    expect(invoke).toHaveBeenCalledWith("set_llm_provider", { provider: JSON.stringify({ provider_type: "openai" }), modelId: "gpt-saved" });
  });

  it("concurrent startup loads attach one listener and await the same backend sync", async () => {
    vi.resetModules();
    const { useConfigStore } = await import("./configStore");
    await Promise.all([useConfigStore.getState().loadConfig(), useConfigStore.getState().loadConfig()]);
    expect(keyListeners.filter((listener) => listener.key === "activeLLMSelection")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === "set_llm_provider")).toHaveLength(1);
    expect(useConfigStore.getState()._loaded).toBe(true);
  });

  it("a delayed startup credential read cannot replace a later user selection", async () => {
    saved.set("llmProvider", "openai"); saved.set("llmModel", "old-model");
    let release!: (key: string) => void;
    invoke.mockImplementation(async (command: string) => command === "get_api_key" ? new Promise<string>((resolve) => { release = resolve; }) : null);
    vi.resetModules();
    const { useConfigStore } = await import("./configStore");
    const loading = useConfigStore.getState().loadConfig();
    await vi.waitFor(() => expect(release).toBeDefined());
    await useConfigStore.getState().activateLLMProvider("groq", { model: "new-model", providerConfig: JSON.stringify({ provider_type: "groq", api_key: "test-key" }) });
    release("old-key"); await loading;
    expect(useConfigStore.getState()).toMatchObject({ llmProvider: "groq", llmModel: "new-model" });
    const calls = invoke.mock.calls.filter(([command]) => command === "set_llm_provider");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ modelId: "new-model" });
    invoke.mockImplementation(async () => null);
  });
});

describe("configStore: stealth mode and the custom endpoint across windows", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    invoke.mockReset();
    invoke.mockImplementation(async () => null);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stealth mode applies to the backend, reaches the other window and is restored on the next start", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "set_stealth_mode") {
        const enabled = (args as {enabled:boolean}).enabled;
        saved.set("stealthMode", enabled);
        for (const listener of keyListeners) if (listener.key === "stealthMode") listener.cb(enabled);
      }
      return null;
    });
    await launcher.getState().setStealthMode(true);
    expect(invoke).toHaveBeenCalledWith("set_stealth_mode", { enabled: true });
    await vi.waitFor(() => expect(overlay.getState().stealthMode).toBe(true));

    invoke.mockClear();
    const reopened = await openWindow();
    expect(reopened.getState().stealthMode).toBe(true);
    expect(invoke.mock.calls.some(([command]) => command === "set_stealth_mode")).toBe(false);
  });

  it("a refused stealth change leaves the setting as it was", async () => {
    const launcher = await openWindow();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_stealth_mode") throw new Error("not supported");
      return null;
    });
    await expect(launcher.getState().setStealthMode(true)).rejects.toThrow("not supported");
    expect(launcher.getState().stealthMode).toBe(false);
    expect(saved.has("stealthMode")).toBe(false);
  });

  it("background shortcuts propagate to the other window and survive reopening", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    const bindings = { ...launcher.getState().backgroundShortcuts, screen: "CmdOrCtrl+Alt+9" };
    launcher.getState().setBackgroundShortcuts(bindings);
    await vi.waitFor(() => expect(overlay.getState().backgroundShortcuts).toEqual(bindings));
    const reopened = await openWindow();
    expect(reopened.getState().backgroundShortcuts).toEqual(bindings);
  });

  it("activating the custom provider sends the saved endpoint and token", async () => {
    const launcher = await openWindow();
    launcher.getState().setCustomLlmConfig("http://localhost:8000/v1", "bearer");
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_api_key" ? "tok" : null));
    await launcher.getState().activateLLMProvider("custom", { model: "m" });
    expect(invoke).toHaveBeenCalledWith("set_llm_provider", {
      provider: JSON.stringify({ provider_type: "custom", base_url: "http://localhost:8000/v1", auth_type: "bearer", auth_value: "tok" }), modelId: "m",
    });
  });
});
