import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Speaker, IntelligenceMode } from "./types";

// shadcn/ui utility
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip <think>...</think> blocks from LLM output.
 * Handles both complete blocks and unclosed tags (mid-stream).
 */
export function stripThinkTags(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.indexOf("<think>");
  if (openIdx !== -1) {
    result = result.substring(0, openIdx);
  }
  return result.trimStart();
}

// Format milliseconds to MM:SS
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

// Format milliseconds to HH:MM:SS for long meetings
export function formatDurationLong(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return formatDuration(ms);
}

// Format timestamp for transcript display
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Format ISO date string to relative time
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Только что";
  if (diffMins < 60) return `${diffMins} мин назад`;
  if (diffHours < 24) return `${diffHours} ч назад`;
  if (diffDays < 7) return `${diffDays} дн назад`;
  return date.toLocaleDateString("ru-RU");
}

// Get speaker display color class
export function getSpeakerColor(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return "text-speaker-user";
    case "Interviewer":
    case "Them":
      return "text-speaker-interviewer";
    default:
      return "text-muted-foreground";
  }
}

// Get speaker label
export function getSpeakerLabel(speaker: Speaker): string {
  switch (speaker) {
    case "User":
      return "Вы";
    case "Interviewer":
      return "Собеседник";
    case "Them":
      return "Собеседники";
    default:
      return speaker || "Неизвестно";
  }
}

// Get intelligence mode label
export function getModeLabel(mode: IntelligenceMode): string {
  switch (mode) {
    case "Assist":
      return "Подсказка";
    case "WhatToSay":
      return "Ответ";
    case "Shorten":
      return "Кратко";
    case "FollowUp":
      return "Уточнить";
    case "Recap":
      return "Итоги";
    case "AskQuestion":
      return "Спросить";
    case "MeetingSummary":
      return "Резюме";
    case "ActionItemsExtraction":
      return "Задачи";
    case "BookmarkSuggestions":
      return "Закладки";
    case "MeetingAsk":
      return "Вопрос по встрече";
  }
}

const LEGACY_ACTION_NAMES: Record<string, string> = {
  Assist: "Assist", WhatToSay: "Say", Shorten: "Short", FollowUp: "F/U",
  Recap: "Recap", AskQuestion: "Ask", MeetingSummary: "Summary",
  ActionItemsExtraction: "Actions", BookmarkSuggestions: "Bookmarks", MeetingAsk: "Ask meeting",
};

/** Translate an old built-in default while preserving names the user edited. */
export function getActionDisplayName(mode: string, name: string): string {
  return name === LEGACY_ACTION_NAMES[mode] ? getModeLabel(mode as IntelligenceMode) : name;
}

// Get mode keyboard shortcut
export function getModeShortcut(mode: IntelligenceMode): string {
  switch (mode) {
    case "Assist":
      return "Пробел";
    case "WhatToSay":
      return "Ctrl+1";
    case "Shorten":
      return "Ctrl+2";
    case "FollowUp":
      return "Ctrl+3";
    case "Recap":
      return "Ctrl+4";
    case "AskQuestion":
      return "Ctrl+5";
    case "MeetingSummary":
      return "";
    case "ActionItemsExtraction":
      return "";
    case "BookmarkSuggestions":
      return "";
    case "MeetingAsk":
      return "";
  }
}

// Format file size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// Group meetings by date category
export function getDateGroup(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / 86400000
  );

  if (diffDays === 0) return "Сегодня";
  if (diffDays === 1) return "Вчера";
  if (diffDays < 7) return "На этой неделе";
  return "Ранее";
}
