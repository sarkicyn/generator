import { describe, expect, it } from "vitest";
import {
  clampMinutes,
  resolveScope,
  scopeChipLabel,
  scopeHint,
  type LastUserRequests,
} from "./contextScope";

const NOW = 1_700_000_900_000;
const none: LastUserRequests = { anyAt: null, byMode: {} };
const some: LastUserRequests = { anyAt: NOW - 60_000, byMode: { FollowUp: NOW - 300_000 } };

describe("resolveScope", () => {
  it("default sends no scope (the backend keeps today's behaviour)", () => {
    expect(resolveScope({ kind: "default", minutes: 5 }, "FollowUp", "F/U", some, NOW)).toBeNull();
  });

  it("вся встреча", () => {
    expect(resolveScope({ kind: "all", minutes: 5 }, "Recap", "Recap", some, NOW)).toEqual({
      kind: "all",
      since_ms: null,
      label: "Вся встреча",
    });
  });

  it("last N minutes counts back from now", () => {
    expect(resolveScope({ kind: "minutes", minutes: 10 }, "Recap", "Recap", none, NOW)).toEqual({
      kind: "minutes",
      since_ms: NOW - 600_000,
      minutes: 10,
      label: "Последние 10 мин",
    });
  });

  it("since the last answer of any action", () => {
    expect(resolveScope({ kind: "since_last_any", minutes: 5 }, "Assist", "Assist", some, NOW)).toEqual({
      kind: "since_last_any",
      since_ms: NOW - 60_000,
      label: "После последнего ответа",
    });
  });

  it("since the last answer of the same action", () => {
    expect(resolveScope({ kind: "since_last_same", minutes: 5 }, "FollowUp", "F/U", some, NOW)).toEqual({
      kind: "since_last_same",
      since_ms: NOW - 300_000,
      label: "После «F/U»",
    });
  });

  it("no previous request behaves like the вся встреча, and says why", () => {
    expect(resolveScope({ kind: "since_last_same", minutes: 5 }, "Shorten", "Short", some, NOW)).toEqual({
      kind: "all",
      since_ms: null,
      label: "Вся встреча (впервые: Short)",
    });
    expect(resolveScope({ kind: "since_last_any", minutes: 5 }, "Assist", "Assist", none, NOW)).toEqual({
      kind: "all",
      since_ms: null,
      label: "Вся встреча (первый ответ)",
    });
  });

  it("clamps out-of-range minutes", () => {
    expect(resolveScope({ kind: "minutes", minutes: 500 }, "Recap", "Recap", none, NOW)?.minutes).toBe(120);
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(7.6)).toBe(8);
    expect(clampMinutes(Number.NaN)).toBe(5);
  });
});

describe("labels", () => {
  it("chip labels", () => {
    expect(scopeChipLabel({ kind: "default", minutes: 5 })).toBe("По умолчанию");
    expect(scopeChipLabel({ kind: "since_last_any", minutes: 5 })).toBe("После последнего ответа");
    expect(scopeChipLabel({ kind: "since_last_same", minutes: 5 })).toBe("После такого же действия");
    expect(scopeChipLabel({ kind: "minutes", minutes: 5 })).toBe("Последние 5 мин");
    expect(scopeChipLabel({ kind: "all", minutes: 5 })).toBe("Вся встреча");
  });

  it("action hints mention the effective scope", () => {
    expect(scopeHint({ kind: "minutes", minutes: 5 }, "F/U")).toBe("последние 5 мин");
    expect(scopeHint({ kind: "since_last_same", minutes: 5 }, "F/U")).toBe("после «F/U»");
    expect(scopeHint({ kind: "default", minutes: 5 }, "F/U")).toBeNull();
  });
});
