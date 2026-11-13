import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE,
  avgFirstTokenMs,
  avgLatencyMs,
  formatAgo,
  formatDuration,
  formatTokenUsage,
  formatUsageSummary,
  lastAnswerTooltip,
  promptTokens,
} from "./agentUsage";

describe("formatDuration", () => {
  it.each([
    [0, "0 мс"],
    [850, "850 мс"],
    [999, "999 мс"],
    [1000, "1.0 с"],
    [1234, "1.2 с"],
    [9_960, "10.0 с"],
    [30_189, "30 с"],
    [125_000, "2 мин 5 с"],
    [120_000, "2 мин"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("guards against nonsense", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatAgo", () => {
  it("is relative and coarse", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 3_000, now)).toBe("только что");
    expect(formatAgo(now - 40_000, now)).toBe("40 с назад");
    expect(formatAgo(now - 125_000, now)).toBe("2 мин назад");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 ч назад");
  });
});

describe("usage formatting", () => {
  const usage = {
    ...EMPTY_USAGE,
    input_tokens: 210,
    cache_read_tokens: 38_000,
    cache_write_tokens: 7_000,
    output_tokens: 1_240,
    thinking_tokens: 300,
    cost_usd: 0.31,
    requests: 3,
    total_latency_ms: 4_200,
    total_first_token_ms: 1_800,
  };

  it("counts cache reads and writes as prompt tokens", () => {
    expect(promptTokens(usage)).toBe(45_210);
    expect(formatTokenUsage(usage)).toBe("вход: 45\u00a0210 (38\u00a0000 из кэша) · выход: 1\u00a0240 (рассуждения: 300)");
    expect(formatTokenUsage({ ...EMPTY_USAGE, input_tokens: 5, output_tokens: 2 })).toBe("вход: 5 · выход: 2");
  });

  it("summarises requests, tokens and the average response time", () => {
    expect(formatUsageSummary(usage)).toBe("запросов: 3 · вход: 45\u00a0210 (38\u00a0000 из кэша) / выход: 1\u00a0240 · в среднем 1.4 с");
    expect(formatUsageSummary({ ...EMPTY_USAGE, requests: 1, input_tokens: 9, output_tokens: 1, total_latency_ms: 800 })).toBe(
      "запросов: 1 · вход: 9 / выход: 1 · в среднем 800 мс",
    );
    expect(formatUsageSummary(EMPTY_USAGE)).toBe("запросов: 0 · вход: 0 / выход: 0");
  });

  it("averages per answered request", () => {
    expect(avgLatencyMs(usage)).toBe(1_400);
    expect(avgFirstTokenMs(usage)).toBe(600);
    expect(avgLatencyMs(EMPTY_USAGE)).toBeNull();
  });

  it("describes the last answer for the footer tooltip", () => {
    expect(lastAnswerTooltip(1_200, 600)).toBe("Последний ответ: всего 1.2 с, первые слова через 600 мс");
    expect(lastAnswerTooltip(31_000, null)).toBe("Последний ответ: всего 31 с");
  });
});
