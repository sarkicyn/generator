import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runUserAction, stopUserActions } = vi.hoisted(() => ({ runUserAction: vi.fn(async () => {}), stopUserActions: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));
vi.mock("../lib/userAction", async (original) => ({
  ...await original<typeof import("../lib/userAction")>(),
  runUserAction, stopUserActions,
}));

import { ModeButtons } from "./ModeButtons";
import { useStreamStore } from "../stores/streamStore";
import { useConfigStore } from "../stores/configStore";

describe("ModeButtons cancellation", () => {
  beforeEach(() => {
    runUserAction.mockClear();
    stopUserActions.mockClear();
    useStreamStore.getState().resetForMeeting();
    useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 } });
  });

  it("uses the same replacement action as Space while native preparation is still sending", () => {
    render(<ModeButtons />);
    act(() => useStreamStore.getState().setPending("Assist", "preparing"));
    const assist = screen.getByRole("button", { name: /Подсказка.*Пробел/ });
    expect(assist).toBeEnabled();
    expect(screen.getByRole("button", { name: /Итоги.*4/ })).toBeDisabled();
    fireEvent.click(assist);
    expect(runUserAction).toHaveBeenCalledExactlyOnceWith("Assist");
    expect(stopUserActions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Остановить ответ" }));
    expect(stopUserActions).toHaveBeenCalledOnce();
  });

  it("retains cancellation after the model starts streaming", () => {
    render(<ModeButtons />);
    act(() => useStreamStore.getState().startStream("Recap", "gpt-4.1", "OpenAI", { requestId: "streaming" }));
    fireEvent.click(screen.getByRole("button", { name: /Итоги.*4/ }));
    expect(stopUserActions).toHaveBeenCalledOnce();
  });

  it("lets a new full typed request replace another mode's running answer", () => {
    render(<ModeButtons />);
    act(() => useStreamStore.getState().startStream("Recap", "model", "provider", { requestId: "old" }));
    expect(screen.getByRole("button", { name: /Подсказка.*Пробел/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Спросить.*5/ }));
    const input = screen.getByRole("textbox", { name: "Задать вопрос" });
    fireEvent.change(input, { target: { value: "Что такое стек? Чем он отличается от кучи?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runUserAction).toHaveBeenCalledExactlyOnceWith("AskQuestion", "Что такое стек? Чем он отличается от кучи?");
  });
});
