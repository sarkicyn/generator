import type { TranscriptSegment } from "./types";

export interface MergedSegment extends TranscriptSegment {
  mergedCount: number;
  originalIds: string[];
}

const MERGE_GAP_MS = 3000;
const MERGE_MAX_CHARS = 300;
const OWN_MAX_CHARS = 16000;

function audioEnd(segment: TranscriptSegment): number {
  return segment.timestamp_ms + (Number.isFinite(segment.duration_ms) && segment.duration_ms! >= 0 ? segment.duration_ms! : 0);
}

function speakerKey(seg: TranscriptSegment): string {
  // Remote people share speaker "them" but differ by speaker tag.
  return `${seg.speaker_id ?? seg.speaker}|${seg.speaker_tag ?? ""}`;
}

export function mergeConsecutiveSegments(segments: TranscriptSegment[]): MergedSegment[] {
  if (segments.length === 0) return [];
  // Arrival order can differ between the microphone and system-audio workers.
  segments = [...segments].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const result: MergedSegment[] = [];
  let current: MergedSegment = {
    ...segments[0],
    mergedCount: 1,
    originalIds: [segments[0].id],
  };
  let previousEnd = audioEnd(segments[0]);

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const own = current.speaker === "User" && seg.speaker === "User";
    const gap = seg.timestamp_ms - (own ? previousEnd : current.timestamp_ms);
    const sameKey = speakerKey(seg) === speakerKey(current);
    const wouldExceedLength = ((current.pending_text ?? current.text) + " " + (seg.pending_text ?? seg.text).trim()).length > (own ? OWN_MAX_CHARS : MERGE_MAX_CHARS);

    // Remote lines keep the existing paragraph boundaries; the microphone's
    // provisional continuation stays on the same visible answer.
    const growing = current.pending_text !== undefined || seg.pending_text !== undefined;

    const joinOwn = own && current.is_final;
    if (sameKey && gap <= MERGE_GAP_MS && !wouldExceedLength && (joinOwn || (current.is_final && seg.is_final && !growing))) {
      const pending = joinOwn && (growing || !seg.is_final)
        ? (current.pending_text ?? current.text) + " " + (seg.pending_text ?? seg.text).trim()
        : undefined;
      current = {
        ...current,
        text: current.text + (seg.is_final ? " " + seg.text.trim() : ""),
        pending_text: pending,
        duration_ms: own ? Math.max(previousEnd, audioEnd(seg)) - current.timestamp_ms : current.duration_ms,
        confidence: Math.min(current.confidence, seg.confidence),
        mergedCount: current.mergedCount + 1,
        originalIds: [...current.originalIds, seg.id],
      };
    } else {
      result.push(current);
      current = {
        ...seg,
        mergedCount: 1,
        originalIds: [seg.id],
      };
    }
    previousEnd = Math.max(audioEnd(seg), own && sameKey && gap <= MERGE_GAP_MS ? previousEnd : 0);
  }
  result.push(current);

  return result;
}
