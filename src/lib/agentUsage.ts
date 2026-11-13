// Pure helpers for Claude session status and usage, shared by the footer chip,
// the AI Log header and the fallback toast.

import type { AgentSessionStatus, ClaudeCliStatus, SessionUsage } from "./types";

/** Shown wherever a login that bills an API account would read as connected. */
export const API_BILLED_NOTE = "Этот вход Claude использует платный API-счёт вместо подписки.";

/** Shown when only an npm install of Claude Code (`claude.cmd`) was found. */
export const NPM_ONLY_NOTE = "Обнаружен Claude Code из npm — NexQ требуется нативная установка";

/** The Claude login bills an API account (usable, but not the subscription). */
export function isApiBilled(status: ClaudeCliStatus | undefined | null): boolean {
  return status?.auth?.login === "api_billed";
}

const NUMBER = new Intl.NumberFormat("ru-RU");

export function formatTokens(n: number): string {
  return NUMBER.format(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const EMPTY_USAGE: SessionUsage = {
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cost_usd: 0,
  requests: 0,
  total_latency_ms: 0,
  total_first_token_ms: 0,
  last_latency_ms: 0,
  last_request_at_ms: 0,
};

/** Every prompt token: uncached, cache reads and cache writes. */
export function promptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_write_tokens ?? 0);
}

/** "850 ms" / "1.2 s" / "31 s" / "2 min 5 s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const s = ms / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)} с`;
  if (s < 60) return `${Math.round(s)} с`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest > 0 ? `${m} мин ${rest} с` : `${m} мин`;
}

/** "Last answer: 1.2 s total, first words after 600 ms" */
export function lastAnswerTooltip(latencyMs: number, firstTokenMs: number | null): string {
  const total = `Последний ответ: всего ${formatDuration(latencyMs)}`;
  return firstTokenMs != null ? `${total}, первые слова через ${formatDuration(firstTokenMs)}` : total;
}

/** "just now" / "40 s ago" / "2 min ago" / "3 h ago" */
export function formatAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 10) return "только что";
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч назад`;
}

/** Average wall time per answered request (ms), or null before the first one. */
export function avgLatencyMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_latency_ms / u.requests : null;
}

/** Average time to the first words per answered request (ms), or null. */
export function avgFirstTokenMs(u: SessionUsage): number | null {
  return u.requests > 0 ? u.total_first_token_ms / u.requests : null;
}

/** "45,210 in (38,000 cached)": every prompt token, and how many came from the cache. */
export function formatPromptTokens(u: Pick<SessionUsage, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">): string {
  const cached = u.cache_read_tokens ?? 0;
  return `вход: ${formatTokens(promptTokens(u))}${cached > 0 ? ` (${formatTokens(cached)} из кэша)` : ""}`;
}

/** "in 45,210 (38,000 cached) · out 1,240 (thinking 300)" */
export function formatTokenUsage(u: SessionUsage): string {
  const cached = u.cache_read_tokens ?? 0;
  const thinking = u.thinking_tokens ?? 0;
  return (
    `вход: ${formatTokens(promptTokens(u))}${cached > 0 ? ` (${formatTokens(cached)} из кэша)` : ""}` +
    ` · выход: ${formatTokens(u.output_tokens)}${thinking > 0 ? ` (рассуждения: ${formatTokens(thinking)})` : ""}`
  );
}

/** "3 requests · 45,210 in (38,000 cached) / 1,240 out · avg 1.4 s" */
export function formatUsageSummary(u: SessionUsage): string {
  const parts = [
    `запросов: ${u.requests}`,
    `${formatPromptTokens(u)} / выход: ${formatTokens(u.output_tokens)}`,
  ];
  const avg = avgLatencyMs(u);
  if (avg != null) parts.push(`в среднем ${formatDuration(avg)}`);
  return parts.join(" · ");
}

/** The cost line shown wherever usage appears. */
export function formatCostEstimate(u: SessionUsage, apiBilled = false): string {
  return `≈ ${formatCost(u.cost_usd)} (оценка) — ${apiBilled ? "оплачивается с вашего API-счёта" : "включено в подписку"}`;
}

/** Live-scope sessions of one meeting (fast and/or deep). */
export function liveSessionsOf(
  sessions: Record<string, AgentSessionStatus>,
  meetingId: string | null,
): AgentSessionStatus[] {
  if (!meetingId) return [];
  return Object.values(sessions).filter((s) => s.scope === "live" && s.meeting_id === meetingId);
}

/** Cumulative fields of `SessionUsage` (only ever grow within a scope). */
const CUMULATIVE: Array<Exclude<keyof SessionUsage, "last_latency_ms" | "last_request_at_ms">> = [
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "thinking_tokens",
  "cost_usd",
  "requests",
  "total_latency_ms",
  "total_first_token_ms",
];

/**
 * Cumulative usage of a meeting. Every session carries the usage of its whole
 * scope (both tiers), snapshotted when that session last changed, so tiers are
 * not summed: the larger snapshot per field is the latest one. The "last
 * request" fields come from the snapshot that saw the latest request.
 */
export function scopeUsage(list: AgentSessionStatus[]): SessionUsage {
  return list.reduce<SessionUsage>((acc, s) => {
    const u = { ...EMPTY_USAGE, ...s.usage };
    const next = { ...acc };
    for (const field of CUMULATIVE) next[field] = Math.max(acc[field], u[field]);
    if (u.last_request_at_ms > acc.last_request_at_ms) {
      next.last_request_at_ms = u.last_request_at_ms;
      next.last_latency_ms = u.last_latency_ms;
    }
    return next;
  }, { ...EMPTY_USAGE });
}

/** Text fallback for a limit error when the backend sent no `error_kind`. */
export function isRateLimitText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("rate limit") ||
    t.includes("usage limit") ||
    (t.includes("limit reached") && !t.includes("context")) ||
    t.includes("too many requests") ||
    t.includes("per minute")
  );
}

/** The session stopped on a usage / rate limit (not a fault). */
export function isRateLimited(s: Pick<AgentSessionStatus, "error_kind" | "detail">): boolean {
  return s.error_kind != null ? s.error_kind === "rate_limited" : isRateLimitText(s.detail);
}
