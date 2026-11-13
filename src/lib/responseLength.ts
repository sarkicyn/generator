import brief from "./briefResponse.txt?raw";

/** Shared with native request assembly, so previews match the actual policy. */
export const RESPONSE_LENGTH_INSTRUCTIONS: Record<string, string> = {
  brief: brief.trim(),
  standard: "Standard length responses.",
  detailed: "Detailed responses.",
};
