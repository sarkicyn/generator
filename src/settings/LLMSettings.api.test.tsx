import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("./ClaudeCliSettings", () => ({
  ClaudeCliSettings: () => null,
  claudeTierLabel: () => "Claude",
}));
vi.mock("./openrouter/OpenRouterModelCatalog", () => ({ OpenRouterModelCatalog: () => null }));

const ipc = vi.hoisted(() => ({
  getApiKey: vi.fn(),
  storeApiKey: vi.fn(),
  testLLMConnection: vi.fn(),
  listModels: vi.fn(),
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  storeApiKey: (...args: unknown[]) => ipc.storeApiKey(...args),
  testLLMConnection: (...args: unknown[]) => ipc.testLLMConnection(...args),
  listModels: (...args: unknown[]) => ipc.listModels(...args),
  hasApiKey: async () => false,
}));

import { LLMSettings } from "./LLMSettings";
import { useConfigStore } from "../stores/configStore";

describe("подключение моделей по API-ключам", () => {
  const activate = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getApiKey.mockResolvedValue(null);
    ipc.storeApiKey.mockResolvedValue(undefined);
    ipc.testLLMConnection.mockResolvedValue(true);
    ipc.listModels.mockResolvedValue([]);
    useConfigStore.setState({
      llmProvider: "ollama", llmModel: "llama3.2", lastModelByProvider: { ollama: "llama3.2" },
      activateLLMProvider: activate, verifiedCloudProviders: [],
      customLlmBaseUrl: "", customLlmAuthType: "none",
    });
  });
  afterEach(() => cleanup());

  async function chooseProvider(name: RegExp) {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
  }

  it("хранит ключи разных сервисов отдельно и восстанавливает их при переключении", async () => {
    const keys = new Map<string, string>();
    ipc.getApiKey.mockImplementation(async (provider: string) => keys.get(provider) ?? null);
    ipc.storeApiKey.mockImplementation(async (provider: string, key: string) => { keys.set(provider, key); });
    render(<LLMSettings />);
    await chooseProvider(/^OpenAI/);
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "  first-key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
    await screen.findByRole("button", { name: "Ключ сохранён" });
    await chooseProvider(/^Google Gemini/);
    expect(screen.getByLabelText("API-ключ")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "second-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
    await screen.findByRole("button", { name: "Ключ сохранён" });
    await chooseProvider(/^OpenAI/);
    expect(screen.getByLabelText("API-ключ")).toHaveValue("first-key");
    expect(keys.get("gemini")).toBe("second-key");
  });

  it("подключает точный ID модели собственного совместимого API без загрузки списка", async () => {
    render(<LLMSettings />);
    await chooseProvider(/^Свой сервис/);
    fireEvent.change(screen.getByLabelText("Адрес API"), { target: { value: "https://models.example.test/v1/" } });
    fireEvent.change(screen.getByLabelText("Способ авторизации"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText("Ключ своего сервиса"), { target: { value: " custom-key " } });
    fireEvent.change(screen.getByLabelText("Идентификатор модели"), { target: { value: " custom/model-v2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Подключить модель" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("custom", {
      model: "custom/model-v2",
      providerConfig: JSON.stringify({ provider_type: "custom", base_url: "https://models.example.test/v1", auth_type: "bearer", auth_value: "custom-key" }),
    }));
    expect(ipc.storeApiKey).toHaveBeenCalledWith("custom", "custom-key");
    expect(ipc.listModels).not.toHaveBeenCalled();
  });

  it("заполняет FreeCodex без переноса ключа и подключает его только по явному действию", async () => {
    ipc.getApiKey.mockResolvedValue("another-service-key");
    useConfigStore.setState({ customLlmBaseUrl: "https://another.example.test/v1", verifiedCloudProviders: ["custom"] });
    render(<LLMSettings />);
    await chooseProvider(/^Свой сервис/);
    fireEvent.click(screen.getByRole("button", { name: "Настроить FreeCodex" }));

    expect(screen.getByLabelText("Адрес API")).toHaveValue("https://freecodex.fun/v1");
    expect(screen.getByLabelText("Способ авторизации")).toHaveValue("bearer");
    expect(screen.getByLabelText("Идентификатор модели")).toHaveValue("gpt-5.6-luna");
    expect(screen.getByLabelText("Ключ своего сервиса")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Подключить модель" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Проверить подключение" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Загрузить модели" })).toBeDisabled();
    expect(screen.getByText(/распознавание речи подключается отдельно/)).toBeInTheDocument();
    expect(useConfigStore.getState().customLlmBaseUrl).toBe("https://another.example.test/v1");
    expect(useConfigStore.getState().customLlmAuthType).toBe("none");
    expect(useConfigStore.getState().verifiedCloudProviders).toContain("custom");
    expect(activate).not.toHaveBeenCalled();
    expect(ipc.storeApiKey).not.toHaveBeenCalled();
    expect(ipc.testLLMConnection).not.toHaveBeenCalled();
    expect(ipc.listModels).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Ключ своего сервиса"), { target: { value: "freecodex-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Подключить модель" }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith("custom", {
      model: "gpt-5.6-luna",
      providerConfig: JSON.stringify({ provider_type: "custom", base_url: "https://freecodex.fun/v1", auth_type: "bearer", auth_value: "freecodex-test-key" }),
    }));
    expect(ipc.storeApiKey).toHaveBeenCalledWith("custom", "freecodex-test-key");
    expect(useConfigStore.getState().customLlmBaseUrl).toBe("https://freecodex.fun/v1");
    expect(useConfigStore.getState().customLlmAuthType).toBe("bearer");
    expect(useConfigStore.getState().verifiedCloudProviders).not.toContain("custom");
  });

  it("не подставляет поздно загруженный ключ другого адреса после выбора FreeCodex", async () => {
    let resolveCustom!: (value: string) => void;
    ipc.getApiKey.mockImplementation(() => new Promise<string>((resolve) => { resolveCustom = resolve; }));
    render(<LLMSettings />);
    await chooseProvider(/^Свой сервис/);
    fireEvent.click(screen.getByRole("button", { name: "Настроить FreeCodex" }));
    fireEvent.change(screen.getByLabelText("Ключ своего сервиса"), { target: { value: "entered-freecodex-key" } });
    await act(async () => { resolveCustom("another-service-key"); });
    expect(screen.getByLabelText("Ключ своего сервиса")).toHaveValue("entered-freecodex-key");
    expect(ipc.storeApiKey).not.toHaveBeenCalled();
  });

  it("выбор модели OpenAI сразу применяет провайдера вместо прежней Ollama", async () => {
    ipc.listModels.mockResolvedValue([{ id: "gpt-test", name: "GPT Test" }]);
    render(<LLMSettings />);
    await chooseProvider(/^OpenAI/);
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "openai-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Загрузить модели" }));
    await screen.findByRole("option", { name: "GPT Test" });
    fireEvent.change(screen.getByLabelText("Выбор модели ИИ"), { target: { value: "gpt-test" } });
    await waitFor(() => expect(activate).toHaveBeenCalledWith("openai", {
      model: "gpt-test", providerConfig: JSON.stringify({ provider_type: "openai", api_key: "openai-test-key" }),
    }));
    expect(ipc.storeApiKey).toHaveBeenCalledWith("openai", "openai-test-key");
  });

  it("не проверяет подключение, если защищённое сохранение ключа завершилось ошибкой", async () => {
    ipc.storeApiKey.mockRejectedValue(new Error("Хранилище недоступно"));
    render(<LLMSettings />);
    await chooseProvider(/^OpenAI/);
    fireEvent.change(screen.getByLabelText("API-ключ"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить подключение" }));
    await screen.findByText("Хранилище недоступно");
    expect(ipc.testLLMConnection).not.toHaveBeenCalled();
  });

  it("поздний ответ хранилища для прошлого сервиса не заменяет ключ выбранного сервиса", async () => {
    let resolveOpenAI!: (value: string) => void;
    ipc.getApiKey.mockImplementation((provider: string) => provider === "openai"
      ? new Promise<string>((resolve) => { resolveOpenAI = resolve; })
      : Promise.resolve("groq-key"));
    render(<LLMSettings />);
    await chooseProvider(/^OpenAI/);
    await chooseProvider(/^Groq/);
    expect(screen.getByLabelText("API-ключ")).toHaveValue("groq-key");
    await act(async () => { resolveOpenAI("old-openai-key"); });
    expect(screen.getByLabelText("API-ключ")).toHaveValue("groq-key");
  });
});
