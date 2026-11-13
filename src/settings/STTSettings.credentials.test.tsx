import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("./LocalModelManager", () => ({ LocalModelManager: () => null }));
const { keys, ipc } = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  ipc: {
    getApiKey: vi.fn(), hasApiKey: vi.fn(), storeApiKey: vi.fn(), deleteApiKey: vi.fn(),
    testSTTConnection: vi.fn(), setSTTProvider: vi.fn(),
  },
}));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getApiKey: (...args: unknown[]) => ipc.getApiKey(...args),
  hasApiKey: (...args: unknown[]) => ipc.hasApiKey(...args),
  storeApiKey: (...args: unknown[]) => ipc.storeApiKey(...args),
  deleteApiKey: (...args: unknown[]) => ipc.deleteApiKey(...args),
  testSTTConnection: (...args: unknown[]) => ipc.testSTTConnection(...args),
  setSTTProvider: (...args: unknown[]) => ipc.setSTTProvider(...args),
  listLocalSTTEngines: async () => [],
}));
import { STTSettings } from "./STTSettings";
import { useConfigStore } from "../stores/configStore";

beforeEach(() => {
  keys.clear();
  vi.clearAllMocks();
  ipc.getApiKey.mockImplementation(async (key: string) => keys.get(key) ?? null);
  ipc.hasApiKey.mockImplementation(async (key: string) => keys.has(key));
  ipc.storeApiKey.mockImplementation(async (key: string, value: string) => { keys.set(key, value); });
  ipc.deleteApiKey.mockImplementation(async (key: string) => { keys.delete(key); });
  ipc.testSTTConnection.mockResolvedValue(true);
  ipc.setSTTProvider.mockResolvedValue(undefined);
  useConfigStore.setState({ sttProvider: "whisper_api", sttLanguage: "ru-RU", meetingAudioConfig: null, verifiedCloudProviders: [] });
});
afterEach(cleanup);
async function enterAndTest(value: string) {
  fireEvent.change(screen.getByLabelText("API-ключ распознавания речи"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить и проверить" }));
}
async function chooseProvider(name: RegExp) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

describe("STT credential replacement", () => {
  it("names the direct OpenAI endpoint and the required key before Whisper API testing", async () => {
    render(<STTSettings />);
    await act(async () => {});
    expect(screen.getByText("Напрямую OpenAI, нужен ключ OpenAI")).toBeInTheDocument();
    const field = screen.getByLabelText("API-ключ распознавания речи");
    expect(field).toHaveAccessibleDescription(/напрямую к OpenAI \(api.openai.com\)/);
    expect(field).toHaveAccessibleDescription(/Ключи FreeCodex и других посредников.*не подходят/);
    expect(screen.getByText("Провайдер ответов ИИ и провайдер распознавания речи настраиваются отдельно.")).toBeInTheDocument();
    await chooseProvider(/^Deepgram/);
    expect(screen.getByLabelText("API-ключ распознавания речи")).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/Whisper API подключается напрямую/)).not.toBeInTheDocument();
    expect(ipc.testSTTConnection).not.toHaveBeenCalled();
  });

  it("restores a prior key and readiness after rejected replacement, keeping the entered candidate", async () => {
    keys.set("whisper_api", "old-test-key");
    useConfigStore.setState({ verifiedCloudProviders: ["openai", "whisper_api"] });
    ipc.testSTTConnection.mockRejectedValue("HTTP 403: разрешите доступ к распознаванию речи");
    render(<STTSettings />);
    await waitFor(() => expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("old-test-key"));
    await enterAndTest("new-test-key");
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("HTTP 403");
    expect(error).toHaveTextContent("Прежний сохранённый ключ восстановлен");
    expect(keys.get("whisper_api")).toBe("old-test-key");
    expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("new-test-key");
    expect(useConfigStore.getState().verifiedCloudProviders).toEqual(["openai", "whisper_api"]);
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
  });

  it("removes only the failed temporary candidate when no previous key exists", async () => {
    keys.set("openai", "separate-llm-key");
    ipc.testSTTConnection.mockResolvedValue(false);
    render(<STTSettings />);
    await act(async () => {});
    await enterAndTest("bad-test-key");
    expect(await screen.findByRole("alert")).toHaveTextContent("Новый ключ не сохранён");
    expect(keys.has("whisper_api")).toBe(false);
    expect(keys.get("openai")).toBe("separate-llm-key");
    expect(ipc.deleteApiKey).toHaveBeenCalledWith("whisper_api");
    expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("bad-test-key");
  });

  it("keeps a successful trimmed key and marks only that provider verified", async () => {
    useConfigStore.setState({ verifiedCloudProviders: ["openai"] });
    render(<STTSettings />);
    await act(async () => {});
    await enterAndTest("  valid-test-key  ");
    await screen.findByText("Соединение установлено — провайдер готов");
    expect(keys.get("whisper_api")).toBe("valid-test-key");
    expect(useConfigStore.getState().verifiedCloudProviders).toEqual(["openai", "whisper_api"]);
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
  });

  it("does not lose the old key if writing a replacement fails", async () => {
    keys.set("whisper_api", "old-test-key");
    ipc.storeApiKey.mockImplementation(async (key: string, value: string) => {
      if (value === "new-test-key") throw new Error("Хранилище Windows недоступно");
      keys.set(key, value);
    });
    render(<STTSettings />);
    await waitFor(() => expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("old-test-key"));
    await enterAndTest("new-test-key");
    expect(await screen.findByRole("alert")).toHaveTextContent("Хранилище Windows недоступно");
    expect(keys.get("whisper_api")).toBe("old-test-key");
    expect(ipc.testSTTConnection).not.toHaveBeenCalled();
    expect(ipc.deleteApiKey).not.toHaveBeenCalled();
  });

  it("does not let a late key read overwrite another provider or freshly typed input", async () => {
    keys.set("whisper_api", "old-test-key");
    keys.set("deepgram", "deepgram-test-key");
    let resolveOld!: (value: string) => void;
    ipc.getApiKey.mockImplementation((key: string) => key === "whisper_api"
      ? new Promise<string>(resolve => { resolveOld = resolve; }) : Promise.resolve(keys.get(key) ?? null));
    render(<STTSettings />);
    await waitFor(() => expect(ipc.getApiKey).toHaveBeenCalledWith("whisper_api"));
    await chooseProvider(/^Deepgram/);
    await waitFor(() => expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("deepgram-test-key"));
    fireEvent.change(screen.getByLabelText("API-ключ распознавания речи"), { target: { value: "draft-deepgram-key" } });
    await act(async () => { resolveOld("old-test-key"); });
    expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("draft-deepgram-key");
  });

  it("does not apply a late test result to the newly selected provider", async () => {
    keys.set("whisper_api", "old-test-key");
    keys.set("deepgram", "deepgram-test-key");
    let rejectTest!: (error: Error) => void;
    ipc.testSTTConnection.mockImplementation(() => new Promise<boolean>((_, reject) => { rejectTest = reject; }));
    render(<STTSettings />);
    await waitFor(() => expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("old-test-key"));
    await enterAndTest("candidate-test-key");
    await waitFor(() => expect(ipc.testSTTConnection).toHaveBeenCalled());
    await chooseProvider(/^Deepgram/);
    await waitFor(() => expect(screen.getByLabelText("API-ключ распознавания речи")).toHaveValue("deepgram-test-key"));
    await act(async () => { rejectTest(new Error("HTTP 401")); });
    await waitFor(() => expect(keys.get("whisper_api")).toBe("old-test-key"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(keys.get("deepgram")).toBe("deepgram-test-key");
  });

  it("never displays a key accidentally echoed by an error", async () => {
    ipc.testSTTConnection.mockRejectedValue("HTTP 401 for Bearer sk-secret-test-value");
    render(<STTSettings />);
    await act(async () => {});
    await enterAndTest("sk-secret-test-value");
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("HTTP 401");
    expect(error.textContent).not.toContain("sk-secret-test-value");
  });

  it("restores the old Azure region together with a failed key replacement", async () => {
    useConfigStore.setState({ sttProvider: "azure_speech" });
    keys.set("azure_speech", "azure-old-key");
    keys.set("azure_speech_region", "westeurope");
    ipc.testSTTConnection.mockResolvedValue(false);
    render(<STTSettings />);
    await waitFor(() => expect(screen.getByDisplayValue("westeurope")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("westeurope"), { target: { value: "eastus" } });
    await enterAndTest("azure-new-key");
    await screen.findByRole("alert");
    expect(keys.get("azure_speech")).toBe("azure-old-key");
    expect(keys.get("azure_speech_region")).toBe("westeurope");
  });
});
