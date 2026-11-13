import { useState, useEffect, useCallback } from "react";
import { useConfigStore } from "../stores/configStore";
import { useRagStore } from "../stores/ragStore";
import { useRagEvents } from "../hooks/useRagEvents";
import type { ContextStrategy, RagConfig } from "../lib/types";
import {
  createGeminiContextCache,
  deleteGeminiContextCache,
  getGeminiCacheStatus,
  type GeminiCacheInfo,
} from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import {
  Database,
  Cloud,
  Wifi,
  WifiOff,
  Download,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  X,
  Zap,
  Target,
  Gauge,
  FlameKindling,
} from "lucide-react";

// ─── Preset Definitions ───────────────────────────────────────────────────────
const PRESETS = [
  {
    id: "fastest",
    label: "Самый быстрый",
    ms: "~10 мс",
    icon: Zap,
    description: "Поиск по ключевым словам без векторизации запросов",
    config: {
      search_mode: "keyword",
      top_k: 3,
      chunk_size: 256,
      chunk_overlap: 16,
      embedding_model: "all-minilm",
      semantic_weight: 0.3,
      batch_size: 32,
      similarity_threshold: 0.1,
    },
  },
  {
    id: "faster",
    label: "Быстрый",
    ms: "~80 мс",
    icon: Gauge,
    description: "Смешанный поиск с компактной моделью",
    config: {
      search_mode: "hybrid",
      top_k: 3,
      chunk_size: 512,
      chunk_overlap: 64,
      embedding_model: "all-minilm",
      semantic_weight: 0.7,
      batch_size: 32,
      similarity_threshold: 0.2,
    },
  },
  {
    id: "default",
    label: "По умолчанию",
    ms: "~200 мс",
    icon: Target,
    description: "Баланс скорости и точности",
    config: {
      search_mode: "hybrid",
      top_k: 5,
      chunk_size: 512,
      chunk_overlap: 64,
      embedding_model: "nomic-embed-text",
      semantic_weight: 0.7,
      batch_size: 32,
      similarity_threshold: 0.3,
    },
  },
  {
    id: "accurate",
    label: "Точный",
    ms: "~350 мс",
    icon: Target,
    description: "Больше результатов и мелких фрагментов, шире охват",
    config: {
      search_mode: "hybrid",
      top_k: 10,
      chunk_size: 256,
      chunk_overlap: 64,
      embedding_model: "nomic-embed-text",
      semantic_weight: 0.7,
      batch_size: 32,
      similarity_threshold: 0.2,
    },
  },
  {
    id: "most_accurate",
    label: "Максимальная точность",
    ms: "~600 мс",
    icon: Target,
    description: "Подробная модель, мелкие фрагменты, максимум контекста",
    config: {
      search_mode: "hybrid",
      top_k: 15,
      chunk_size: 256,
      chunk_overlap: 128,
      embedding_model: "mxbai-embed-large",
      semantic_weight: 0.7,
      batch_size: 32,
      similarity_threshold: 0.2,
    },
  },
] as const;

const PRESET_KEYS: (keyof RagConfig)[] = [
  "search_mode", "top_k", "chunk_size", "chunk_overlap",
  "embedding_model", "semantic_weight", "batch_size", "similarity_threshold",
];

function getActivePresetId(config: RagConfig): string | null {
  for (const p of PRESETS) {
    const match = PRESET_KEYS.every(
      (k) => (config as any)[k] === (p.config as any)[k]
    );
    if (match) return p.id;
  }
  return null;
}

// ─── Help Content ─────────────────────────────────────────────────────────────
const HELP: Record<string, { title: string; body: string }> = {
  embedding_model: {
    title: "Модель для индексации",
    body: "Преобразует документы и запросы в векторы для поиска по смыслу. Работает локально через Ollama.\n\n• nomic-embed-text (768 измерений) — баланс качества и скорости, около 150 мс на запрос.\n• mxbai-embed-large (1024) — высокая точность, около 250 мс, больше памяти.\n• all-minilm (384) — быстрая компактная модель, около 60 мс.\n\nПосле смены модели необходимо полностью пересобрать индекс.",
  },
  top_k: {
    title: "Число результатов (top-K)",
    body: "Сколько подходящих фрагментов документов передавать ИИ вместе с вопросом.\n\n• 3 — примерно 300–600 токенов, быстрый ответ.\n• 5 — примерно 600–1000 токенов, сбалансированный вариант.\n• 10 — примерно 1200–2000 токенов, для сложных вопросов.\n• 15–20 — для больших документов с разрозненными сведениями.\n\nБольше фрагментов увеличивает расход токенов и время ответа.",
  },
  search_mode: {
    title: "Режим поиска",
    body: "Как искать подходящие фрагменты в индексе.\n\n• Смешанный — объединяет смысловой поиск и ключевые слова. Подходит для большинства документов, около 150–250 мс.\n• По смыслу — сопоставляет векторы. Хорошо понимает переформулированные вопросы, но может пропускать точные коды и имена.\n• Ключевые слова — точное текстовое сопоставление BM25 без векторизации запроса. Около 5–15 мс, подходит для имён и точных фраз.",
  },
  chunk_size: {
    title: "Размер фрагмента (токены)",
    body: "Число токенов в одном фрагменте индексируемого документа.\n\n• 128–256 — точный поиск в насыщенных технических документах; фрагментов больше.\n• 512 — сбалансированный вариант для резюме, описаний вакансий и заметок.\n• 1024–2048 — больше связного контекста, но важная деталь может затеряться.\n\nМелкие фрагменты требуют больше времени для первичной индексации. После изменения пересоберите индекс.",
  },
  chunk_overlap: {
    title: "Перекрытие (токены)",
    body: "Сколько токенов повторяется в соседних фрагментах, чтобы не разрывать предложения.\n\n• 0 — без перекрытия, быстрее индексация.\n• 32–64 — рекомендуемый диапазон, по умолчанию 64.\n• 128–256 — высокая связность текста, но больше индекс и время обработки.\n\nПри размере 512 и перекрытии 64 каждый фрагмент повторяет 64 токена предыдущего. После изменения пересоберите индекс.",
  },
  similarity_threshold: {
    title: "Порог сходства",
    body: "Минимальная оценка сходства фрагмента с запросом.\n\nДля поиска по смыслу:\n• 0,0–0,1 — включать почти всё.\n• 0,3 — отсеивать слабо связанные фрагменты.\n• 0,5 и выше — строгий отбор с риском пропуска деталей.\n\nВ смешанном режиме оценки объединяются методом RRF и очень малы. Используйте низкий порог; высокий порог может отсеять все результаты. На задержку поиска порог не влияет.",
  },
  semantic_weight: {
    title: "Вес смыслового поиска (смешанный режим)",
    body: "Баланс смыслового поиска и ключевых слов в смешанном режиме.\n\n• 0,0 — только ключевые слова.\n• 0,3 — приоритет точных терминов и имён.\n• 0,7 — приоритет смысла, стандартное значение.\n• 1,0 — только смысловой поиск.\n\nДля технических документов попробуйте 0,4–0,5, для связного текста и резюме — 0,7–0,8. В остальных режимах параметр не применяется.",
  },
  batch_size: {
    title: "Размер пакета индексации",
    body: "Сколько фрагментов отправлять в Ollama за один запрос при создании индекса.\n\n• 8–16 — для компьютеров с малым объёмом памяти.\n• 32 — баланс скорости и памяти.\n• 64 — быстрая индексация, может потребоваться ещё 1–2 ГБ памяти.\n\nВлияет только на создание индекса, а не на скорость последующего поиска.",
  },
};

// ─── Default Config ───────────────────────────────────────────────────────────
const DEFAULT_RAG_CONFIG: RagConfig = {
  enabled: true,
  embedding_model: "nomic-embed-text",
  ollama_url: "http://localhost:11434",
  batch_size: 32,
  chunk_size: 512,
  chunk_overlap: 64,
  splitting_strategy: "recursive",
  top_k: 5,
  search_mode: "hybrid",
  similarity_threshold: 0.3,
  semantic_weight: 0.7,
  include_transcript: false, // Transcript is sent as context window, not indexed
  embedding_dimensions: 768,
};

const MODEL_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

const EMBEDDING_MODELS = [
  { id: "nomic-embed-text", label: "nomic-embed-text (768d)", dims: 768 },
  { id: "mxbai-embed-large", label: "mxbai-embed-large (1024d)", dims: 1024 },
  { id: "all-minilm", label: "all-minilm (384d)", dims: 384 },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function HelpButton({
  id,
  activeId,
  onToggle,
}: {
  id: string;
  activeId: string | null;
  onToggle: (id: string | null) => void;
}) {
  const isOpen = activeId === id;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(isOpen ? null : id); }}
      className={`inline-flex items-center justify-center rounded-full border transition-colors ${
        isOpen
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/30 text-muted-foreground/60 hover:border-border/60 hover:text-muted-foreground"
      } h-[18px] w-[18px]`}
      title="Показать пояснение"
    >
      {isOpen ? <X className="h-2.5 w-2.5" /> : <HelpCircle className="h-2.5 w-2.5" />}
    </button>
  );
}

function HelpPanel({ id }: { id: string }) {
  const content = HELP[id];
  if (!content) return null;
  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 space-y-1">
      <p className="text-xs font-semibold text-primary/80">{content.title}</p>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
        {content.body}
      </p>
    </div>
  );
}

function SectionHelp({ id, activeId, onToggle }: { id: string; activeId: string | null; onToggle: (id: string | null) => void }) {
  return (
    <div className="flex items-center gap-2">
      <HelpButton id={id} activeId={activeId} onToggle={onToggle} />
    </div>
  );
}

function RebuildBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-meta font-medium text-amber-500">
      rebuild
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function ContextStrategySettings() {
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const setContextStrategy = useConfigStore((s) => s.setContextStrategy);

  const ragConfig = useRagStore((s) => s.ragConfig);
  const indexStatus = useRagStore((s) => s.indexStatus);
  const ollamaStatus = useRagStore((s) => s.ollamaStatus);
  const isIndexing = useRagStore((s) => s.isIndexing);
  const indexProgress = useRagStore((s) => s.indexProgress);
  const isPullingModel = useRagStore((s) => s.isPullingModel);
  const pullProgress = useRagStore((s) => s.pullProgress);
  const isCheckingConnection = useRagStore((s) => s.isCheckingConnection);
  const indexStale = useRagStore((s) => s.indexStale);

  const loadRagConfig = useRagStore((s) => s.loadRagConfig);
  const saveRagConfig = useRagStore((s) => s.saveRagConfig);
  const saveRagConfigWithStaleCheck = useRagStore((s) => s.saveRagConfigWithStaleCheck);
  const refreshIndexStatus = useRagStore((s) => s.refreshIndexStatus);
  const checkOllamaStatus = useRagStore((s) => s.checkOllamaStatus);
  const rebuildIndex = useRagStore((s) => s.rebuildIndex);
  const clearIndex = useRagStore((s) => s.clearIndex);
  const pullModel = useRagStore((s) => s.pullModel);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [localConfig, setLocalConfig] = useState<RagConfig>(DEFAULT_RAG_CONFIG);
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  useRagEvents();

  useEffect(() => {
    loadRagConfig();
    refreshIndexStatus();
    checkOllamaStatus();
  }, [loadRagConfig, refreshIndexStatus, checkOllamaStatus]);

  useEffect(() => {
    if (ragConfig) {
      setLocalConfig({ ...ragConfig, include_transcript: false });
    }
  }, [ragConfig]);

  const handleStrategyChange = (strategy: ContextStrategy) => {
    setContextStrategy(strategy);
    const enabled = strategy === "local_rag";
    const updated = { ...localConfig, enabled, include_transcript: false };
    setLocalConfig(updated);
    saveRagConfig(updated);
  };

  const updateField = useCallback(
    <K extends keyof RagConfig>(key: K, value: RagConfig[K]) => {
      setLocalConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const saveWithStaleCheck = useCallback(() => {
    if (ragConfig) {
      saveRagConfigWithStaleCheck({ ...localConfig, include_transcript: false }, ragConfig);
    } else {
      saveRagConfig({ ...localConfig, include_transcript: false });
    }
  }, [saveRagConfig, saveRagConfigWithStaleCheck, localConfig, ragConfig]);

  const handleFieldBlur = useCallback(() => {
    saveWithStaleCheck();
  }, [saveWithStaleCheck]);

  const handleSelectChange = useCallback(
    <K extends keyof RagConfig>(key: K, value: RagConfig[K]) => {
      const extraFields: Partial<RagConfig> = {};
      if (key === "embedding_model") {
        const dims = MODEL_DIMS[value as string] ?? 768;
        extraFields.embedding_dimensions = dims;
      }
      const updated = { ...localConfig, [key]: value, ...extraFields, include_transcript: false };
      setLocalConfig(updated);
      if (ragConfig) {
        saveRagConfigWithStaleCheck(updated, ragConfig);
      } else {
        saveRagConfig(updated);
      }
    },
    [localConfig, ragConfig, saveRagConfig, saveRagConfigWithStaleCheck]
  );

  const applyPreset = useCallback(
    (preset: (typeof PRESETS)[number]) => {
      const updated: RagConfig = {
        ...localConfig,
        ...preset.config,
        include_transcript: false,
        embedding_dimensions: MODEL_DIMS[preset.config.embedding_model] ?? 768,
      };
      setLocalConfig(updated);
      if (ragConfig) {
        saveRagConfigWithStaleCheck(updated, ragConfig);
      } else {
        saveRagConfig(updated);
      }
    },
    [localConfig, ragConfig, saveRagConfig, saveRagConfigWithStaleCheck]
  );

  const handleClearIndex = () => {
    if (confirmClear) {
      clearIndex();
      setConfirmClear(false);
    } else {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
    }
  };

  const handleRebuild = () => {
    if (indexStale && !confirmRebuild) {
      setConfirmRebuild(true);
      setTimeout(() => setConfirmRebuild(false), 4000);
      return;
    }
    setConfirmRebuild(false);
    rebuildIndex();
  };

  const handleResetDefaults = () => {
    const config = { ...DEFAULT_RAG_CONFIG, enabled: localConfig.enabled };
    setLocalConfig(config);
    saveRagConfig(config);
  };

  const toggleHelp = useCallback((id: string | null) => {
    setOpenHelp((prev) => (prev === id ? null : id));
  }, []);

  const selectedModelAvailable = ollamaStatus?.connected
    ? ollamaStatus.models.some(
        (m) =>
          m === localConfig.embedding_model ||
          m.startsWith(`${localConfig.embedding_model}:`)
      )
    : false;

  const totalChunks = indexStatus?.total_chunks ?? 0;
  const hasIndex = totalChunks > 0;
  const activePresetId = getActivePresetId(localConfig);

  return (
    <div className="space-y-6">
      {/* ── Strategy Selector ── */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => handleStrategyChange("local_rag")}
          className={`relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-150 ${
            contextStrategy === "local_rag"
              ? "border-primary bg-primary/5 ring-1 ring-primary/20"
              : "border-border/50 hover:border-border hover:bg-accent/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Локальный поиск по документам</span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            Локальная индексация через Ollama, поиск по смыслу и ключевым словам
          </p>
        </button>

        <button
          onClick={() => handleStrategyChange("gemini_cache")}
          className={`relative flex flex-col items-start rounded-xl border p-4 text-left transition-all duration-150 ${
            contextStrategy === "gemini_cache"
              ? "border-orange-400/60 bg-orange-400/5 ring-1 ring-orange-400/20"
              : "border-border/50 hover:border-border hover:bg-accent/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-orange-400" />
            <span className="text-sm font-medium text-foreground">Кэш контекста Gemini</span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            Сохраните документы в кэше Gemini без локальной индексации
          </p>
        </button>
      </div>

      {contextStrategy === "local_rag" && (
        <>
          {/* ── Quick Presets ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-primary/80">Готовые профили</h3>
              <p className="text-meta text-muted-foreground/60">
                Ожидаемая задержка поискового запроса
              </p>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PRESETS.map((preset) => {
                const isActive = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset)}
                    title={preset.description}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-all ${
                      isActive
                        ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                        : "border-border/30 bg-background hover:border-border/60 hover:bg-accent/40"
                    }`}
                  >
                    <span className={`text-xs font-semibold ${isActive ? "text-primary" : "text-foreground"}`}>
                      {preset.label}
                    </span>
                    <span className={`rounded-full px-1.5 py-0.5 text-meta font-medium font-mono ${
                      isActive ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground"
                    }`}>
                      {preset.ms}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-meta text-muted-foreground/70 leading-relaxed">
              Задержка складывается из векторизации запроса и поиска фрагментов. Самый быстрый профиль использует ключевые слова. Точные профили находят больше мелких фрагментов и требуют пересборки индекса.
            </p>
          </div>

          {/* ── Connection ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-primary/80">Подключение</h3>
            </div>
            <div className="space-y-4">
              {/* Ollama status */}
              <div className="flex items-center gap-3">
                {ollamaStatus?.connected ? (
                  <>
                    <div className="h-2.5 w-2.5 rounded-full bg-success" />
                    <Wifi className="h-3.5 w-3.5 text-success" />
                    <span className="text-xs text-success">Ollama подключена</span>
                    <span className="text-meta text-muted-foreground">
                      ({ollamaStatus.models.length} модель{ollamaStatus.models.length !== 1 ? "s" : ""})
                    </span>
                  </>
                ) : (
                  <>
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <WifiOff className="h-3.5 w-3.5 text-red-500" />
                    <span className="text-xs text-red-500">Ollama недоступна</span>
                    <span className="text-meta text-muted-foreground/60">— запустите Ollama для индексации</span>
                  </>
                )}
              </div>

              {ollamaStatus?.connected && (
                <div className="flex items-center gap-2 text-xs">
                  {selectedModelAvailable ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      <span className="text-success">{localConfig.embedding_model} available</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      <span className="text-amber-500">
                        {localConfig.embedding_model} не найдена — скачайте её ниже
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* Embedding model */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    Модель для индексации
                    <HelpButton id="embedding_model" activeId={openHelp} onToggle={toggleHelp} />
                  </label>
                  <RebuildBadge show={hasIndex && localConfig.embedding_model !== (ragConfig?.embedding_model ?? "nomic-embed-text")} />
                </div>
                {openHelp === "embedding_model" && <HelpPanel id="embedding_model" />}
                <select
                  value={localConfig.embedding_model}
                  onChange={(e) => handleSelectChange("embedding_model", e.target.value)}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 mt-1.5"
                >
                  {EMBEDDING_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>

              {/* Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={checkOllamaStatus}
                  disabled={isCheckingConnection}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCheckingConnection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                  Проверить подключение
                </button>
                <button
                  onClick={() => pullModel(localConfig.embedding_model)}
                  disabled={isPullingModel}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPullingModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {isPullingModel ? "Загрузка…" : "Скачать модель"}
                </button>
              </div>

              {isPullingModel && (
                <div className="space-y-1.5 rounded-lg border border-border/20 bg-background/50 p-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      {pullProgress?.status || "Подключение…"}
                    </span>
                    {pullProgress && pullProgress.total > 0 && (
                      <span className="font-mono">
                        {Math.round((pullProgress.completed / pullProgress.total) * 100)}%
                        <span className="text-muted-foreground/70 ml-1">
                          ({formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)})
                        </span>
                      </span>
                    )}
                  </div>
                  {pullProgress && pullProgress.total > 0 && (
                    <div className="h-1.5 rounded-full bg-muted/40">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.round((pullProgress.completed / pullProgress.total) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Search Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50 p-5">
            <h3 className="mb-3 text-sm font-semibold text-primary/80">Настройки поиска</h3>
            <div className="grid grid-cols-2 gap-4">
              {/* top-K */}
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="text-xs font-medium text-foreground">
                    Число результатов (top-K)
                  </label>
                  <HelpButton id="top_k" activeId={openHelp} onToggle={toggleHelp} />
                </div>
                {openHelp === "top_k" && (
                  <div className="col-span-2 mb-2"><HelpPanel id="top_k" /></div>
                )}
                <select
                  value={localConfig.top_k}
                  onChange={(e) => handleSelectChange("top_k", Number(e.target.value))}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  {[3, 5, 7, 10, 15, 20].map((v) => (
                    <option key={v} value={v}>{v} chunks</option>
                  ))}
                </select>
              </div>

              {/* Search mode */}
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="text-xs font-medium text-foreground">Режим поиска</label>
                  <HelpButton id="search_mode" activeId={openHelp} onToggle={toggleHelp} />
                </div>
                <select
                  value={localConfig.search_mode}
                  onChange={(e) => handleSelectChange("search_mode", e.target.value)}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  <option value="hybrid">Смешанный (рекомендуется)</option>
                  <option value="semantic">Только по смыслу</option>
                  <option value="keyword">Только ключевые слова (быстрее)</option>
                </select>
              </div>
            </div>
            {/* Help panels for search settings (full width) */}
            {openHelp === "search_mode" && <div className="mt-3"><HelpPanel id="search_mode" /></div>}
          </div>

          {/* ── Index Status ── */}
          <div className={`rounded-xl border bg-card/50 p-5 ${
            indexStale ? "border-amber-500/40 ring-1 ring-amber-500/10" : "border-border/30"
          }`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-primary/80">Состояние индекса</h3>
              {indexStale && (
                <div className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-meta font-medium text-amber-500">
                  <AlertTriangle className="h-3 w-3" />
                  Настройки изменены — пересоберите индекс
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg bg-accent/20 px-3 py-2.5">
                <span className="text-muted-foreground">Файлов в индексе</span>
                <p className="mt-0.5 text-sm font-medium text-foreground">
                  {indexStatus?.indexed_files ?? 0} / {indexStatus?.total_files ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-accent/20 px-3 py-2.5">
                <span className="text-muted-foreground">Всего фрагментов</span>
                <p className="mt-0.5 text-sm font-medium text-foreground">
                  {indexStatus?.total_chunks ?? 0}
                </p>
              </div>
              <div className="rounded-lg bg-accent/20 px-3 py-2.5">
                <span className="text-muted-foreground">Всего токенов</span>
                <p className="mt-0.5 text-sm font-medium text-foreground">
                  {indexStatus?.total_tokens ? `~${Math.round(indexStatus.total_tokens / 1000)}k` : "0"}
                </p>
              </div>
              <div className="rounded-lg bg-accent/20 px-3 py-2.5">
                <span className="text-muted-foreground">Последняя индексация</span>
                <p className="mt-0.5 text-sm font-medium text-foreground truncate">
                  {indexStatus?.last_indexed_at
                    ? new Date(indexStatus.last_indexed_at).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>

            {isIndexing && indexProgress && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{indexProgress.status}</span>
                  <span>{indexProgress.filesDone}/{indexProgress.filesTotal} files</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{
                      width: indexProgress.filesTotal > 0
                        ? `${Math.round((indexProgress.filesDone / indexProgress.filesTotal) * 100)}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handleRebuild}
                disabled={isIndexing}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  indexStale
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    : "border-border/50 bg-background text-foreground hover:bg-accent"
                }`}
              >
                {isIndexing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {confirmRebuild ? "Подтвердить пересборку" : indexStale ? "Нужна пересборка" : hasIndex ? "Пересобрать индекс" : "Создать индекс"}
              </button>
              <button
                onClick={handleClearIndex}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                  confirmClear
                    ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "border-border/50 bg-background text-foreground hover:bg-accent"
                }`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirmClear ? "Подтвердить очистку" : "Очистить индекс"}
              </button>
            </div>
          </div>

          {/* ── Advanced Settings ── */}
          <div className="rounded-xl border border-border/30 bg-card/50">
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex w-full items-center justify-between px-5 py-3.5 text-sm font-semibold text-primary/80 transition-colors hover:bg-accent/20"
            >
              <span>Дополнительные настройки</span>
              {advancedOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
              }
            </button>

            {advancedOpen && (
              <div className="border-t border-border/20 px-5 py-4 space-y-5">

                {/* Chunk Size */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      Размер фрагмента
                      <HelpButton id="chunk_size" activeId={openHelp} onToggle={toggleHelp} />
                      <RebuildBadge show={hasIndex && localConfig.chunk_size !== (ragConfig?.chunk_size ?? 512)} />
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">{localConfig.chunk_size} токенов</span>
                  </div>
                  {openHelp === "chunk_size" && <HelpPanel id="chunk_size" />}
                  <input
                    type="range" min={128} max={2048} step={64}
                    value={localConfig.chunk_size}
                    onChange={(e) => updateField("chunk_size", Number(e.target.value))}
                    onMouseUp={handleFieldBlur} onTouchEnd={handleFieldBlur}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>128 — точнее</span><span>2048 — шире контекст</span>
                  </div>
                </div>

                {/* Chunk Overlap */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      Перекрытие фрагментов
                      <HelpButton id="chunk_overlap" activeId={openHelp} onToggle={toggleHelp} />
                      <RebuildBadge show={hasIndex && localConfig.chunk_overlap !== (ragConfig?.chunk_overlap ?? 64)} />
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">{localConfig.chunk_overlap} токенов</span>
                  </div>
                  {openHelp === "chunk_overlap" && <HelpPanel id="chunk_overlap" />}
                  <input
                    type="range" min={0} max={512} step={16}
                    value={localConfig.chunk_overlap}
                    onChange={(e) => updateField("chunk_overlap", Number(e.target.value))}
                    onMouseUp={handleFieldBlur} onTouchEnd={handleFieldBlur}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>0 — без перекрытия</span><span>512 — максимальная связность</span>
                  </div>
                </div>

                {/* Similarity Threshold */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      Порог сходства
                      <HelpButton id="similarity_threshold" activeId={openHelp} onToggle={toggleHelp} />
                      {localConfig.search_mode !== "semantic" && (
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-meta text-muted-foreground/60">
                          только поиск по смыслу
                        </span>
                      )}
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">{localConfig.similarity_threshold.toFixed(2)}</span>
                  </div>
                  {openHelp === "similarity_threshold" && <HelpPanel id="similarity_threshold" />}
                  <input
                    type="range" min={0} max={0.9} step={0.05}
                    value={localConfig.similarity_threshold}
                    onChange={(e) => updateField("similarity_threshold", Number(e.target.value))}
                    onMouseUp={handleFieldBlur} onTouchEnd={handleFieldBlur}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>0,0 — включать всё</span><span>0,9 — строгий отбор</span>
                  </div>
                </div>

                {/* Semantic Weight */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                      Вес смыслового поиска
                      <HelpButton id="semantic_weight" activeId={openHelp} onToggle={toggleHelp} />
                      {localConfig.search_mode !== "hybrid" && (
                        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-meta text-muted-foreground/60">
                          только смешанный режим
                        </span>
                      )}
                    </label>
                    <span className="text-xs text-muted-foreground font-mono">
                      {Math.round(localConfig.semantic_weight * 100)}% semantic / {Math.round((1 - localConfig.semantic_weight) * 100)}% keyword
                    </span>
                  </div>
                  {openHelp === "semantic_weight" && <HelpPanel id="semantic_weight" />}
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={localConfig.semantic_weight}
                    onChange={(e) => updateField("semantic_weight", Number(e.target.value))}
                    onMouseUp={handleFieldBlur} onTouchEnd={handleFieldBlur}
                    className="w-full accent-primary mt-1.5"
                  />
                  <div className="flex justify-between text-meta text-muted-foreground/60">
                    <span>0,0 — ключевые слова</span><span>1,0 — смысл</span>
                  </div>
                </div>

                {/* Ollama URL */}
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    Адрес Ollama
                  </label>
                  <input
                    type="text"
                    value={localConfig.ollama_url}
                    onChange={(e) => updateField("ollama_url", e.target.value)}
                    onBlur={handleFieldBlur}
                    placeholder="http://localhost:11434"
                    className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                </div>

                {/* Batch Size */}
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <label className="text-xs font-medium text-foreground">Размер пакета</label>
                    <HelpButton id="batch_size" activeId={openHelp} onToggle={toggleHelp} />
                  </div>
                  {openHelp === "batch_size" && <HelpPanel id="batch_size" />}
                  <select
                    value={localConfig.batch_size}
                    onChange={(e) => handleSelectChange("batch_size", Number(e.target.value))}
                    className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 mt-1"
                  >
                    {[8, 16, 32, 64].map((v) => (
                      <option key={v} value={v}>{v} chunks/request</option>
                    ))}
                  </select>
                </div>

                {/* Reset */}
                <button
                  onClick={handleResetDefaults}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Восстановить стандартные
                </button>
              </div>
            )}
          </div>

          {/* ── How it works during meetings ── */}
          <div className="rounded-xl border border-border/20 bg-accent/10 px-4 py-3">
            <p className="text-xs text-muted-foreground/70 leading-relaxed">
              <span className="font-semibold text-foreground/70">Во время встречи: </span>
              Текущая расшифровка передаётся в скользящем окне контекста и не хранится в индексе документов. Из документов извлекается до{localConfig.top_k} подходящих фрагментов. Они передаются ИИ вместе с текстом встречи.
            </p>
          </div>
        </>
      )}

      <GeminiCachePanel />
    </div>
  );
}

// ─── Gemini Context Cache Panel ───────────────────────────────────────────────
function GeminiCachePanel() {
  const contextStrategy = useConfigStore((s) => s.contextStrategy);
  const [cache, setCache] = useState<GeminiCacheInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("gemini-2.0-flash-001");
  const [ttl, setTtl] = useState(3600);

  useEffect(() => {
    if (contextStrategy !== "gemini_cache") return;
    getGeminiCacheStatus().then(setCache).catch(() => {});
  }, [contextStrategy]);

  if (contextStrategy !== "gemini_cache") return null;

  async function handleCreate() {
    setLoading(true);
    try {
      const info = await createGeminiContextCache(model, ttl);
      setCache(info);
      showToast(`Кэш создан: ${info.total_token_count.toLocaleString("ru-RU")} токенов`, "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteGeminiContextCache();
      setCache(null);
      showToast("Кэш Gemini очищен", "success");
    } catch (e: any) {
      showToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  const expireLabel = cache
    ? new Date(cache.expire_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <FlameKindling className="h-4 w-4 text-orange-400" />
        <h3 className="text-sm font-semibold text-foreground">Кэш контекста Gemini</h3>
        {cache && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
            <CheckCircle2 className="h-3 w-3" /> Активен · истекает {expireLabel}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Загрузите документы на сервер Gemini один раз. Запросы будут обходиться без локальной векторизации — <span className="text-foreground/80 font-medium">примерно на 3–5 с быстрее</span> на компьютерах без ускорения на видеокарте.
      </p>

      {!cache ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">Модель</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value="gemini-2.0-flash-001">gemini-2.0-flash-001</option>
                <option value="gemini-1.5-flash-001">gemini-1.5-flash-001</option>
                <option value="gemini-1.5-pro-001">gemini-1.5-pro-001</option>
              </select>
            </div>
            <div className="w-28">
              <label className="mb-1 block text-xs text-muted-foreground">Срок хранения</label>
              <select
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value={1800}>30 мин</option>
                <option value={3600}>1 час</option>
                <option value={7200}>2 часа</option>
                <option value={86400}>24 часа</option>
              </select>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
            Создать кэш документов контекста
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border/30 bg-background/50 px-4 py-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p><span className="text-foreground/70 font-medium">Модель:</span> {cache.model.replace("models/", "")}</p>
            <p><span className="text-foreground/70 font-medium">Токенов в кэше:</span> {cache.total_token_count.toLocaleString()}</p>
          </div>
          <button
            onClick={handleDelete}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Очистить
          </button>
        </div>
      )}
    </div>
  );
}
