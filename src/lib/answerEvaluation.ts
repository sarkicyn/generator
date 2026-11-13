import { mergeConsecutiveSegments } from "./mergeSegments";
import type { TranscriptSegment } from "./types";

/** The same visible blocks as the transcript; never turn the other party into our answer. */
export function evaluationTargets(segments: TranscriptSegment[], selectedIds: string[]): string[][] {
  const selected = new Set(selectedIds);
  const newestOwn = [...segments].reverse().find((s) => s.speaker === "User" && (s.pending_text ?? s.text).trim());
  if (!selected.size && newestOwn && (!newestOwn.is_final || newestOwn.pending_text !== undefined)) return [];
  const finals = segments.filter((s) => s.is_final && s.text.trim());
  const blocks = mergeConsecutiveSegments(finals);
  if (selected.size) {
    return blocks.filter((block) => block.speaker === "User")
      .map((block) => block.originalIds.filter((id) => selected.has(id))).filter((ids) => ids.length);
  }
  const latest = [...blocks].reverse().find((block) => block.speaker === "User");
  return latest && latest.pending_text === undefined ? [latest.originalIds] : [];
}

export interface AnswerEvaluation {
  id: string; meeting_id: string; request_id: string; segment_ids: string[];
  question: string; answer: string; score: number | null; missing: string;
  improved: string; model: string; created_at: number;
}

export interface EvaluationEvent {
  meeting_id: string; request_id: string;
  status: "running" | "item" | "done" | "error";
  completed: number; total: number; result?: AnswerEvaluation | null; error?: string | null;
}
