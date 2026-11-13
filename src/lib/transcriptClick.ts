/** A drag-to-select gesture must keep selecting text rather than ask the model. */
export function hasTranscriptTextSelection(element: HTMLElement): boolean {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

/** Only a plain primary click asks; modifiers and the second double-click do not. */
export function isTranscriptAskClick(event: Pick<MouseEvent, "button" | "detail" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return event.button === 0 && event.detail <= 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}
