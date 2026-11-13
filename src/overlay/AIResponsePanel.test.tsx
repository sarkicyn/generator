import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => undefined, set: async () => {}, onKeyChange: async () => () => {} }),
}));

import { AIResponsePanel } from "./AIResponsePanel";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";

const T0 = 1_700_000_000_000;
const s = () => useStreamStore.getState();

function answer(mode: string, text: string, model = "haiku", provider = "Claude CLI") {
  act(() => {
    const id = crypto.randomUUID();
    s().setPending(mode, id);
    s().startStream(mode as never, model, provider, { requestId: id });
    s().appendToken(text);
    s().endStream(5);
  });
}

const tabs = () => within(screen.getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent);

describe("AIResponsePanel", () => {
  beforeEach(() => {
    s().resetForMeeting();
    useMeetingStore.setState({ meetingStartTime: T0 });
    useConfigStore.setState({ llmProvider: "openai", llmModel: "gpt-4.1" });
  });
  afterEach(() => vi.useRealTimers());

  it("Current is the newest answer and is not repeated as a tab", () => {
    render(<AIResponsePanel />);
    answer("Assist", "first");
    answer("Shorten", "second");
    expect(tabs()).toEqual(["Текущее", "Подсказка"]);
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("shows Current + the 4 previous answers; History lists them all and opens any", () => {
    render(<AIResponsePanel />);
    for (let i = 0; i < 7; i++) answer(i % 2 ? "Recap" : "Assist", `answer ${i}`);
    expect(tabs()).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "История ответов: 7" }));
    const list = screen.getByRole("dialog", { name: "Все ответы" });
    const items = within(list).getAllByRole("button").filter((b) => b.getAttribute("aria-label") !== "Закрыть историю ответов");
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveAttribute("aria-current", "true"); // the answer on screen
    expect(items[6]).toHaveTextContent("answer 0");

    fireEvent.click(items[6]);
    expect(screen.queryByRole("dialog", { name: "Все ответы" })).toBeNull();
    expect(screen.getByText("answer 0")).toBeInTheDocument();

    // Pin it from there: it gets its own pinned tab.
    fireEvent.click(screen.getByRole("button", { name: "Закрепить ответ" }));
    expect(s().pinnedResponses.map((r) => r.content)).toEqual(["answer 0"]);
    expect(tabs()).toHaveLength(6);
  });

  it("history list: arrows move, Escape closes", () => {
    render(<AIResponsePanel />);
    answer("Assist", "a");
    answer("Recap", "b");
    fireEvent.click(screen.getByRole("button", { name: /История ответов: 2/ }));
    const list = screen.getByRole("dialog", { name: "Все ответы" });
    const [newest, older] = within(list).getAllByRole("button").slice(1);
    expect(document.activeElement).toBe(newest);
    fireEvent.keyDown(newest, { key: "ArrowDown" });
    expect(document.activeElement).toBe(older);
    fireEvent.keyDown(older, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Все ответы" })).toBeNull();
  });

  it("while waiting: phase, model, scope, lines sent and a live timer; then the timing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    render(<AIResponsePanel />);

    act(() => s().setPending("FollowUp", "r1"));
    expect(screen.getByText("Отправка…")).toBeInTheDocument();
    expect(screen.getByText("OpenAI / gpt-4.1")).toBeInTheDocument();
    expect(screen.getByText("Уточнить")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
      s().startStream("FollowUp", "haiku", "Claude CLI", {
        requestId: "r1",
        scopeLabel: "Last 5 min",
        newLines: 0,
        sessionKey: "live:m:fast",
      });
    });
    expect(screen.getByText("Ожидание начала ответа…")).toBeInTheDocument();
    expect(screen.getByText("haiku · Claude CLI · Last 5 min · нет новой речи после последнего ответа")).toBeInTheDocument();
    expect(screen.getByText("0.3 с")).toBeInTheDocument();

    act(() => s().setPhase("thinking"));
    expect(screen.getByText("Обдумывание…")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
      s().appendToken("Hello");
    });
    expect(screen.getByText("Генерация…")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(600);
      s().endStream(1000);
    });
    expect(screen.queryByText("Генерация…")).toBeNull();
    expect(screen.getByText("Last 5 min · 1.2 с · начало ответа 0.6 с")).toBeInTheDocument();
    expect(screen.getByLabelText("Сервис и модель ответа")).toHaveTextContent("Claude CLI / haiku");
  });

  it("renders the direct answers in bold as their Markdown delimiters arrive", () => {
    render(<AIResponsePanel />);
    act(() => {
      s().startStream("Assist", "haiku", "Claude CLI");
      s().appendToken("1. **Проверьте мобильный шаг");
    });
    const panel = screen.getByRole("tabpanel", { name: "Ответ ИИ" });
    expect(panel.querySelector("strong")).toBeNull();

    act(() => s().appendToken(" оплаты**. Сравните долю ошибок.\n2. **Сверьте события с заказами**. Проверьте полноту данных."));
    const emphasis = [...panel.querySelectorAll("strong")];
    expect(emphasis.map((node) => node.textContent)).toEqual([
      "Проверьте мобильный шаг оплаты",
      "Сверьте события с заказами",
    ]);
    act(() => s().endStream(50));
    expect(panel.querySelector("strong")).toBe(emphasis[0]);
  });

  it("preserves the reading position through stream updates and completion, and resumes at the bottom", () => {
    render(<AIResponsePanel />);
    const panel = screen.getByRole("tabpanel", { name: "Ответ ИИ" });
    let height = 600;
    let top = 0;
    Object.defineProperties(panel, {
      clientHeight: { value: 200 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => { top = Math.min(value, height - 200); },
      },
    });
    act(() => {
      s().startStream("Assist", "haiku", "Claude CLI");
      s().appendToken("Текущий ответ");
    });
    expect(panel.scrollTop).toBe(400);

    // A token can arrive after native movement and before the scroll event.
    panel.scrollTop = 385;
    height = 650;
    act(() => s().appendToken(" продолжается"));
    expect(panel.scrollTop).toBe(385);
    fireEvent.scroll(panel);
    height = 700;
    act(() => s().appendToken(" дальше"));
    expect(panel.scrollTop).toBe(385);

    panel.scrollTop = 500;
    fireEvent.scroll(panel);
    height = 750;
    act(() => s().appendToken(" и дальше"));
    expect(panel.scrollTop).toBe(550);

    // A wheel gesture pauses following even before the browser moves the pane.
    fireEvent.wheel(panel, { deltaY: -60 });
    height = 800;
    act(() => s().appendToken(" до конца"));
    expect(panel.scrollTop).toBe(550);
    panel.scrollTop = 490;
    fireEvent.scroll(panel);
    act(() => s().endStream(100));
    expect(panel.scrollTop).toBe(490);
  });

  it("shows the configured model before any answer and opens its settings directly", () => {
    useMeetingStore.setState({ currentView: "overlay", settingsOpen: false, settingsTab: null });
    render(<AIResponsePanel />);
    expect(screen.getByLabelText("Модель для ответа")).toHaveTextContent("OpenAI / gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать модель" }));
    expect(useMeetingStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "llm" });
  });

  it("keeps each answer's actual service after the configured model changes", () => {
    render(<AIResponsePanel />);
    answer("Assist", "original answer", "openai/gpt-4.1-mini:variant", "openrouter");
    act(() => useConfigStore.setState({ llmProvider: "gemini", llmModel: "gemini-2.5-flash" }));
    expect(screen.getByLabelText("Сервис и модель ответа")).toHaveTextContent("OpenRouter / openai/gpt-4.1-mini:variant");
    answer("Recap", "new answer", "gemini-2.5-flash", "gemini");
    expect(screen.getByLabelText("Сервис и модель ответа")).toHaveTextContent("Gemini / gemini-2.5-flash");
    fireEvent.click(screen.getByRole("tab", { name: "Подсказка" }));
    expect(screen.getByText("original answer")).toBeInTheDocument();
    expect(screen.getByLabelText("Сервис и модель ответа")).toHaveTextContent("OpenRouter / openai/gpt-4.1-mini:variant");
  });

  it("keeps previous answers selectable after the next request fails", () => {
    render(<AIResponsePanel />);
    answer("Assist", "saved answer", "gpt-4.1", "openai");
    act(() => {
      s().setPending("Recap", "failing-request");
      s().setError("Сервис отклонил запрос");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Сервис отклонил запрос");
    fireEvent.click(screen.getByRole("tab", { name: "Подсказка" }));
    expect(screen.getByText("saved answer")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Сервис и модель ответа")).toHaveTextContent("OpenAI / gpt-4.1");
    expect(screen.getByRole("button", { name: "Копировать в буфер обмена" })).toBeInTheDocument();
  });
});
