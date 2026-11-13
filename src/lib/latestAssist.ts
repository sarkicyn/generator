import type { TranscriptSegment } from "./types";
import { mergeConsecutiveSegments } from "./mergeSegments";

/** Keep the entire newest paragraph, including every question in that block. */
export function latestAssistSegment(segments: readonly TranscriptSegment[]): (TranscriptSegment & { originalIds?: string[] }) | null {
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const text = (segment.pending_text ?? segment.text).trim();
    if (!text) continue;
    if (segment.speaker === "User") {
      const block = mergeConsecutiveSegments([...segments]).find((item) => item.originalIds.includes(segment.id));
      if (block) return { ...block, text: (block.pending_text ?? block.text).trim(), pending_text: undefined };
    }
    return { ...segment, text, pending_text: undefined };
  }
  return null;
}
