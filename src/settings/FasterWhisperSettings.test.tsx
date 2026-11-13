import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const check = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", () => ({ getFasterWhisperStatus: check, updateFasterWhisperConfig: async () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ set: async () => {} }) }));
import { FasterWhisperSettings } from "./FasterWhisperSettings";
import { DEFAULT_FASTER_WHISPER_CONFIG, useConfigStore } from "../stores/configStore";
beforeEach(() => {
  check.mockReset();
  useConfigStore.setState({ fasterWhisperConfig: { ...DEFAULT_FASTER_WHISPER_CONFIG }, activeModelPerEngine: { faster_whisper: "voxta/faster-whisper-large-v3-turbo-int8" } });
});
afterEach(cleanup);
it("keeps language, terms and hardware independently configurable", async () => {
  const user = userEvent.setup(); render(<FasterWhisperSettings />);
  await user.selectOptions(screen.getByLabelText("Язык Faster Whisper"), "ru");
  await user.selectOptions(screen.getByLabelText("Устройство Faster Whisper"), "cpu");
  await user.selectOptions(screen.getByLabelText("Качество Faster Whisper"), "fast");
  await user.type(screen.getByLabelText("Термины Faster Whisper"), "Large Object Heap");
  expect(useConfigStore.getState().fasterWhisperConfig).toMatchObject({ language: "ru", device: "cpu", quality: "fast", computeType: "auto", hotwords: "Large Object Heap" });
});
it("reports the actual fallback device and checks the selected model", async () => {
  check.mockResolvedValue({ device: "cpu", compute_type: "int8", warning: "CUDA unavailable" });
  const user = userEvent.setup(); render(<FasterWhisperSettings />);
  await user.click(screen.getByRole("button", { name: "Проверить движок и устройство" }));
  expect(await screen.findByRole("status")).toHaveTextContent("процессор CPU, int8");
  expect(screen.getByRole("status")).toHaveTextContent("обработка может отставать");
  expect(check).toHaveBeenCalledWith("voxta/faster-whisper-large-v3-turbo-int8");
});
it("shows a model error and allows retry", async () => {
  check.mockRejectedValue(new Error("Модель не скачана"));
  const user = userEvent.setup(); render(<FasterWhisperSettings />);
  const button = screen.getByRole("button", { name: "Проверить движок и устройство" });
  await user.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent("Модель не скачана");
  expect(button).toBeEnabled();
});
