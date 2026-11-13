import { beforeEach, describe, expect, it, vi } from "vitest";

const generateAssist = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const cancelGenerationAndWait = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./ipc", () => ({
  generateAssist: (...args: unknown[]) => generateAssist(...args),
  cancelGenerationAndWait: (...args: unknown[]) => cancelGenerationAndWait(...args),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { runLatestAssist, runMergedAssist, runScreenAssist, runUserAction, stopUserActions } from "./userAction";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useMeetingStore } from "../stores/meetingStore";
import type { TranscriptSegment } from "./types";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";

const T0 = 1_700_000_000_000;

describe("Ctrl+S request", () => {
  const speech = (id: string, text: string): TranscriptSegment => ({ id, text, speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9 });
  beforeEach(() => {
    generateAssist.mockReset().mockResolvedValue(undefined);
    cancelGenerationAndWait.mockReset().mockResolvedValue(undefined);
    useTranscriptStore.getState().clearSegments();
    useStreamStore.getState().resetForMeeting();
    useMeetingStore.setState({ activeMeeting: { id: crypto.randomUUID() } as never });
    useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 }, contextScopeSticky: true });
  });

  it("joins only checked fragments in transcript order and clears the submitted selection", async () => {
    const fragments = [speech("one", "Что такое Large"), speech("two", "Object Heap? Как он работает?")];
    useTranscriptStore.setState({ segments: fragments, selectedSegmentIds: ["two", "one"] });
    await runMergedAssist();
    expect(generateAssist).toHaveBeenCalledExactlyOnceWith("Assist", "Что такое Large Object Heap? Как он работает?", expect.objectContaining({ transcriptSegments: [] }));
    expect(useTranscriptStore.getState().segments).toEqual(fragments);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
    useTranscriptStore.getState().appendSegment(speech("three", "Когда используется?"));
    await runMergedAssist();
    expect(generateAssist).toHaveBeenCalledOnce();
    useTranscriptStore.setState({ selectedSegmentIds: ["three"] });
    await runMergedAssist();
    expect(generateAssist.mock.calls[1][1]).toBe("Когда используется?");
    expect((generateAssist.mock.calls[1][2] as { transcriptSegments: { id: string }[] }).transcriptSegments.map((s) => s.id)).toEqual(["one", "two"]);
  });

  it("snapshots interim text and leaves later speech or corrections for the next merge", async () => {
    useTranscriptStore.setState({ segments: [{ ...speech("one", "Что такое"), pending_text: "Что такое стек?" }], selectedSegmentIds: ["one"] });
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const request = runMergedAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    expect(generateAssist.mock.calls[0][1]).toBe("Что такое стек?");
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
    useTranscriptStore.getState().updateInterimSegment({ ...speech("one", "Что такое стек и куча?"), is_final: false });
    useTranscriptStore.getState().appendSegment(speech("two", "Сравни их."));
    useTranscriptStore.getState().toggleSelectedSegments(["one", "two"]);
    finish();
    await request;
    // Finishing the old answer must not clear a selection made after sending.
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual(["one", "two"]);
    await runMergedAssist();
    expect(generateAssist.mock.calls[1][1]).toBe("Что такое стек и куча? Сравни их.");
  });

  it("clears selection at submission even if the provider later fails", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Первый вопрос?"), speech("two", "Второй вопрос?")], selectedSegmentIds: ["one", "two"] });
    generateAssist.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(runMergedAssist()).rejects.toThrow("Provider unavailable");
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
    useTranscriptStore.getState().toggleSelectedSegments(["one", "two"]);
    await runMergedAssist();
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Первый вопрос? Второй вопрос?", "Первый вопрос? Второй вопрос?"]);
  });

  it("replaces a running merge using the selection at the new press", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Первый вопрос?")], selectedSegmentIds: ["one"] });
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = runMergedAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    const firstId = (generateAssist.mock.calls[0][2] as { requestId: string }).requestId;
    cancelGenerationAndWait.mockImplementationOnce(async () => { finish(); });
    useTranscriptStore.getState().appendSegment(speech("two", "Второй вопрос?"));
    useTranscriptStore.getState().toggleSelectedSegments(["two"]);
    await Promise.all([first, runMergedAssist()]);
    expect(cancelGenerationAndWait).toHaveBeenCalledWith(firstId);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Первый вопрос?", "Второй вопрос?"]);
    expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
  });

  it("requires checked speech and clears the selection with the meeting transcript", async () => {
    await runMergedAssist();
    useTranscriptStore.setState({ segments: [speech("one", "  ")] });
    await runMergedAssist();
    expect(generateAssist).not.toHaveBeenCalled();
    useTranscriptStore.setState({ segments: [speech("one", "Один вопрос?")] });
    await runMergedAssist();
    expect(generateAssist).not.toHaveBeenCalled();
    useTranscriptStore.getState().toggleSelectedSegments(["one"]);
    await runMergedAssist();
    useMeetingStore.setState({ activeMeeting: { id: "another-meeting" } as never });
    useTranscriptStore.getState().clearSegments();
    useTranscriptStore.setState({ segments: [speech("one", "Один вопрос?")] });
    await runMergedAssist();
    expect(generateAssist).toHaveBeenCalledOnce();
    useTranscriptStore.getState().toggleSelectedSegments(["one"]);
    await runMergedAssist();
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Один вопрос?", "Один вопрос?"]);
  });
});

describe("runUserAction", () => {
  beforeEach(() => {
    generateAssist.mockReset();
    generateAssist.mockResolvedValue(undefined);
    cancelGenerationAndWait.mockReset().mockResolvedValue(undefined);
    useTranscriptStore.getState().clearSegments();
    useMeetingStore.setState({ activeMeeting: null });
    useStreamStore.getState().resetForMeeting();
    useConfigStore.setState({ contextScope: { kind: "default", minutes: 5 }, contextScopeSticky: true });
    vi.spyOn(Date, "now").mockReturnValue(T0);
  });

  it("default scope sends no scope and shows Sending after the old request has stopped", async () => {
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish=resolve; }));
    const p = runUserAction("FollowUp");
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    expect(useStreamStore.getState().phase).toBe("sending");
    finish();
    await p;
    const [mode, question, opts] = generateAssist.mock.calls[0] as [string, unknown, { scope: unknown; requestId: string }];
    expect([mode, question, opts.scope]).toEqual(["FollowUp", undefined, null]);
    expect(opts.requestId).toEqual(expect.any(String));
    expect(useStreamStore.getState().pendingRequestId).toBeNull();
    expect(useStreamStore.getState().phase).toBe("idle");
  });

  it("resolves since-last-same from this meeting's previous request of that action", async () => {
    useConfigStore.setState({ contextScope: { kind: "since_last_same", minutes: 5 } });
    await runUserAction("FollowUp");
    expect((generateAssist.mock.calls[0][2] as { scope: unknown }).scope).toEqual({
      kind: "all",
      since_ms: null,
      label: "Вся встреча (впервые: Уточнить)",
    });

    useStreamStore.getState().recordUserRequest("FollowUp", T0 - 90_000);
    await runUserAction("FollowUp", "custom?");
    expect(generateAssist.mock.calls[1][1]).toBe("custom?");
    expect((generateAssist.mock.calls[1][2] as { scope: unknown }).scope).toEqual({
      kind: "since_last_same",
      since_ms: T0 - 90_000,
      label: "После «Уточнить»",
    });
  });

  it("a sticky scope stays; a non-sticky one reverts to the default after one action", async () => {
    // generate_assist resolves once its stream ended (no events in this test).
    const finished = () => useStreamStore.setState({ phase: "idle", pendingRequestId: null });
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 10 }, contextScopeSticky: true });
    await runUserAction("Recap");
    finished();
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "minutes", minutes: 10 });

    useConfigStore.setState({ contextScopeSticky: false });
    await runUserAction("Recap");
    finished();
    expect((generateAssist.mock.calls[1][2] as { scope: { label: string } }).scope.label).toBe("Последние 10 мин");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "default", minutes: 10 });
    await runUserAction("Recap");
    expect((generateAssist.mock.calls[2][2] as { scope: unknown }).scope).toBeNull();
  });

  it("a new explicit request cancels an earlier sending request before replacing it", async () => {
    useConfigStore.setState({ contextScope: { kind: "minutes", minutes: 5 }, contextScopeSticky: false });
    useStreamStore.setState({ phase: "sending", pendingRequestId: "first", isStreaming: false });
    cancelGenerationAndWait.mockImplementationOnce(async () => { useStreamStore.getState().clearPending("first"); });
    await runUserAction("AskQuestion", "Новый абзац?");
    expect(cancelGenerationAndWait).toHaveBeenCalledOnce();
    expect(generateAssist.mock.calls[0][1]).toBe("Новый абзац?");
    expect(useStreamStore.getState().phase).toBe("idle");
    expect(useConfigStore.getState().contextScope).toEqual({ kind: "default", minutes: 5 });
  });

  it("a failed request clears its Sending… state", async () => {
    generateAssist.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(runUserAction("AskQuestion", "Current request")).rejects.toThrow("Provider unavailable");
    expect(useStreamStore.getState().phase).toBe("idle");
  });

  it("unlocks the next action when native preparation finishes without a stream start", async () => {
    let finishPreparation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPreparation = resolve; }));
    const request = runUserAction("AskQuestion", "Current request");
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    expect(useStreamStore.getState().phase).toBe("sending");
    finishPreparation(); // cancellation before stream_start returns Ok from the backend
    await request;
    expect(useStreamStore.getState()).toMatchObject({ phase: "idle", pendingRequestId: null, isStreaming: false });
    await runUserAction("Recap");
    expect(generateAssist.mock.calls.map((call) => call[0])).toEqual(["AskQuestion", "Recap"]);
  });

  it("does not clear a stream that consumed the pending request", async () => {
    let finishInvoke!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInvoke = resolve; }));
    const request = runUserAction("AskQuestion", "Current request");
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    const requestId = useStreamStore.getState().pendingRequestId!;
    useStreamStore.getState().startStream("AskQuestion", "gpt-4.1", "OpenAI", { requestId });
    useStreamStore.getState().appendToken("A partial response");
    finishInvoke();
    await request;
    expect(useStreamStore.getState()).toMatchObject({ phase: "writing", isStreaming: true, currentContent: "A partial response", currentModel: "gpt-4.1" });
  });
});

describe("Space request", () => {
  const speech = (id: string, text: string): TranscriptSegment => ({ id, text, speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9 });
  beforeEach(() => {
    generateAssist.mockReset();
    generateAssist.mockResolvedValue(undefined);
    useStreamStore.getState().resetForMeeting();
    useTranscriptStore.getState().clearSegments();
    useMeetingStore.setState({ activeMeeting: null });
    cancelGenerationAndWait.mockReset();
    cancelGenerationAndWait.mockResolvedValue(undefined);
    useConfigStore.setState({ contextScope: { kind: "all", minutes: 5 }, contextScopeSticky: false });
  });

  it("a screen question replaces the active chat response without needing any transcript", async () => {
    useMeetingStore.setState({activeMeeting:{id:"screen-meeting"} as never});
    let finish!:()=>void;
    generateAssist.mockImplementationOnce(()=>new Promise<void>((resolve)=>{finish=resolve;}));
    const first=runUserAction("AskQuestion","Old question");
    await vi.waitFor(()=>expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(async()=>{finish();});
    await Promise.all([first,runScreenAssist()]);
    expect(generateAssist).toHaveBeenCalledTimes(2);
    expect(generateAssist.mock.calls[1][0]).toBe("AskQuestion");
    expect(generateAssist.mock.calls[1][2]).toMatchObject({captureScreen:true});
  });

  it("sends the complete merged microphone block without duplicating its chunks as background", async () => {
    useTranscriptStore.setState({segments:[speech("q","Вопрос собеседника?"),
      {...speech("one","Первый фрагмент"),speaker:"User",timestamp_ms:2000,duration_ms:20000},
      {...speech("two","Второй фрагмент"),speaker:"User",timestamp_ms:22000,duration_ms:10000}]});
    await runLatestAssist();
    expect(generateAssist.mock.calls[0][1]).toBe("Первый фрагмент Второй фрагмент");
    expect((generateAssist.mock.calls[0][2] as {transcriptSegments:{id:string}[]}).transcriptSegments.map((s)=>s.id)).toEqual(["q"]);
  });

  it("separates the current request from older reference paragraphs", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Что такое стек?"), speech("two", "Что такое Large Object Heap?")] });
    await runLatestAssist();
    expect(generateAssist).toHaveBeenCalledExactlyOnceWith("Assist", "Что такое Large Object Heap?", expect.objectContaining({
      transcriptSegments: [{ id: "one", text: "Что такое стек?", speaker: "Them", timestamp_ms: 1000 }],
      scope: { kind: "all", since_ms: null, label: "Вся встреча" },
    }));
    expect(useConfigStore.getState().contextScope.kind).toBe("default");
  });

  it("each new press snapshots the new question without resending the old ones", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Что такое стек?")] });
    await runLatestAssist();
    useTranscriptStore.getState().appendSegment(speech("two", "Как работает GC?"));
    await runLatestAssist();
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Что такое стек?", "Как работает GC?"]);
    expect(JSON.stringify(generateAssist.mock.calls[1][2])).toContain("Что такое стек"); // reference, not the new request
  });

  it("cancels the running response and then sends only the latest question", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Как работает GC?")] });
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    const firstId = (generateAssist.mock.calls[0][2] as { requestId: string }).requestId;
    cancelGenerationAndWait.mockImplementationOnce(async () => { finish(); });
    useTranscriptStore.getState().appendSegment(speech("two", "Что такое Large Object Heap?"));
    const second = runLatestAssist();
    await Promise.all([first, second]);
    expect(cancelGenerationAndWait).toHaveBeenCalledWith(firstId);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Как работает GC?", "Что такое Large Object Heap?"]);
  });

  it("coalesces rapid presses during cancellation and drops the intermediate question", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Вопрос A?")] });
    let finish!: () => void;
    let finishCancellation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCancellation = () => { finish(); resolve(); };
    }));
    useTranscriptStore.getState().appendSegment(speech("two", "Вопрос B?"));
    const second = runLatestAssist();
    useTranscriptStore.getState().appendSegment(speech("three", "Вопрос C?"));
    const third = runLatestAssist();
    expect(generateAssist).toHaveBeenCalledOnce();
    finishCancellation();
    await Promise.all([first, second, third]);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Вопрос A?", "Вопрос C?"]);
  });

  it("retries a cancellation that arrived before the native request was registered", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Вопрос A?")] });
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    const firstId = (generateAssist.mock.calls[0][2] as { requestId: string }).requestId;
    cancelGenerationAndWait.mockResolvedValueOnce(undefined);
    cancelGenerationAndWait.mockImplementationOnce(async () => { finish(); });
    useTranscriptStore.getState().appendSegment(speech("two", "Вопрос B?"));
    await Promise.all([first, runLatestAssist()]);
    expect(cancelGenerationAndWait.mock.calls.filter((call) => call[0] === firstId)).toHaveLength(2);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Вопрос A?", "Вопрос B?"]);
  });

  it("waits for another active model action to stop before starting the latest question", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Что такое GC?")] });
    useStreamStore.getState().startStream("Recap", "model", "provider", { requestId: "old-recap" });
    let finishCancellation!: () => void;
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCancellation = () => { useStreamStore.getState().endStream(0); resolve(); };
    }));
    const request = runLatestAssist();
    await vi.waitFor(() => expect(cancelGenerationAndWait).toHaveBeenCalledOnce());
    expect(generateAssist).not.toHaveBeenCalled();
    finishCancellation();
    await request;
    expect(generateAssist.mock.calls[0][1]).toBe("Что такое GC?");
  });

  it("cancels native preparation even when the UI has not seen its stream start", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Что такое GC?")] });
    let finishCancellation!: () => void;
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCancellation = resolve; }));
    expect(useStreamStore.getState().phase).toBe("idle");
    const request = runLatestAssist();
    await vi.waitFor(() => expect(cancelGenerationAndWait).toHaveBeenCalledOnce());
    expect(generateAssist).not.toHaveBeenCalled();
    finishCancellation();
    await request;
    expect(generateAssist.mock.calls[0][1]).toBe("Что такое GC?");
  });

  it("drops a queued old-meeting question if the meeting changes while cancellation finishes", async () => {
    useTranscriptStore.setState({ segments: [speech("one", "Вопрос A?")] });
    let finish!: () => void;
    let finishCancellation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCancellation = () => { finish(); resolve(); };
    }));
    cancelGenerationAndWait.mockClear();
    useTranscriptStore.getState().appendSegment(speech("two", "Вопрос B?"));
    const second = runLatestAssist();
    useMeetingStore.setState({ activeMeeting: { id: "different-meeting" } as never });
    finishCancellation();
    await Promise.all([first, second]);
    expect(generateAssist).toHaveBeenCalledOnce();
    expect(cancelGenerationAndWait.mock.calls.every((call) => typeof call[0] === "string")).toBe(true);
  });

  it("does not ask the model to process history when no speech was recognized", async () => {
    await runLatestAssist();
    expect(generateAssist).not.toHaveBeenCalled();
    expect(useStreamStore.getState().phase).toBe("idle");
  });

  it("the Assist button replaces a Space request and preserves every question in the new paragraph", async () => {
    useTranscriptStore.setState({segments:[speech("one","Earlier request?")]});
    let finish!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => {finish=resolve;}));
    const first=runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(async () => {finish();});
    const block="Что такое стек? Что такое куча? Сравни их в .NET 8.0.";
    useTranscriptStore.getState().appendSegment(speech("two",block));
    await Promise.all([first,runUserAction("Assist")]);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Earlier request?",block]);
  });

  it("a typed request supersedes a pending paragraph instead of queuing both", async () => {
    useTranscriptStore.setState({segments:[speech("one","First block?")]});
    let finish!: () => void;
    let releaseCancellation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => {finish=resolve;}));
    const first=runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {releaseCancellation=() => {finish();resolve();};}));
    useTranscriptStore.getState().appendSegment(speech("two","Superseded block?"));
    const second=runUserAction("Assist");
    const third=runUserAction("AskQuestion","Typed question A? Typed question B?");
    releaseCancellation();
    await Promise.all([first,second,third]);
    expect(generateAssist.mock.calls.map((call) => [call[0],call[1]])).toEqual([["Assist","First block?"],["AskQuestion","Typed question A? Typed question B?"]]);
  });

  it("Stop discards a pending replacement as well as stopping the current request", async () => {
    useTranscriptStore.setState({segments:[speech("one","First block?")]});
    let finish!: () => void;
    let releaseCancellation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((resolve) => {finish=resolve;}));
    const first=runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {releaseCancellation=() => {finish();resolve();};}));
    const replacement=runUserAction("AskQuestion","Do not send this after Stop");
    await stopUserActions();
    releaseCancellation();
    await Promise.all([first,replacement]);
    expect(generateAssist).toHaveBeenCalledOnce();
  });

  it("does not strand a new request when the stopped request fails during cancellation", async () => {
    useTranscriptStore.setState({segments:[speech("one","Old block?")]});
    let rejectOld!: (error: Error) => void;
    let releaseCancellation!: () => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((_,reject) => {rejectOld=reject;}));
    const first=runLatestAssist();
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    cancelGenerationAndWait.mockImplementationOnce(() => new Promise<void>((resolve) => {releaseCancellation=resolve;}));
    await stopUserActions();
    rejectOld(new Error("Old request failed while stopping"));
    await vi.waitFor(() => expect(useStreamStore.getState().phase).toBe("idle"));
    const replacement=runUserAction("AskQuestion","New request A? New request B?");
    releaseCancellation();
    await Promise.all([first,replacement]);
    expect(generateAssist.mock.calls.map((call) => call[1])).toEqual(["Old block?","New request A? New request B?"]);
  });

  it("does not revive a stopped request through a late native busy error", async () => {
    let rejectOld!: (error: Error) => void;
    generateAssist.mockImplementationOnce(() => new Promise<void>((_,reject) => {rejectOld=reject;}));
    const first=runUserAction("AskQuestion","Do not retry after Stop");
    await vi.waitFor(() => expect(generateAssist).toHaveBeenCalledOnce());
    const id=(generateAssist.mock.calls[0][2] as {requestId:string}).requestId;
    cancelGenerationAndWait.mockClear();
    await stopUserActions();
    rejectOld(new Error("Generation already in progress"));
    await first;
    expect(generateAssist).toHaveBeenCalledOnce();
    expect(cancelGenerationAndWait.mock.calls.every((call) => call[0]===id)).toBe(true);
  });
});
