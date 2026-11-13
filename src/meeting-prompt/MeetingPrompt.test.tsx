import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingPrompt } from "./MeetingPrompt";
import type { MeetingPromptInfo } from "../lib/types";

const info = (over: Partial<MeetingPromptInfo["meeting"]> = {}, secs = 60): MeetingPromptInfo => ({
  meeting: { app: "zoom", app_name: "Zoom", title: null, ...over },
  auto_dismiss_secs: secs,
  default_scenario: "interview",
});

describe("MeetingPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 23, 15, 2));
  });
  afterEach(() => vi.useRealTimers());

  it("starts a meeting named after the call, with the default scenario", () => {
    const onStart = vi.fn();
    render(<MeetingPrompt info={info({ title: "Weekly sync" })} onStart={onStart} onDismiss={() => {}} />);
    expect(screen.getByText("Обнаружена встреча в Zoom")).toBeInTheDocument();
    expect(screen.getByLabelText("Название встречи")).toHaveValue("Weekly sync");
    fireEvent.click(screen.getByRole("button", { name: /Запустить NexQ/ }));
    expect(onStart).toHaveBeenCalledWith("Weekly sync — Встреча 2026-10-23 15:02", "interview");
  });

  it("uses the app's name without a title, and an edited name and type when given", () => {
    const onStart = vi.fn();
    render(<MeetingPrompt info={info()} onStart={onStart} onDismiss={() => {}} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStart).toHaveBeenLastCalledWith("Zoom — Встреча 2026-10-23 15:02", "interview");

    fireEvent.change(screen.getByLabelText("Название встречи"), { target: { value: "Board review" } });
    fireEvent.click(screen.getByRole("button", { name: /Тип встречи/ }));
    fireEvent.click(screen.getByRole("option", { name: /Рабочая встреча/ }));
    fireEvent.click(screen.getByRole("button", { name: /Запустить NexQ/ }));
    expect(onStart).toHaveBeenLastCalledWith("Board review — Встреча 2026-10-23 15:02", "team_meeting");
  });

  it("goes away after the timeout, but not while hovered; Escape dismisses", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info({}, 2)} onStart={() => {}} onDismiss={onDismiss} />);
    const card = screen.getByRole("dialog");
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(2100));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("stays until the call ends when the timeout is off", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info({}, 0)} onStart={() => {}} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(600_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("picks the meeting type from its menu with the keyboard, making room for it", () => {
    const onStart = vi.fn();
    const onMenuToggle = vi.fn();
    render(<MeetingPrompt info={info()} onStart={onStart} onDismiss={() => {}} onMenuToggle={onMenuToggle} />);
    const chevron = screen.getByRole("button", { name: "Тип встречи: Собеседование" });
    fireEvent.click(chevron);
    expect(onMenuToggle).toHaveBeenLastCalledWith(true);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("Собеседование");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Собеседование/ }));

    fireEvent.keyDown(window, { key: "ArrowDown" }); // Webinar
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onMenuToggle).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled(); // Enter chose, it didn't start

    fireEvent.click(screen.getByRole("button", { name: /Запустить NexQ/ }));
    expect(onStart).toHaveBeenLastCalledWith("Zoom — Встреча 2026-10-23 15:02", "webinar");
  });

  it("Escape closes the open menu without dismissing the prompt", () => {
    const onDismiss = vi.fn();
    render(<MeetingPrompt info={info()} onStart={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Тип встречи/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
