import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptRow, type TranscriptRowProps } from "./TranscriptRow";
import { TRANSCRIPT_SINGLE_CLICK_DELAY_MS } from "../../hooks/useTranscriptAsk";

function props(overrides: Partial<TranscriptRowProps> = {}): TranscriptRowProps {
  return {
    segment: {
      id: "s1",
      text: "We ship on Friday",
      speaker: "Them",
      speaker_id: "them",
      speaker_tag: "S2",
      timestamp_ms: 1,
      is_final: true,
      confidence: 1,
      mergedCount: 1,
      originalIds: ["s1"],
    },
    index: 0,
    isActive: false,
    isSelected: false,
    isBookmarked: false,
    searchQuery: "",
    isSearchMatch: false,
    timestampLabel: "0:01",
    speakerLabel: "Speaker 2",
    speakerColorClass: "",
    transcriptFontSize: 13,
    transcriptTextColor: "#fff",
    translationFontSize: 12,
    translationTextColor: "#fb0",
    canBookmark: false,
    onSeek: vi.fn(),
    onToggleBookmark: vi.fn(),
    ...overrides,
  };
}

describe("TranscriptRow remote speaker name", () => {
  it("renames the speaker on click + Enter without seeking", () => {
    const onRenameSpeaker = vi.fn();
    const onSeek = vi.fn();
    render(<TranscriptRow {...props({ renameKey: "them:S2", onRenameSpeaker, onSeek })} />);

    fireEvent.click(screen.getByRole("button", { name: "Speaker 2" }));
    const input = screen.getByLabelText("Имя участника");
    fireEvent.change(input, { target: { value: "  Erin " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameSpeaker).toHaveBeenCalledWith("them:S2", "Erin");
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("Escape keeps the name", () => {
    const onRenameSpeaker = vi.fn();
    render(<TranscriptRow {...props({ renameKey: "them:S2", onRenameSpeaker })} />);
    fireEvent.click(screen.getByRole("button", { name: "Speaker 2" }));
    const input = screen.getByLabelText("Имя участника");
    fireEvent.change(input, { target: { value: "Erin" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Speaker 2" })).toBeTruthy();
  });

  it("other speakers are plain labels", () => {
    render(<TranscriptRow {...props()} />);
    expect(screen.queryByRole("button", { name: "Speaker 2" })).toBeNull();
    expect(screen.getByText("Speaker 2")).toBeTruthy();
  });
});

describe("TranscriptRow ask from text", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });
  const firePendingClick = () => act(() => { vi.advanceTimersByTime(TRANSCRIPT_SINGLE_CLICK_DELAY_MS); });

  it("asks once for the exact clicked phrase without seeking audio", () => {
    const onAskSegment = vi.fn(), onSeek = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment, onSeek })} />);
    fireEvent.click(screen.getByRole("button", { name: "Спросить ИИ о фразе: We ship on Friday" }), { detail: 1 });
    firePendingClick();
    expect(onAskSegment).toHaveBeenCalledExactlyOnceWith("s1", "We ship on Friday");
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("keeps timestamp, translation, bookmark and speaker controls separate from asking", () => {
    const onAskSegment = vi.fn(), onSeek = vi.fn(), onTranslate = vi.fn(), onToggleBookmark = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment, onSeek, onTranslate, onToggleBookmark, currentTargetLang: "ru", canBookmark: true, renameKey: "them:S2", onRenameSpeaker: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перейти к аудио: 0:01" }));
    fireEvent.click(screen.getByRole("button", { name: "Перевести на RU" }));
    fireEvent.click(screen.getByRole("button", { name: "Добавить закладку к этой строке" }));
    fireEvent.click(screen.getByRole("button", { name: "Speaker 2" }));
    firePendingClick();
    expect(onSeek).toHaveBeenCalledExactlyOnceWith("s1");
    expect(onTranslate).toHaveBeenCalledExactlyOnceWith("s1", "We ship on Friday");
    expect(onToggleBookmark).toHaveBeenCalledExactlyOnceWith("s1");
    expect(onAskSegment).not.toHaveBeenCalled();
  });

  it("cancels the first click of a double-click so words can be selected", () => {
    const onAskSegment = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment })} />);
    const phrase = screen.getByRole("button", { name: /Спросить ИИ о фразе/ });
    fireEvent.click(phrase, { detail: 1 });
    fireEvent.click(phrase, { detail: 2 });
    fireEvent.doubleClick(phrase);
    firePendingClick();
    expect(onAskSegment).not.toHaveBeenCalled();
  });

  it.each([300, 499])("waits for a slower double-click with %i ms between clicks", (interval) => {
    const onAskSegment = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment })} />);
    const phrase = screen.getByRole("button", { name: /Спросить ИИ о фразе/ });
    fireEvent.click(phrase, { detail: 1 });
    act(() => { vi.advanceTimersByTime(interval); });
    expect(onAskSegment).not.toHaveBeenCalled();
    fireEvent.click(phrase, { detail: 2 });
    fireEvent.doubleClick(phrase);
    firePendingClick();
    expect(onAskSegment).not.toHaveBeenCalled();
  });

  it("does not ask when text has been selected, including selection started after a click", () => {
    const onAskSegment = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment })} />);
    const phrase = screen.getByRole("button", { name: /Спросить ИИ о фразе/ });
    fireEvent.click(phrase, { detail: 1 });
    const range = document.createRange();
    range.selectNodeContents(phrase);
    window.getSelection()?.addRange(range);
    firePendingClick();
    fireEvent.click(phrase, { detail: 1 });
    firePendingClick();
    expect(onAskSegment).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("asks immediately with %s and does not bubble into audio shortcuts", (key) => {
    const onAskSegment = vi.fn(), keyboardHandler = vi.fn();
    render(<TranscriptRow {...props({ onAskSegment })} />);
    window.addEventListener("keydown", keyboardHandler);
    try {
      fireEvent.keyDown(screen.getByRole("button", { name: /Спросить ИИ о фразе/ }), { key });
      expect(onAskSegment).toHaveBeenCalledExactlyOnceWith("s1", "We ship on Friday");
      expect(keyboardHandler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", keyboardHandler);
    }
  });

  it("does not ask on modifier-click, a repeated key or after the row was unmounted", () => {
    const onAskSegment = vi.fn();
    const view = render(<TranscriptRow {...props({ onAskSegment })} />);
    const phrase = screen.getByRole("button", { name: /Спросить ИИ о фразе/ });
    fireEvent.click(phrase, { detail: 1, ctrlKey: true });
    fireEvent.keyDown(phrase, { key: "Enter", repeat: true });
    firePendingClick();
    expect(onAskSegment).not.toHaveBeenCalled();
    fireEvent.click(phrase, { detail: 1 });
    view.unmount();
    firePendingClick();
    expect(onAskSegment).not.toHaveBeenCalled();
  });
});
