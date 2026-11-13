import { describe, expect, it } from "vitest";
import { mergeConsecutiveSegments } from "./mergeSegments";
import type { TranscriptSegment } from "./types";

function seg(id: string, ts: number, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id, text: id, speaker: "Them", speaker_id: "them", timestamp_ms: ts, is_final: true, confidence: 1, ...extra };
}

describe("mergeConsecutiveSegments", () => {
  it("keeps a continuous microphone answer in one block across long audio chunks and 300 characters", () => {
    const own = (id: string, ts: number) => seg(id, ts, { speaker: "User", speaker_id: "you", duration_ms: 20000, text: id.repeat(200) });
    const merged = mergeConsecutiveSegments([own("a", 0), own("b", 20000), own("c", 40000)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].originalIds).toEqual(["a", "b", "c"]);
    expect(merged[0].text.length).toBe(602);
    expect(merged[0].duration_ms).toBe(60000);
  });

  it("joins the growing microphone tail without duplicating the stable text", () => {
    const own = seg("a", 0, { speaker: "User", speaker_id: "you", text: "Первая часть", duration_ms: 20000 });
    const tail = seg("b", 20000, { speaker: "User", speaker_id: "you", text: "продолжение", duration_ms: 4000, is_final: false });
    const growing = mergeConsecutiveSegments([own, tail]);
    expect(growing).toHaveLength(1);
    expect(growing[0].text).toBe("Первая часть");
    expect(growing[0].pending_text).toBe("Первая часть продолжение");
    expect(growing[0].originalIds).toEqual(["a", "b"]);
    const finished = mergeConsecutiveSegments([own, { ...tail, is_final: true }]);
    expect(finished[0].text).toBe("Первая часть продолжение");
    expect(finished[0].pending_text).toBeUndefined();
  });

  it("starts a new own answer after a real pause or another speaker, including delayed events", () => {
    const first = seg("a", 0, { speaker: "User", speaker_id: "you", duration_ms: 10000 });
    const second = seg("b", 14000, { speaker: "User", speaker_id: "you", duration_ms: 5000 });
    expect(mergeConsecutiveSegments([first, second]).map((s) => s.originalIds)).toEqual([["a"], ["b"]]);
    const close = { ...second, timestamp_ms: 11500 };
    expect(mergeConsecutiveSegments([first, close]).map((s) => s.originalIds)).toEqual([["a", "b"]]);
    expect(mergeConsecutiveSegments([first, close, seg("question", 10500)]).map((s) => s.originalIds)).toEqual([["a"], ["question"], ["b"]]);
  });
  it("merges close lines of one person only", () => {
    const merged = mergeConsecutiveSegments([
      seg("a", 0, { speaker_tag: "S1" }),
      seg("b", 1_000, { speaker_tag: "S1" }),
      seg("c", 2_000, { speaker_tag: "S2" }),
    ]);
    expect(merged.map((m) => m.originalIds)).toEqual([["a", "b"], ["c"]]);
  });

  it("leaves a line that is still growing on its own", () => {
    const merged = mergeConsecutiveSegments([seg("a", 0), seg("b", 1_000, { pending_text: "b and" })]);
    expect(merged.map((m) => m.originalIds)).toEqual([["a"], ["b"]]);
    expect(merged[1].pending_text).toBe("b and");
  });
});
