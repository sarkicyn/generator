import { describe, expect, it } from "vitest";
import { evaluationTargets } from "./answerEvaluation";
import type { TranscriptSegment } from "./types";

const speech = (id: string, speaker: "User" | "Them", text = id, timestamp_ms = 1000): TranscriptSegment => ({ id, speaker, text, timestamp_ms, is_final: true, confidence: 0.9 });

describe("answer evaluation selection", () => {
  it("evaluates a continuous answer as a whole, across three recognition chunks", () => {
    const segments = [speech("q", "Them", "Вопрос", 0),
      { ...speech("a", "User", "Первая часть", 1000), duration_ms: 20000 },
      { ...speech("b", "User", "вторая часть", 21000), duration_ms: 20000 },
      { ...speech("c", "User", "третья часть", 41000), duration_ms: 10000 }];
    expect(evaluationTargets(segments, [])).toEqual([["a", "b", "c"]]);
    expect(evaluationTargets(segments, ["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });
  it("uses the latest finished own block instead of the latest other-party question or interim", () => {
    const segments = [speech("a", "User"), speech("q", "Them"), { ...speech("growing", "User"), pending_text: "Growing answer" }, { ...speech("interim", "User"), is_final: false }];
    expect(evaluationTargets(segments, [])).toEqual([]);
    expect(evaluationTargets(segments.slice(0, 2), [])).toEqual([["a"]]);
    expect(evaluationTargets([speech("old", "User"), { ...speech("new", "User"), is_final: false }], [])).toEqual([]);
  });
  it("keeps checked own answers in separate visible blocks and transcript order", () => {
    const segments = [speech("q", "Them"), speech("a1", "User"), speech("a2", "User", "continued", 2000), speech("next-q", "Them", "Q", 3000), speech("b", "User", "B", 4000), speech("last", "User", "last", 12000)];
    expect(evaluationTargets(segments, ["b", "a2", "a1", "next-q"])).toEqual([["a1", "a2"], ["b"]]);
    expect(evaluationTargets(segments, ["next-q"])).toEqual([]);
    expect(evaluationTargets(segments, [])).toEqual([["last"]]);
  });
});
