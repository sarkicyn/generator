import { useState, useCallback, useMemo } from "react";
import { showToast } from "../stores/toastStore";
import { formatActualUsage } from "./stats";
import type { LogEntry } from "../lib/types";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FileText,
  MessageSquare,
  HelpCircle,
  Sparkles,
  BookOpen,
  Search,
  Database,
} from "lucide-react";

// -- Types -------------------------------------------------------------------

interface PromptSection {
  title: string;
  content: string;
  type: "context" | "transcript" | "question" | "instruction";
  badge?: { label: string; color: string; icon: typeof FileText };
}

type ViewMode = "structured" | "raw";

// -- Main component ----------------------------------------------------------

interface PromptViewerProps {
  entry: LogEntry;
}

export function PromptViewer({ entry }: PromptViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("structured");

  return (
    <div className="flex flex-col h-full">
      {/* View mode toggle */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/20">
        <button
          onClick={() => setViewMode("structured")}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            viewMode === "structured"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          По разделам
        </button>
        <button
          onClick={() => setViewMode("raw")}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            viewMode === "raw"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          Исходный текст
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === "structured" ? (
          <StructuredView entry={entry} />
        ) : (
          <RawView entry={entry} />
        )}
      </div>
    </div>
  );
}

// -- Token Budget ------------------------------------------------------------

/** Rough token count of text (~4 characters per token). */
const estimateTokens = (text: string) => Math.ceil((text || "").length / 4);

function TokenBudget({ entry }: { entry: LogEntry }) {
  const actual = entry.usage ? (
    <div data-testid="token-actual">
      <span className="font-medium">Фактически:</span>{" "}
      <span className="tabular-nums text-foreground/70">{formatActualUsage(entry.usage)}</span>
    </div>
  ) : null;

  const scope = entry.scopeLabel ? (
    <div data-testid="token-scope">
      <span className="font-medium">Контекст:</span> <span className="text-foreground/70">{entry.scopeLabel}</span>
    </div>
  ) : null;

  // A session keeps its system prompt: it was sent once, when the session started.
  if (entry.sessionKey) {
    return (
      <div
        className="space-y-0.5 px-3 py-1.5 border-b border-border/20 text-meta text-muted-foreground/60"
        data-testid="token-budget"
      >
        <div>
          <span className="font-medium">Запрос сеанса</span> (отправляется один раз при запуске сеанса){" "}
          <span className="tabular-nums">≈ {estimateTokens(entry.actualSystemPrompt).toLocaleString("ru-RU")}</span>
        </div>
        <div>
          <span className="font-medium">Отправлено в этом запросе</span>{" "}
          <span className="tabular-nums">≈ {estimateTokens(entry.actualUserPrompt).toLocaleString("ru-RU")}</span>
        </div>
        {scope}
        {actual}
      </div>
    );
  }

  const system = estimateTokens(entry.actualSystemPrompt);
  const userTotal = estimateTokens(entry.actualUserPrompt);
  const rag = entry.ragChunks?.reduce((sum, c) => sum + estimateTokens(c.text), 0) ?? 0;
  const total = system + userTotal;

  const items = [
    { label: "Система", tokens: system, color: "text-muted-foreground" },
    { label: "Расшифровка", tokens: Math.max(0, userTotal - rag), color: "text-success" },
    { label: "RAG", tokens: rag, color: "text-info" },
  ].filter((i) => i.tokens > 0);

  return (
    <div className="space-y-0.5 px-3 py-1.5 border-b border-border/20 text-meta text-muted-foreground/60" data-testid="token-budget">
      <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
        <span className="font-medium">Токены:</span>
        {items.map((item, i) => (
          <span key={item.label}>
            {i > 0 && <span className="mx-0.5">&middot;</span>}
            <span className={item.color}>{item.label}</span>{" "}
            <span className="tabular-nums">{item.tokens.toLocaleString("ru-RU")}</span>
          </span>
        ))}
        <span className="mx-0.5">&rarr;</span>
        <span className="font-semibold tabular-nums">~{total.toLocaleString("ru-RU")}</span>
        <span>≈ оценка</span>
      </div>
      {scope}
      {actual}
    </div>
  );
}

// -- RAG Chunks Section ------------------------------------------------------

function RagChunksSection({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());

  if (!entry.includeRag) return null;

  const chunks = entry.ragChunks ?? [];
  const filtered = entry.ragChunksFiltered ?? 0;
  const query = entry.ragQuery;
  const hasChunks = chunks.length > 0;

  const toggleChunk = (idx: number) => {
    setExpandedChunks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const allText = chunks.map((c) =>
    `[${c.source}, chunk ${c.chunk_index}] (score: ${c.normalized_score.toFixed(2)})\n${c.text}`
  ).join("\n---\n");

  return (
    <div className="border-b border-border/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-meta font-medium bg-info/10 text-info border-info/20">
          <Database className="h-2.5 w-2.5" />
          {hasChunks ? `Фрагментов: ${chunks.length}` : "0 подходящих"}
        </span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          ФРАГМЕНТЫ ДОКУМЕНТОВ
        </span>
        <SectionCopyButton text={allText} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {query && (
            <div className="flex items-start gap-1.5 rounded-md bg-secondary/20 px-2.5 py-1.5 mb-2">
              <Search className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/50" />
              <p className="text-meta text-muted-foreground/60 break-words">
                <span className="font-medium">Запрос:</span> {query.length > 200 ? query.slice(0, 200) + "..." : query}
              </p>
            </div>
          )}

          {hasChunks ? (
            <>
              {chunks.map((chunk, idx) => (
                <button
                  key={idx}
                  onClick={() => toggleChunk(idx)}
                  className="flex w-full items-start gap-2 rounded-md bg-secondary/20 px-2.5 py-1.5 text-left hover:bg-secondary/30 transition-colors"
                >
                  {expandedChunks.has(idx) ? (
                    <ChevronDown className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/60" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/60" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-meta font-semibold text-info/80">#{idx + 1}</span>
                      <span className="text-meta text-muted-foreground truncate">{chunk.source} (фрагмент {chunk.chunk_index})</span>
                      <span className="text-meta font-mono tabular-nums text-info/70">{chunk.normalized_score.toFixed(2)}</span>
                    </div>
                    {expandedChunks.has(idx) ? (
                      <p className="mt-1 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                        {chunk.text}
                      </p>
                    ) : (
                      <p className="text-meta text-muted-foreground/50 truncate">
                        {chunk.text.slice(0, 80)}...
                      </p>
                    )}
                  </div>
                </button>
              ))}
              {filtered > 0 && (
                <p className="text-meta text-muted-foreground/50 px-2.5 py-1">
                  Отфильтровано фрагментов: {filtered} (ниже порога)
                </p>
              )}
            </>
          ) : (
            <div className="rounded-md bg-secondary/20 px-2.5 py-2 text-meta text-muted-foreground/50">
              Подходящие фрагменты не найдены
              {filtered > 0 && <span> &mdash; ниже порога: {filtered}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -- Structured View ---------------------------------------------------------

function StructuredView({ entry }: { entry: LogEntry }) {
  const sections = useMemo(
    () => parseUserPromptSections(entry.actualUserPrompt),
    [entry.actualUserPrompt]
  );

  // Filter out RAG sections — we render them via RagChunksSection instead
  const nonRagSections = sections.filter(
    (s) => s.type !== "context" || (!s.title.includes("Relevant Context") && !s.title.includes("RAG") && !s.title.includes("Reference"))
  );

  return (
    <div className="flex flex-col gap-0.5">
      <TokenBudget entry={entry} />

      {entry.actualSystemPrompt && (
        <CollapsibleSection
          title="СИСТЕМНАЯ ИНСТРУКЦИЯ"
          content={entry.actualSystemPrompt}
          defaultExpanded={false}
          badge={{ label: "Система", color: "gray", icon: Sparkles }}
        />
      )}

      {nonRagSections.map((section, i) => (
        <CollapsibleSection
          key={i}
          title={section.title || "СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ"}
          content={section.content}
          defaultExpanded={true}
          badge={section.badge}
        />
      ))}

      <RagChunksSection entry={entry} />

      {(entry.responseContentClean || entry.status === "streaming") && (
        <CollapsibleSection
          title={
            entry.status === "streaming" ? "ОТВЕТ (получение…)" : "RESPONSE"
          }
          content={entry.responseContentClean}
          defaultExpanded={true}
          badge={{ label: "Ответ", color: "emerald", icon: MessageSquare }}
          isResponse
        />
      )}
    </div>
  );
}

// -- Collapsible Section -----------------------------------------------------

function CollapsibleSection({
  title,
  content,
  defaultExpanded,
  badge,
  isResponse,
}: {
  title: string;
  content: string;
  defaultExpanded: boolean;
  badge?: PromptSection["badge"];
  isResponse?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!content && !isResponse) return null;

  const badgeColors: Record<string, string> = {
    amber: "bg-warning/10 text-warning border-warning/20",
    blue: "bg-info/10 text-info border-info/20",
    green: "bg-success/10 text-success border-success/20",
    rose: "bg-destructive/10 text-destructive border-destructive/20",
    gray: "bg-secondary/60 text-muted-foreground/70 border-border/20",
    emerald: "bg-success/10 text-success border-success/20",
  };

  const badgeClass = badge ? badgeColors[badge.color] || badgeColors.gray : "";
  const Icon = badge?.icon || FileText;

  return (
    <div className="border-b border-border/20">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}

        {badge && (
          <span
            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-meta font-medium ${badgeClass}`}
          >
            <Icon className="h-2.5 w-2.5" />
            {badge.label}
          </span>
        )}

        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          {russianPromptTitle(title)}
        </span>

        <SectionCopyButton text={content} />
      </button>

      {/* Content */}
      {expanded ? (
        <div className="px-3 pb-3">
          <div
            className={`max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 ${
              isResponse
                ? "text-sm leading-relaxed text-foreground/90"
                : "font-mono text-xs leading-relaxed text-foreground/80"
            } whitespace-pre-wrap break-words`}
          >
            {content || (
              <span className="italic text-muted-foreground/60">
                (пусто)
              </span>
            )}
          </div>
        </div>
      ) : content ? (
        /* Collapsed preview: 3-line fade */
        <div className="relative px-3 pb-2">
          <p className="line-clamp-3 font-mono text-xs text-muted-foreground/50 break-words">
            {content}
          </p>
          <div className="absolute bottom-0 left-3 right-3 h-6 bg-gradient-to-t from-card to-transparent pointer-events-none" />
        </div>
      ) : null}
    </div>
  );
}

// -- Raw View ----------------------------------------------------------------

function RawView({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      {/* System message */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            Системное сообщение
          </span>
          <SectionCopyButton text={entry.actualSystemPrompt} />
        </div>
        <pre className="max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
          {entry.actualSystemPrompt || "(пусто)"}
        </pre>
      </div>

      {/* User message */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            Сообщение пользователя
          </span>
          <SectionCopyButton text={entry.actualUserPrompt} />
        </div>
        <pre className="max-h-80 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
          {entry.actualUserPrompt || "(пусто)"}
        </pre>
      </div>

      {/* Response */}
      {entry.responseContentClean && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              Ответ
              {entry.status === "streaming" && (
                <span className="ml-1.5 animate-pulse text-primary/60">
                  получение ответа…
                </span>
              )}
            </span>
            <SectionCopyButton text={entry.responseContentClean} />
          </div>
          <pre className="max-h-60 overflow-y-auto rounded-md bg-secondary/20 p-2.5 font-mono text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
            {entry.responseContentClean}
          </pre>
        </div>
      )}
    </div>
  );
}

// -- Prompt section parser ---------------------------------------------------

function parseUserPromptSections(text: string): PromptSection[] {
  if (!text) return [];

  const sections: PromptSection[] = [];
  const lines = text.split("\n");
  let currentHeader: string | null = null;
  let contentLines: string[] = [];

  const flushSection = () => {
    const content = contentLines.join("\n").trim();
    if (currentHeader) {
      sections.push(buildSection(currentHeader, content));
    } else if (content) {
      // Text before any ## header → mode instruction
      sections.push({
        title: "",
        content,
        type: "instruction",
        badge: { label: "Инструкция", color: "gray", icon: BookOpen },
      });
    }
    contentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushSection();
      currentHeader = line.substring(3).trim();
    } else {
      contentLines.push(line);
    }
  }
  flushSection();

  // If last section content has trailing instruction text (plain sentence without markup)
  // separate it as a mode instruction
  if (sections.length > 0) {
    const last = sections[sections.length - 1];
    if (last.type !== "instruction" && last.content) {
      const contentLines2 = last.content.split("\n");
      // Check if last non-empty line is a plain instruction (no leading markdown)
      const trailingInstr: string[] = [];
      while (contentLines2.length > 0) {
        const line = contentLines2[contentLines2.length - 1].trim();
        if (!line) {
          contentLines2.pop();
          continue;
        }
        // A trailing instruction is typically a short sentence, no markdown
        if (
          !line.startsWith("[") &&
          !line.startsWith("-") &&
          !line.startsWith("#") &&
          !line.startsWith("|") &&
          line.length < 200 &&
          /^[A-Z]/.test(line)
        ) {
          trailingInstr.unshift(contentLines2.pop()!);
        } else {
          break;
        }
      }
      if (trailingInstr.length > 0 && contentLines2.length > 0) {
        last.content = contentLines2.join("\n").trim();
        sections.push({
          title: "",
          content: trailingInstr.join("\n").trim(),
          type: "instruction",
          badge: { label: "Инструкция режима", color: "gray", icon: BookOpen },
        });
      }
    }
  }

  return sections;
}

function buildSection(title: string, content: string): PromptSection {
  if (title.includes("Reference") || title.includes("Custom")) {
    return {
      title,
      content,
      type: "context",
      badge: { label: "Контекст", color: "amber", icon: FileText },
    };
  }
  if (title.includes("Relevant Context") || title.includes("RAG")) {
    const chunkCount = (content.match(/^### /gm) || []).length;
    return {
      title,
      content,
      type: "context",
      badge: {
        label: chunkCount > 0 ? `Фрагментов: ${chunkCount}` : "Контекст документов",
        color: "blue",
        icon: FileText,
      },
    };
  }
  if (title.includes("Transcript")) {
    const segCount = content
      .split("\n")
      .filter((l) => l.trim().startsWith("[")).length;
    return {
      title,
      content,
      type: "transcript",
      badge: {
        label: segCount > 0 ? `Фрагментов: ${segCount}` : "Расшифровка",
        color: "green",
        icon: MessageSquare,
      },
    };
  }
  if (title.includes("User's Question")) {
    return {
      title,
      content,
      type: "question",
      badge: { label: "Вопрос", color: "rose", icon: HelpCircle },
    };
  }
  if (title.includes("Detected Question")) {
    const confMatch = title.match(/(\d+)%/);
    return {
      title,
      content,
      type: "question",
      badge: {
        label: confMatch ? `Уверенность: ${confMatch[1]}%` : "Распознан",
        color: "rose",
        icon: HelpCircle,
      },
    };
  }
  if (title.includes("Shorten")) {
    return {
      title,
      content,
      type: "question",
      badge: { label: "Текст для сокращения", color: "amber", icon: FileText },
    };
  }
  return {
    title,
    content,
    type: "instruction",
    badge: { label: title || "Section", color: "gray", icon: BookOpen },
  };
}

// -- Copy button -------------------------------------------------------------

function SectionCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => showToast("Не удалось скопировать. Выделите текст вручную.", "error"));
    },
    [text]
  );

  if (!text) return null;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleCopy}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleCopy(e as unknown as React.MouseEvent); }}
      className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
      aria-label="Копировать раздел"
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </span>
  );
}

// Translate structural headings for display; keep the inspected prompt intact.
function russianPromptTitle(title: string): string {
  return title
    .replace(/^Reference Context/i, "Справочный контекст")
    .replace(/^Custom Instructions/i, "Свои инструкции")
    .replace(/^Relevant Context/i, "Подходящий контекст")
    .replace(/^Live Transcript/i, "Текущая расшифровка")
    .replace(/^Transcript/i, "Расшифровка")
    .replace(/^User's Question/i, "Вопрос пользователя")
    .replace(/^Detected Question/i, "Распознанный вопрос")
    .replace(/^Text to Shorten/i, "Текст для сокращения");
}
