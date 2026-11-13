import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }) }));
vi.mock("../settings/ClaudeCliSettings", () => ({ claudeTierLabel: () => "Claude" }));
const ipc = vi.hoisted(() => ({ hasApiKey: vi.fn(), getApiKey: vi.fn(), listModels: vi.fn() }));
vi.mock("../lib/ipc", async (original) => ({
  ...(await original<typeof import("../lib/ipc")>()),
  hasApiKey: (...args: unknown[]) => ipc.hasApiKey(...args),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  listModels: (...args: unknown[]) => ipc.listModels(...args),
}));
import { LLMPickerDropdown } from "./ServiceStatusBar";
import { useConfigStore } from "../stores/configStore";
import { useAgentStore } from "../stores/agentStore";

describe("model selection from the main and meeting footer", () => {
  const apply = vi.fn(async () => {});
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.hasApiKey.mockImplementation(async (provider: string) => provider === "openai");
    ipc.getApiKey.mockResolvedValue("test-key");
    ipc.listModels.mockResolvedValue([]);
    useAgentStore.setState({ status: { installed: false } as never });
    useConfigStore.setState({ llmProvider: "ollama", llmModel: "", verifiedCloudProviders: [], lastModelByProvider: { openai: "gpt-saved" }, customLlmBaseUrl: "", customLlmAuthType: "none" });
  });
  afterEach(cleanup);

  it("offers saved-key OpenAI without a separate verification step and applies its model", async () => {
    ipc.listModels.mockResolvedValue([{ id: "org/full-model-id:latest", name: "Full model" }]);
    const view = render(<LLMPickerDropdown currentProvider="ollama" currentModel="" anchor={null} onApply={apply} onClose={() => {}} />);
    const openai = await screen.findByRole("button", { name: "OpenAI" });
    fireEvent.click(openai);
    await screen.findByText("Модели OpenAI");
    fireEvent.click(await screen.findByRole("button", { name: "Full model" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith("openai", "org/full-model-id:latest"));
    expect(view.container).not.toContainElement(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
  });

  it("keeps the selected model and permits a manual ID after listing fails", async () => {
    ipc.listModels.mockRejectedValue(new Error("offline"));
    render(<LLMPickerDropdown currentProvider="openai" currentModel="gpt-current-long-name" anchor={null} onApply={apply} onClose={() => {}} />);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Идентификатор модели")).toHaveValue("gpt-current-long-name");
    expect(screen.getByText(/Сейчас: OpenAI \/ gpt-current-long-name/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Идентификатор модели"), { target: { value: " manual-model " } });
    fireEvent.click(screen.getByRole("button", { name: "Применить модель" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith("openai", "manual-model"));
  });

  it("uses the stored endpoint and auth for custom model discovery", async () => {
    useConfigStore.setState({ customLlmBaseUrl: "https://models.example.test/v1", customLlmAuthType: "bearer" });
    render(<LLMPickerDropdown currentProvider="custom" currentModel="custom-model" anchor={null} onApply={apply} onClose={() => {}} />);
    await waitFor(() => expect(ipc.listModels).toHaveBeenCalledWith(JSON.stringify({ provider_type: "custom", base_url: "https://models.example.test/v1", auth_type: "bearer", auth_value: "test-key" })));
    expect(screen.queryByText("test-key")).not.toBeInTheDocument();
  });
});
