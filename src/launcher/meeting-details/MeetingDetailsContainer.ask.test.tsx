import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../../lib/types";

const state = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  getMeeting: vi.fn(),
  askMeeting: vi.fn(),
  cancelGeneration: vi.fn(),
  summaryBusy: false,
  generateSummary: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (!state.listeners.has(name)) state.listeners.set(name, new Set());
    state.listeners.get(name)!.add(handler);
    return () => state.listeners.get(name)?.delete(handler);
  },
}));
vi.mock("../../lib/ipc", async (original) => ({
  ...await original<typeof import("../../lib/ipc")>(),
  getMeeting: (...args: unknown[]) => state.getMeeting(...args),
  askMeeting: (...args: unknown[]) => state.askMeeting(...args),
  cancelGeneration: (...args: unknown[]) => state.cancelGeneration(...args),
  getRecordingInfo: async () => null,
  getAllMeetingTranslations: async () => [],
  listMeetingChat: async () => [],
  getAgentSessions: async () => [],
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    options: { count },
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 48 })),
    getTotalSize: () => count * 48,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));
vi.mock("./MeetingHeader", () => ({ MeetingHeader: ({ meeting }: { meeting: Meeting }) => <h1>{meeting.title}</h1> }));
vi.mock("../../hooks/useSummaryGeneration", () => ({ useSummaryGeneration: () => ({ isGenerating: state.summaryBusy, streamedContent: "", error: null, generate: state.generateSummary, cancel: () => {} }) }));
vi.mock("../../hooks/useActionItemsExtraction", () => ({ useActionItemsExtraction: () => ({ isExtracting: false, extract: async () => {}, error: null }) }));
vi.mock("../../hooks/useBookmarkSuggestions", () => ({ useBookmarkSuggestions: () => ({ isSuggesting: false, suggest: async () => {}, error: null, suggestions: [] }) }));

import { MeetingDetails } from "./MeetingDetailsContainer";
import { useConfigStore } from "../../stores/configStore";
import { useMeetingStore } from "../../stores/meetingStore";

function meeting(id: string, text: string): Meeting {
  return {
    id, title: `Meeting ${id}`, start_time: "2026-10-28T10:00:00Z", end_time: "2026-10-28T10:01:00Z", duration_seconds: 60,
    transcript: [
      { id: `${id}-1`, text, speaker: "Them", timestamp_ms: 1_000, is_final: true, confidence: 1 },
      { id: `${id}-2`, text: "Second phrase", speaker: "User", timestamp_ms: 2_000, is_final: true, confidence: 1 },
    ],
    ai_interactions: [], summary: null, config_snapshot: null,
  };
}
function emit(name: string, payload: unknown) { state.listeners.get(name)?.forEach((handler) => handler({ payload })); }

describe("past transcript → meeting chat", () => {
  beforeEach(() => {
    state.listeners.clear();
    state.summaryBusy = false;
    state.getMeeting.mockReset().mockImplementation(async (id: string) => meeting(id, `Question from ${id}?`));
    state.askMeeting.mockReset().mockImplementation(() => new Promise<void>(() => {}));
    state.cancelGeneration.mockReset().mockResolvedValue(undefined);
    state.generateSummary.mockClear();
    useConfigStore.setState({ llmProvider: "custom", llmModel: "gpt-5.6-luna" });
    useMeetingStore.setState({ activeMeeting: null });
  });

  it("sends exactly the clicked phrase to the opened meeting, opens chat and streams only that answer", async () => {
    let finishAsk!: () => void;
    state.askMeeting.mockImplementation(() => new Promise<void>((resolve) => { finishAsk = resolve; }));
    render(<MeetingDetails meetingId="past-a" onBack={() => {}} />);
    const phrase = await screen.findByRole("button", { name: "Спросить ИИ о фразе: Question from past-a?" });
    expect(state.askMeeting).not.toHaveBeenCalled();
    fireEvent.click(phrase);
    await waitFor(() => expect(state.askMeeting).toHaveBeenCalledOnce());
    const [id, question, requestId] = state.askMeeting.mock.calls[0];
    expect([id, question]).toEqual(["past-a", "Question from past-a?"]);
    expect(screen.getByRole("tab", { name: "Вопрос" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Остановить ответ" })).toBeInTheDocument();
    act(() => {
      emit("llm_stream_start", { request_id: requestId, model: "gpt-5.6-luna", provider: "custom" });
      emit("llm_stream_token", { request_id: "unrelated", token: "Wrong meeting" });
      emit("llm_stream_token", { request_id: requestId, token: "The answer to the clicked phrase" });
      emit("llm_stream_end", { request_id: requestId, cancelled: false });
    });
    await act(async () => finishAsk());
    expect(screen.getByText("The answer to the clicked phrase")).toBeInTheDocument();
    expect(screen.queryByText("Wrong meeting")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Модель ответа")).toHaveTextContent("gpt-5.6-luna");
    expect(useConfigStore.getState()).toMatchObject({ llmProvider: "custom", llmModel: "gpt-5.6-luna" });
  });

  it("does not launch two requests when two phrases are clicked before the first render", async () => {
    render(<MeetingDetails meetingId="past-a" onBack={() => {}} />);
    const first = await screen.findByRole("button", { name: "Спросить ИИ о фразе: Question from past-a?" });
    const second = screen.getByRole("button", { name: "Спросить ИИ о фразе: Second phrase" });
    fireEvent.click(first);
    fireEvent.click(second);
    await waitFor(() => expect(state.askMeeting).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.askMeeting).toHaveBeenCalledTimes(1);
    expect(state.askMeeting.mock.calls[0][1]).toBe("Question from past-a?");
  });

  it("waits for a background AI task instead of starting another generator", async () => {
    state.summaryBusy = true;
    render(<MeetingDetails meetingId="past-a" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Спросить ИИ о фразе: Question from past-a?" }));
    await screen.findByRole("textbox", { name: "Спросить об этой встрече" });
    expect(state.askMeeting).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отправить вопрос" })).toBeDisabled();
  });

  it("ignores an older meeting load that finishes after navigating to a new meeting", async () => {
    let finishOldLoad!: (data: Meeting) => void;
    state.getMeeting.mockImplementation((id: string) => id === "old" ? new Promise<Meeting>((resolve) => { finishOldLoad = resolve; }) : Promise.resolve(meeting(id, "New meeting phrase")));
    const view = render(<MeetingDetails meetingId="old" onBack={() => {}} />);
    await waitFor(() => expect(state.getMeeting).toHaveBeenCalledWith("old"));
    view.rerender(<MeetingDetails meetingId="new" onBack={() => {}} />);
    await screen.findByRole("button", { name: "Спросить ИИ о фразе: New meeting phrase" });
    await act(async () => finishOldLoad(meeting("old", "Stale old phrase")));
    expect(screen.getByRole("heading", { name: "Meeting new" })).toBeInTheDocument();
    expect(screen.queryByText("Stale old phrase")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Спросить ИИ о фразе: New meeting phrase" }));
    await waitFor(() => expect(state.askMeeting).toHaveBeenCalledOnce());
    expect(state.askMeeting.mock.calls[0].slice(0, 2)).toEqual(["new", "New meeting phrase"]);
  });
});
