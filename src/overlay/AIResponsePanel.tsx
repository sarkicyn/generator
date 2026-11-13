import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import type { UIEvent, WheelEvent } from "react";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import {
  Sparkles,
  Pin,
  PinOff,
  Copy,
  Check,
  Globe,
  History,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getModeLabel } from "../lib/utils";
import type { AIResponse, StreamSource } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { ColorPickerButton } from "../components/ColorPickerButton";
import { ResponseProgress } from "./ResponseProgress";
import { ResponseHistoryList } from "./ResponseHistoryList";
import { formatDuration, responseServiceLabel } from "./responseFormat";

/** "current", "resp-<id>" (a history answer) or "pinned-<id>". */
type TabId = "current" | `resp-${string}` | `pinned-${string}`;

/** Answers shown as tabs next to "Текущее"; the rest are in History. */
const PREVIOUS_TABS = 4;
const FOLLOW_BOTTOM_THRESHOLD = 24;

// Sub-PRD 6: Streaming markdown, response history tabs, pin/copy
export function AIResponsePanel() {
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const phase = useStreamStore((s) => s.phase);
  const currentContent = useStreamStore((s) => s.currentContent);
  const currentMode = useStreamStore((s) => s.currentMode);
  const currentId = useStreamStore((s) => s.currentId);
  const currentProvider = useStreamStore((s) => s.currentProvider);
  const currentModel = useStreamStore((s) => s.currentModel);
  const error = useStreamStore((s) => s.error);
  const currentSources = useStreamStore((s) => s.currentSources);
  const responseHistory = useStreamStore((s) => s.responseHistory);
  const pinnedResponses = useStreamStore((s) => s.pinnedResponses);
  const pinResponse = useStreamStore((s) => s.pinResponse);
  const unpinResponse = useStreamStore((s) => s.unpinResponse);
  const meetingStart = useMeetingStore((s) => s.meetingStartTime);
  const openSettings = useMeetingStore((s) => s.openSettings);
  const configuredProvider = useConfigStore((s) => s.llmProvider);
  const configuredModel = useConfigStore((s) => s.llmModel);

  const aiResponseFontSize = useConfigStore((s) => s.aiResponseFontSize ?? 12);
  const aiResponseTextColor = useConfigStore((s) => s.aiResponseTextColor ?? "#d4d4d8");
  const aiResponseLineHeight = useConfigStore((s) => s.aiResponseLineHeight ?? 1.6);
  const aiResponseHPad = useConfigStore((s) => s.aiResponseHPad ?? 0);
  const aiResponseAlign = useConfigStore((s) => s.aiResponseAlign ?? "left");
  const setAiResponseFontSize = useConfigStore((s) => s.setAiResponseFontSize);
  const setAiResponseTextColor = useConfigStore((s) => s.setAiResponseTextColor);
  const setAiResponseLineHeight = useConfigStore((s) => s.setAiResponseLineHeight);
  const setAiResponseHPad = useConfigStore((s) => s.setAiResponseHPad);
  const setAiResponseAlign = useConfigStore((s) => s.setAiResponseAlign);

  const proseStyle = {
    fontSize: `${aiResponseFontSize}px`,
    color: aiResponseTextColor,
    lineHeight: aiResponseLineHeight,
    paddingLeft: `${aiResponseHPad}px`,
    paddingRight: `${aiResponseHPad}px`,
    textAlign: aiResponseAlign as React.CSSProperties["textAlign"],
  };

  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const historyButtonRef = useRef<HTMLButtonElement>(null);

  // A request in flight: clicked (sending) or streaming.
  const inFlight = isStreaming || phase !== "idle";

  function handleResponseScroll(event: UIEvent<HTMLDivElement>) {
    if (activeTab !== "current") return;
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
    if (distanceFromBottom <= 1) {
      followBottom.current = true;
    } else if (scrollTop < lastScrollTop.current || distanceFromBottom > FOLLOW_BOTTOM_THRESHOLD) {
      followBottom.current = false;
    } else if (scrollTop > lastScrollTop.current) {
      followBottom.current = true;
    }
    lastScrollTop.current = scrollTop;
  }

  function handleResponseWheel(event: WheelEvent<HTMLDivElement>) {
    if (activeTab === "current" && event.deltaY < 0 && event.currentTarget.scrollTop > 0) {
      followBottom.current = false;
    }
  }

  useLayoutEffect(() => {
    const panel = scrollRef.current;
    if (!panel || activeTab !== "current") return;
    if (!currentContent) {
      followBottom.current = true;
      lastScrollTop.current = panel.scrollTop;
      return;
    }
    if (!isStreaming || !followBottom.current) return;

    // Native scrolling can change scrollTop before the scroll event reaches React.
    const { scrollTop, scrollHeight, clientHeight } = panel;
    if (scrollTop < lastScrollTop.current && scrollHeight - clientHeight - scrollTop > 1) {
      followBottom.current = false;
      return;
    }
    panel.scrollTop = scrollHeight;
    lastScrollTop.current = panel.scrollTop;
  }, [activeTab, currentContent, isStreaming]);

  // Switch to "current" tab when a new request starts
  useEffect(() => {
    if (inFlight) {
      setActiveTab("current");
      setHistoryOpen(false);
    }
  }, [inFlight]);

  const handleCopy = useCallback(
    async (content: string, id: string) => {
      try {
        await navigator.clipboard.writeText(content);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch {
        // Clipboard access may fail in some contexts
      }
    },
    []
  );

  const pinnedIds = useMemo(() => new Set(pinnedResponses.map((r) => r.id)), [pinnedResponses]);

  const handlePin = useCallback(
    (id: string) => {
      if (pinnedIds.has(id)) {
        unpinResponse(id);
      } else {
        pinResponse(id);
      }
    },
    [pinnedIds, pinResponse, unpinResponse]
  );

  // Tabs: Current, the previous answers (never the current one again), pinned.
  const previousResponses = useMemo(
    () => responseHistory.filter((r) => r.id !== currentId).slice(0, PREVIOUS_TABS),
    [responseHistory, currentId]
  );
  const currentResponse = currentId ? responseHistory.find((r) => r.id === currentId) ?? null : null;
  const hasTabs = previousResponses.length > 0 || pinnedResponses.length > 0;

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    historyButtonRef.current?.focus();
  }, []);

  // The answer a history / pinned tab shows (by id, so new answers never shift it)
  let displayResponse: AIResponse | null = null;
  if (activeTab !== "current") {
    const id = activeTab.replace(/^(resp|pinned)-/, "");
    displayResponse =
      responseHistory.find((r) => r.id === id) ?? pinnedResponses.find((r) => r.id === id) ?? null;
  }
  const displayContent = displayResponse?.content || null;
  const selectedId = activeTab === "current" ? currentId : displayResponse?.id ?? null;
  // An answer opened from History that has no tab of its own.
  const openedFromHistory =
    activeTab.startsWith("resp-") && !previousResponses.some((r) => `resp-${r.id}` === activeTab);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Tabs row */}
      {hasTabs && (
        <div className="mb-2 flex shrink-0 items-center gap-1.5 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" role="tablist" aria-label="Вкладки ответов ИИ">
            <TabButton
              label="Текущее"
              active={activeTab === "current"}
              onClick={() => setActiveTab("current")}
            />
            {previousResponses.map((resp) => (
              <TabButton
                key={resp.id}
                label={getModeLabel(resp.mode)}
                active={activeTab === `resp-${resp.id}`}
                onClick={() => setActiveTab(`resp-${resp.id}`)}
                secondary
              />
            ))}
            {pinnedResponses.map((resp) => (
              <TabButton
                key={resp.id}
                label={`${getModeLabel(resp.mode)}`}
                active={activeTab === `pinned-${resp.id}`}
                onClick={() => setActiveTab(`pinned-${resp.id}`)}
                pinned
              />
            ))}
          </div>
          {responseHistory.length > 0 && (
            <button
              ref={historyButtonRef}
              type="button"
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
              aria-label={`История ответов: ${responseHistory.length}`}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium transition-colors duration-150 ${
                historyOpen || openedFromHistory
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/60 hover:bg-muted/30 hover:text-muted-foreground"
              }`}
            >
              <History className="h-2.5 w-2.5" aria-hidden="true" />
              История · <span className="tabular-nums">{responseHistory.length}</span>
            </button>
          )}
        </div>
      )}

      {/* Content area */}
      <div className="relative flex-1 min-h-0">
      {historyOpen && (
        <ResponseHistoryList
          responses={responseHistory}
          pinnedIds={pinnedIds}
          selectedId={selectedId}
          meetingStart={meetingStart}
          onSelect={(id) => {
            setActiveTab(id === currentId ? "current" : `resp-${id}`);
            closeHistory();
          }}
          onClose={closeHistory}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={handleResponseScroll}
        onWheel={handleResponseWheel}
        className="absolute inset-0 overflow-y-auto"
        role="tabpanel"
        aria-label="Ответ ИИ"
        tabIndex={0}
      >
        {/* A failed request must not hide tabs or prevent opening older answers. */}
        {activeTab === "current" && error && (
          <div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
            <p role="alert" className="break-words text-xs text-destructive">{error}</p>
            <p className="mt-2 break-all text-meta text-muted-foreground">
              {responseServiceLabel(currentProvider || configuredProvider, currentModel || configuredModel)}
            </p>
            <button type="button" onClick={() => openSettings("llm")} className="mt-2 text-xs text-primary hover:underline">
              Настроить модель
            </button>
          </div>
        )}
        {/* Keep the same Markdown nodes when progress becomes the finished header. */}
        {activeTab === "current" && (inFlight || currentContent) && (
          <div className="space-y-2.5">
            {inFlight && <ResponseProgress />}
            {!inFlight && currentMode && (
              <AnswerHeader
                response={currentResponse}
                service={{ provider: currentProvider, model: currentModel }}
                mode={currentMode}
                copied={copiedId === "current"}
                pinned={currentResponse ? pinnedIds.has(currentResponse.id) : false}
                onCopy={() => handleCopy(currentContent, "current")}
                onPin={currentResponse ? () => handlePin(currentResponse.id) : undefined}
              />
            )}
            {currentContent && (
              <div className="prose prose-sm prose-invert max-w-none leading-relaxed" style={proseStyle}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentContent}
                </ReactMarkdown>
                {inFlight && <span aria-hidden="true" className="inline-block h-3 w-0.5 animate-pulse bg-primary/60 ml-0.5" />}
              </div>
            )}
            {!inFlight && <SourcesList sources={currentSources} />}
          </div>
        )}

        {/* History / pinned tab content */}
        {activeTab !== "current" && displayContent && displayResponse && (
          <div className="space-y-2.5">
            <AnswerHeader
              response={displayResponse}
              mode={displayResponse.mode}
              copied={copiedId === displayResponse.id}
              pinned={pinnedIds.has(displayResponse.id)}
              onCopy={() => handleCopy(displayContent, displayResponse!.id)}
              onPin={() => handlePin(displayResponse!.id)}
            />
            <div className="prose prose-sm prose-invert max-w-none leading-relaxed" style={proseStyle}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            </div>
            <SourcesList sources={displayResponse.sources} />
          </div>
        )}

        {/* Empty state */}
        {activeTab === "current" && !inFlight && !currentContent && !error && (
          <div className="flex min-h-full flex-col items-center justify-center gap-2 p-2 text-center">
            <Sparkles className="h-5 w-5 text-primary/30" />
            <p className="max-w-full break-all text-xs text-foreground/80" aria-label="Модель для ответа">
              {responseServiceLabel(configuredProvider, configuredModel)}
            </p>
            <button type="button" onClick={() => openSettings("llm")} className="text-xs text-primary hover:underline">
              Выбрать модель
            </button>
            <p className="text-xs text-muted-foreground/50">
              Нажмите <kbd className="mx-0.5 rounded border border-border/30 bg-secondary/30 px-1.5 py-0.5 font-mono text-meta text-foreground/70">Пробел</kbd> для ответа ИИ
            </p>
          </div>
        )}
      </div>
      </div>

      {/* Typeset controls */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border/10 px-1 pt-1.5">
        {/* Row 1: font size + color */}
        <div className="flex items-center gap-3">
          <span className="text-[0.6rem] uppercase tracking-widest text-muted-foreground/40 font-medium">Текст ИИ</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setAiResponseFontSize(Math.max(8, aiResponseFontSize - 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.6rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Мельче">A</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseFontSize}</span>
            <button onClick={() => setAiResponseFontSize(Math.min(32, aiResponseFontSize + 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.75rem] font-medium text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Крупнее">A</button>
          </div>
          <ColorPickerButton value={aiResponseTextColor} onChange={setAiResponseTextColor} label="Цвет текста ИИ" />
        </div>
        {/* Row 2: line height + horizontal padding + text align */}
        <div className="flex items-center gap-3">
          {/* Line height */}
          <div className="flex items-center gap-1">
            <span className="text-[0.6rem] text-muted-foreground/40">Интервал</span>
            <button onClick={() => setAiResponseLineHeight(Math.max(1.0, parseFloat((aiResponseLineHeight - 0.1).toFixed(1))))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Уменьшить межстрочный интервал">−</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseLineHeight.toFixed(1)}</span>
            <button onClick={() => setAiResponseLineHeight(Math.min(3.0, parseFloat((aiResponseLineHeight + 0.1).toFixed(1))))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Увеличить межстрочный интервал">+</button>
          </div>
          {/* Horizontal padding */}
          <div className="flex items-center gap-1">
            <span className="text-[0.6rem] text-muted-foreground/40">↔</span>
            <button onClick={() => setAiResponseHPad(Math.max(0, aiResponseHPad - 4))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Уменьшить отступы">−</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseHPad}</span>
            <button onClick={() => setAiResponseHPad(Math.min(80, aiResponseHPad + 4))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Увеличить отступы">+</button>
          </div>
          {/* Text align */}
          <div className="flex items-center gap-0.5 rounded border border-border/20 overflow-hidden">
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAiResponseAlign(a)}
                className={`px-1.5 py-0.5 text-[0.6rem] font-medium transition-colors ${aiResponseAlign === a ? "bg-primary/20 text-primary" : "text-muted-foreground/40 hover:text-muted-foreground/70"}`}
                title={`Выравнивание: ${{left: "слева", center: "по центру", right: "справа"}[a]}`}
              >
                {a === "left" ? "L" : a === "center" ? "C" : "R"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function SourcesList({ sources }: { sources?: StreamSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/10 pt-2">
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
      {sources.map((source, idx) => (
        <a
          key={`${source.url}-${idx}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.url}
          className="max-w-[14rem] truncate rounded-full bg-accent/30 px-2 py-0.5 text-meta text-muted-foreground/70 hover:bg-accent/50 hover:text-foreground/80 transition-colors"
        >
          {source.title}
        </a>
      ))}
    </div>
  );
}

/** Mode badge, scope and timing ("1.2 s · first words 0.6 s"), with copy / pin. */
function AnswerHeader({
  response,
  service,
  mode,
  copied,
  pinned,
  onCopy,
  onPin,
}: {
  response: AIResponse | null;
  service?: { provider: string; model: string };
  mode: AIResponse["mode"];
  copied: boolean;
  pinned: boolean;
  onCopy: () => void;
  onPin?: () => void;
}) {
  const total = response ? response.total_ms || response.latency_ms : null;
  const timing = [
    total ? formatDuration(total) : null,
    response?.first_token_ms != null ? `начало ответа ${formatDuration(response.first_token_ms)}` : null,
  ].filter(Boolean).join(" · ");
  const provider = response?.provider || service?.provider || "";
  const model = response?.model || service?.model || "";
  return (
    <div className="space-y-1.5">
      <p className="break-all text-meta text-foreground/70" aria-label="Сервис и модель ответа">
        {responseServiceLabel(provider, model)}
      </p>
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-meta font-medium text-primary/80">
          {getModeLabel(mode)}
        </span>
        {(timing || response?.scope_label) && (
          <span className="min-w-0 truncate text-meta tabular-nums text-muted-foreground/45">
            {[response?.scope_label, timing].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ActionButton
          icon={copied ? Check : Copy}
          title="Копировать в буфер обмена"
          onClick={onCopy}
          active={copied}
        />
        {onPin && (
          <ActionButton
            icon={pinned ? PinOff : Pin}
            title={pinned ? "Открепить" : "Закрепить ответ"}
            onClick={onPin}
          />
        )}
      </div>
    </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  secondary,
  pinned,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  secondary?: boolean;
  pinned?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-meta font-medium transition-colors duration-150 ${
        active
          ? "bg-primary/20 text-primary"
          : secondary
            ? "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
            : pinned
              ? "text-warning/70 hover:bg-warning/10 hover:text-warning"
              : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
      }`}
    >
      {pinned && <Pin className="mr-0.5 inline-block h-2.5 w-2.5" aria-hidden="true" />}
      {label}
    </button>
  );
}

function ActionButton({
  icon: Icon,
  title,
  onClick,
  active,
}: {
  icon: typeof Copy;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg p-1.5 transition-colors duration-150 ${
        active
          ? "text-success"
          : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent"
      }`}
      aria-label={title}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
