import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "./types";
import { latestAssistSegment } from "./latestAssist";

const segment = (id: string, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id, text, speaker: "Them", timestamp_ms: 1000, is_final: true, confidence: 0.9, ...extra,
});

describe("latestAssistSegment", () => {
  it("sends the whole visible microphone answer, including its provisional continuation", () => {
    const result = latestAssistSegment([
      segment("a", "Первая часть", { speaker: "User", timestamp_ms: 1000, duration_ms: 20000 }),
      segment("b", "продолжение", { speaker: "User", timestamp_ms: 21000, duration_ms: 4000, is_final: false }),
    ]);
    expect(result?.text).toBe("Первая часть продолжение");
    expect(result?.originalIds).toEqual(["a", "b"]);
  });
  it("keeps only the newest request, including mixed timestamp formats", () => {
    const result = latestAssistSegment([
      segment("old", "Что такое GC?", { timestamp_ms: 1_700_000_000_000 }),
      segment("new", "Что такое Large Object Heap?", { timestamp_ms: 2000 }),
    ]);
    expect(result).toMatchObject({ id: "new", text: "Что такое Large Object Heap?" });
  });

  it("keeps every question within the current paragraph", () => {
    expect(latestAssistSegment([segment("line", "Что такое стек? Что такое куча? Чем они отличаются? Спасибо.")])?.text)
      .toBe("Что такое стек? Что такое куча? Чем они отличаются? Спасибо.");
  });

  it("recognizes Russian requests without a question mark and preserves .NET", () => {
    expect(latestAssistSegment([segment("line", "Что такое GC? Теперь объясни Large Object Heap в .NET.")])?.text)
      .toBe("Что такое GC? Теперь объясни Large Object Heap в .NET.");
  });

  it("preserves English technical names and version numbers", () => {
    expect(latestAssistSegment([segment("line", "What is GC? Explain Large Object Heap in .NET 8.0.")])?.text)
      .toBe("What is GC? Explain Large Object Heap in .NET 8.0.");
  });

  it("uses the newest visible interim instead of an older finalized question", () => {
    expect(latestAssistSegment([segment("old", "Что такое стек?"), segment("new", "Объясни кучу", { is_final: false })])?.text)
      .toBe("Объясни кучу");
  });

  it("snapshots a pending line revision without changing stored text", () => {
    const source = segment("line", "Что такое стек?", { pending_text: "Что такое стек? Как устроена куча?" });
    expect(latestAssistSegment([source])?.text).toBe("Что такое стек? Как устроена куча?");
    expect(source.text).toBe("Что такое стек?");
    expect(source.pending_text).toContain("Как устроена куча?");
  });

  it("uses a recent non-question request rather than searching for an older question", () => {
    expect(latestAssistSegment([segment("old", "Что такое стек?"), segment("new", "Подробнее про освобождение памяти.")])?.text)
      .toBe("Подробнее про освобождение памяти.");
  });

  it("skips empty recognition entries and returns null for an empty transcript", () => {
    expect(latestAssistSegment([segment("last", "Как работает GC?"), segment("blank", " ")])?.id).toBe("last");
    expect(latestAssistSegment([segment("blank", " ")])).toBeNull();
    expect(latestAssistSegment([])).toBeNull();
  });
});
