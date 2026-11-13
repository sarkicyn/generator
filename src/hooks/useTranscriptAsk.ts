import { useCallback, useEffect, useRef } from "react";
import { hasTranscriptTextSelection, isTranscriptAskClick } from "../lib/transcriptClick";

// Leave enough time for the usual Windows 500 ms double-click interval.
export const TRANSCRIPT_SINGLE_CLICK_DELAY_MS = 550;

/** Distinguish asking about a phrase from double-click/drag text selection. */
export function useTranscriptAsk(onAsk?: () => void) {
  const pending = useRef<number | null>(null);
  const cancelPending = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
  }, []);
  useEffect(() => cancelPending, [cancelPending]);

  const onClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    cancelPending();
    if (!onAsk || !isTranscriptAskClick(event) || hasTranscriptTextSelection(event.currentTarget)) return;
    const element = event.currentTarget;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (element.isConnected && !hasTranscriptTextSelection(element)) onAsk();
    }, TRANSCRIPT_SINGLE_CLICK_DELAY_MS);
  }, [onAsk, cancelPending]);

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    cancelPending();
  }, [cancelPending]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    cancelPending();
    if (onAsk && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !hasTranscriptTextSelection(event.currentTarget)) onAsk();
  }, [onAsk, cancelPending]);

  return {
    onClick: onAsk ? onClick : undefined,
    onDoubleClick: onAsk ? onDoubleClick : undefined,
    onKeyDown: onAsk ? onKeyDown : undefined,
  };
}
