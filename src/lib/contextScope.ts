// Which part of the meeting a user action focuses on: the picker's setting
// (configStore) resolved into a concrete scope at request time.

import type { ContextScopeKind, ContextScopeSetting, ResolvedScope } from "./types";

export const DEFAULT_CONTEXT_SCOPE: ContextScopeSetting = { kind: "default", minutes: 5 };

/** One-click minute choices in the picker (a custom value is also allowed). */
export const MINUTE_PRESETS = [2, 5, 10, 15] as const;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 120;

/** Start times (epoch ms) of the previous user requests in this meeting. */
export interface LastUserRequests {
  anyAt: number | null;
  byMode: Record<string, number>;
}

export const NO_USER_REQUESTS: LastUserRequests = { anyAt: null, byMode: {} };

/** A whole number of minutes within 1–120 (5 when not a number). */
export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CONTEXT_SCOPE.minutes;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes)));
}

/** Picker order. */
export const SCOPE_KINDS: ContextScopeKind[] = ["default", "since_last_any", "since_last_same", "minutes", "all"];

/** Label on the picker chip and options. */
export function scopeChipLabel(setting: ContextScopeSetting): string {
  switch (setting.kind) {
    case "default":
      return "По умолчанию";
    case "since_last_any":
      return "После последнего ответа";
    case "since_last_same":
      return "После такого же действия";
    case "minutes":
      return `Последние ${clampMinutes(setting.minutes)} мин`;
    case "all":
      return "Вся встреча";
  }
}

/** Short scope hint for an action button ("F/U · последние 5 мин"); null for the default. */
export function scopeHint(setting: ContextScopeSetting, actionLabel: string): string | null {
  switch (setting.kind) {
    case "default":
      return null;
    case "since_last_any":
      return "после последнего ответа";
    case "since_last_same":
      return `после «${actionLabel}»`;
    case "minutes":
      return `последние ${clampMinutes(setting.minutes)} мин`;
    case "all":
      return "вся встреча";
  }
}

/**
 * The scope to send with a request for `mode`, or null for the action's
 * default (the backend then behaves exactly as before). "Since last …" with
 * no earlier request in this meeting falls back to the вся встреча.
 */
export function resolveScope(
  setting: ContextScopeSetting,
  mode: string,
  actionLabel: string,
  last: LastUserRequests,
  now: number,
): ResolvedScope | null {
  switch (setting.kind) {
    case "default":
      return null;
    case "all":
      return { kind: "all", since_ms: null, label: "Вся встреча" };
    case "minutes": {
      const minutes = clampMinutes(setting.minutes);
      return { kind: "minutes", since_ms: now - minutes * 60_000, minutes, label: `Последние ${minutes} мин` };
    }
    case "since_last_any":
      return last.anyAt != null
        ? { kind: "since_last_any", since_ms: last.anyAt, label: "После последнего ответа" }
        : { kind: "all", since_ms: null, label: "Вся встреча (первый ответ)" };
    case "since_last_same": {
      const at = last.byMode[mode];
      return at != null
        ? { kind: "since_last_same", since_ms: at, label: `После «${actionLabel}»` }
        : { kind: "all", since_ms: null, label: `Вся встреча (впервые: ${actionLabel})` };
    }
  }
}
