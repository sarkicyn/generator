import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, TranscriptSegment } from "../lib/types";

const runUserAction = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const toggleBookmark = vi.hoisted(() => vi.fn());
vi.mock("../lib/userAction", () => ({ runUserAction: (...args: unknown[]) => runUserAction(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {}, save: async () => {}, onKeyChange: async () => () => {} }) }));
vi.mock("../hooks/useAudioLevel", () => ({ useAudioLevel: () => ({ micLevel: 0, systemLevel: 0 }) }));
vi.mock("./SpeakerNamingBanner", () => ({ SpeakerNamingBanner: () => null }));
vi.mock("../components/ColorPickerButton", () => ({ ColorPickerButton: () => null }));
vi.mock("../stores/bookmarkStore", () => ({
  useBookmarkStore: Object.assign((select: (s: unknown) => unknown) => select({
    getBookmarkForSegment: () => undefined, toggleBookmark,
  }), { getState: () => ({ addBookmark: () => ({ id: "bookmark" }) }) }),
}));
vi.mock("../stores/translationStore", () => ({ useTranslationStore: (select: (s: unknown) => unknown) => select({
  translations: new Map(), translating: new Set(), displayMode: "inline", autoTranslateActive: false,
}) }));

import { TranscriptPanel } from "./TranscriptPanel";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useStreamStore } from "../stores/streamStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { TRANSCRIPT_SINGLE_CLICK_DELAY_MS } from "../hooks/useTranscriptAsk";

const meeting: Meeting = {
  id: "live-a", title: "Synthetic test", start_time: "2026-10-28T10:00:00Z",
  end_time: null, duration_seconds: null, transcript: [], ai_interactions: [], summary: null, config_snapshot: null,
};
const first: TranscriptSegment = { id: "a", text: "Что такое первый депозит?", speaker: "User", speaker_id: "you", timestamp_ms: 1000, is_final: true, confidence: 0.9 };
const second: TranscriptSegment = { ...first, id: "b", text: "Объясни коэффициент конверсии", timestamp_ms: 10000 };
const advanceClick = () => act(() => vi.advanceTimersByTime(TRANSCRIPT_SINGLE_CLICK_DELAY_MS + 1));

beforeEach(() => {
  vi.useFakeTimers();
  runUserAction.mockClear();
  runUserAction.mockResolvedValue(undefined);
  toggleBookmark.mockClear();
  useSpeakerStore.getState().initForOnline();
  useMeetingStore.setState({ activeMeeting: meeting, isRecording: true, audioMode: "online", meetingStartTime: 1000 });
  useTranscriptStore.setState({ segments: [first, second], searchQuery: "", autoScroll: false, selectedSegmentIds: [] });
  useStreamStore.getState().resetForMeeting();
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe("asking from the live transcript", () => {
  it("shows one checkbox for a long continuous own answer and its growing tail", () => {
    useTranscriptStore.setState({ segments: [
      { ...first, id: "a", text: "Первая часть", timestamp_ms: 1000, duration_ms: 20000 },
      { ...first, id: "b", text: "Вторая часть", timestamp_ms: 21000, duration_ms: 20000 },
      { ...first, id: "c", text: "Продолжение", timestamp_ms: 41000, duration_ms: 4000, is_final: false },
    ] });
    render(<TranscriptPanel />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("Первая часть Вторая часть")).toBeInTheDocument();
    expect(screen.getByText("Продолжение")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["a", "b", "c"]);
  });
  it("checks multiple fragments without sending them and can clear the selection", () => {
    render(<TranscriptPanel />);
    const firstBox = screen.getByRole("checkbox", { name: `Выбрать фрагмент: ${first.text}` });
    fireEvent.click(firstBox);
    fireEvent.click(screen.getByRole("checkbox", { name: `Выбрать фрагмент: ${second.text}` }));
    advanceClick();
    expect(firstBox).toBeChecked();
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["a", "b"]);
    expect(screen.getByText(/Выбрано: 2/)).toBeInTheDocument();
    expect(runUserAction).not.toHaveBeenCalled();
    fireEvent.click(firstBox);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["b"]);
    fireEvent.click(screen.getByRole("button", { name: "Снять выбор" }));
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  });

  it("selects all original fragments in a displayed block without selecting newly arriving speech", () => {
    useTranscriptStore.setState({ segments: [first, { ...second, timestamp_ms: 2000 }] });
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["a", "b"]);
    act(() => useTranscriptStore.getState().appendSegment({ ...second, id: "c", text: "Новая фраза", timestamp_ms: 2500 }));
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["a", "b"]);
    fireEvent.click(box);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["a", "b", "c"]);
    advanceClick();
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("sends the clicked phrase once and reveals its answer panel", () => {
    const revealAnswer = vi.fn();
    runUserAction.mockImplementationOnce(async () => { useStreamStore.setState({ phase: "sending" }); });
    render(<TranscriptPanel onQuestionSent={revealAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: `Спросить ИИ: ${first.text}` }));
    expect(runUserAction).not.toHaveBeenCalled();
    advanceClick();
    expect(runUserAction).toHaveBeenCalledExactlyOnceWith("AskQuestion", first.text);
    expect(revealAnswer).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: `Спросить ИИ: ${second.text}` }));
    advanceClick();
    expect(runUserAction).toHaveBeenCalledTimes(2);
    expect(runUserAction).toHaveBeenLastCalledWith("AskQuestion", second.text);
  });

  it("keeps double-click and drag selection from sending a question", () => {
    render(<TranscriptPanel />);
    const phrase = screen.getByRole("button", { name: `Спросить ИИ: ${first.text}` });
    fireEvent.click(phrase, { detail: 1 });
    fireEvent.doubleClick(phrase);
    advanceClick();
    expect(runUserAction).not.toHaveBeenCalled();
    const range = document.createRange();
    range.selectNodeContents(phrase);
    window.getSelection()?.addRange(range);
    fireEvent.click(phrase);
    advanceClick();
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("sends with the keyboard without waiting or repeating the request", () => {
    render(<TranscriptPanel />);
    const phrase = screen.getByRole("button", { name: `Спросить ИИ: ${first.text}` });
    fireEvent.keyDown(phrase, { key: "Enter" });
    fireEvent.keyDown(phrase, { key: "Enter", repeat: true });
    expect(runUserAction).toHaveBeenCalledExactlyOnceWith("AskQuestion", first.text);
  });

  it("submits a selected block for replacement while a different answer is streaming", () => {
    useStreamStore.setState({ isStreaming: true, phase: "writing" });
    render(<TranscriptPanel />);
    const phrase = screen.getByRole("button", { name: `Спросить ИИ: ${first.text}` });
    expect(phrase).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(phrase);
    fireEvent.keyDown(phrase, { key: " " });
    advanceClick();
    expect(runUserAction).toHaveBeenCalledExactlyOnceWith("AskQuestion", first.text);
  });

  it("does not send a delayed click into a different or ended meeting", () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByRole("button", { name: `Спросить ИИ: ${first.text}` }));
    act(() => useMeetingStore.setState({ activeMeeting: { ...meeting, id: "live-b" } }));
    advanceClick();
    expect(runUserAction).not.toHaveBeenCalled();
    act(() => useMeetingStore.setState({ isRecording: false }));
    fireEvent.click(screen.getByText(first.text));
    advanceClick();
    expect(runUserAction).not.toHaveBeenCalled();
  });

  it("leaves timestamp, speaker and bookmark interactions separate", () => {
    render(<TranscriptPanel />);
    fireEvent.click(screen.getByText("0:00"));
    fireEvent.click(screen.getAllByText("Вы")[0]);
    fireEvent.click(screen.getAllByTitle("Добавить закладку к этой строке")[0]);
    advanceClick();
    expect(toggleBookmark).toHaveBeenCalledOnce();
    expect(runUserAction).not.toHaveBeenCalled();
  });
});
