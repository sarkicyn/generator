// Small formatters for the AI response panel (timer, meeting time, previews).

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lm_studio: "LM Studio",
  claude_cli: "Claude",
  custom: "Свой сервис",
};

/** Keep the exact model ID: different variants can share the same short name. */
export function responseServiceLabel(provider: string, model: string): string {
  const name = PROVIDER_NAMES[provider.toLowerCase()] || provider || "Провайдер не указан";
  return `${name} / ${model || "Модель не выбрана"}`;
}

/** "0.6 s", "12.3 s", then "1:05" past a minute. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} с`;
  const secs = Math.floor(safe / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Meeting-relative "mm:ss" when the meeting start is known, else the clock time. */
export function formatAnswerTime(timestamp: number, meetingStart: number | null): string {
  if (meetingStart && timestamp >= meetingStart) {
    const secs = Math.floor((timestamp - meetingStart) / 1000);
    return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  }
  return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** First non-empty line of an answer, without markdown markers. */
export function previewLine(content: string): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/[*_`]/g, "");
}

/** "3 new transcript lines sent" / "нет новой речи после последнего ответа" (session path), "42 transcript lines" (stateless). */
export function linesLabel(newLines: number | null, sessionKey: string | null): string | null {
  if (newLines == null) return null;
  if (sessionKey) {
    if (newLines === 0) return "нет новой речи после последнего ответа";
    return `Новых строк расшифровки отправлено: ${newLines}`;
  }
  return `Строк расшифровки: ${newLines}`;
}
