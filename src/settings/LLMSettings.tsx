import { useState, useEffect, useCallback, useRef } from "react";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import {
  getLLMProviders,
  listModels,
  testLLMConnection,
  storeApiKey,
  getApiKey,
  hasApiKey,
  listOpenRouterModels,
} from "../lib/ipc";
import type { LLMProviderType, ModelInfo, OpenRouterModel } from "../lib/types";
import { OpenRouterModelCatalog } from "./openrouter/OpenRouterModelCatalog";
import { ClaudeCliSettings, claudeTierLabel } from "./ClaudeCliSettings";
import { useAgentStore } from "../stores/agentStore";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  Wifi,
  Server,
  Cloud,
  Settings2,
  Zap,
} from "lucide-react";

type ConnectionStatus = "idle" | "testing" | "success" | "error";

const PROVIDER_DISPLAY: Record<
  LLMProviderType,
  { label: string; description: string; requiresKey: boolean; isLocal: boolean }
> = {
  ollama: { label: "Ollama", description: "Локальные модели Ollama", requiresKey: false, isLocal: true },
  lm_studio: { label: "LM Studio", description: "Локальные модели LM Studio", requiresKey: false, isLocal: true },
  openai: { label: "OpenAI", description: "Модели GPT и другие", requiresKey: true, isLocal: false },
  anthropic: { label: "Anthropic", description: "Claude Sonnet, Opus, Haiku", requiresKey: true, isLocal: false },
  groq: { label: "Groq", description: "Быстрые ответы моделей", requiresKey: true, isLocal: false },
  gemini: { label: "Google Gemini", description: "Gemini Pro, Flash", requiresKey: true, isLocal: false },
  openrouter: { label: "OpenRouter", description: "Модели разных разработчиков", requiresKey: true, isLocal: false },
  custom: { label: "Свой сервис", description: "Свой совместимый API", requiresKey: false, isLocal: false },
  // Not in ALL_PROVIDERS: it gets its own "Subscription (local CLI)" group.
  // isLocal is false here because that flag drives the local-server hints below.
  claude_cli: { label: "Claude (подписка)", description: "Ваша подписка Claude (бета)", requiresKey: false, isLocal: false },
};

const ALL_PROVIDERS: LLMProviderType[] = [
  "ollama", "lm_studio", "openai", "anthropic", "groq", "gemini", "openrouter", "custom",
];

// Filter out known embedding-only models
const EMBEDDING_ONLY_PATTERNS = [
  "all-minilm", "mxbai-embed", "nomic-embed", "bge-",
  "text-embedding", "snowflake-arctic-embed", "jina-embeddings",
];

function filterChatModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) => !EMBEDDING_ONLY_PATTERNS.some((p) => m.id.toLowerCase().includes(p))
  );
}

// ── Badge state logic ──
// Uses verifiedCloudProviders (persisted after successful test) for accurate readiness.
type BadgeVariant = "ready" | "has-key" | "no-key" | "local" | "not-configured";
interface BadgeState {
  text: string;
  variant: BadgeVariant;
}

function getBadgeState(
  providerType: LLMProviderType,
  verifiedProviders: string[],
  keyExists: boolean,
): BadgeState {
  const info = PROVIDER_DISPLAY[providerType];

  // Verified providers (test passed) → Ready
  if (verifiedProviders.includes(providerType)) {
    return { text: "Готов", variant: "ready" };
  }

  // Local providers — not verified yet
  if (info.isLocal) {
    return { text: "Локально", variant: "local" };
  }

  // Cloud providers
  if (info.requiresKey) {
    if (keyExists) {
      return { text: "Ключ сохранён", variant: "has-key" };
    }
    return { text: "Нет ключа", variant: "no-key" };
  }

  // Custom — not configured
  return { text: "Настроить", variant: "not-configured" };
}

const BADGE_STYLES: Record<BadgeVariant, string> = {
  "ready": "bg-success/10 text-success border-success/20",
  "has-key": "bg-info/10 text-info border-info/20",
  "no-key": "bg-destructive/10 text-destructive border-destructive/20",
  "local": "bg-info/10 text-info border-info/20",
  "not-configured": "bg-muted text-muted-foreground border-border/30",
};

const DOT_STYLES: Record<BadgeVariant, string> = {
  "ready": "bg-success",
  "has-key": "bg-info",
  "no-key": "bg-destructive",
  "local": "bg-info",
  "not-configured": "bg-muted-foreground/30",
};

// ══════════════════════════════════════════════════════════════

export function LLMSettings() {
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const activateLLMProvider = useConfigStore((s) => s.activateLLMProvider);
  const verifiedCloudProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const setVerifiedCloudProviders = useConfigStore((s) => s.setVerifiedCloudProviders);
  const claudeCliConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const claudeStatus = useAgentStore((s) => s.status);

  const [selectedProvider, setSelectedProvider] = useState<LLMProviderType>(llmProvider);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [selectedModel, setSelectedModel] = useState(llmModel);
  const [apiKey, setApiKeyValue] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [keyStatusMap, setKeyStatusMap] = useState<Record<string, boolean>>({});
  const [keySaving, setKeySaving] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [activating, setActivating] = useState(false);

  // The active provider changed elsewhere (the footer, in this or the other
  // window): show that provider, so Settings never offers to "activate" the
  // one just replaced. A switch made here already has it selected.
  const selectedRef = useRef(selectedProvider);
  selectedRef.current = selectedProvider;
  useEffect(() => {
    if (llmProvider === selectedRef.current) return;
    handleProviderChange(llmProvider);
    setSelectedModel(useConfigStore.getState().llmModel);
  }, [llmProvider]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedRef.current === useConfigStore.getState().llmProvider) setSelectedModel(llmModel);
  }, [llmModel]);

  // Custom provider fields — hydrated from persisted config so they survive restarts
  const storedCustomBaseUrl = useConfigStore((s) => s.customLlmBaseUrl);
  const storedCustomAuthType = useConfigStore((s) => s.customLlmAuthType);
  const setCustomLlmConfig = useConfigStore((s) => s.setCustomLlmConfig);

  const [customBaseUrl, setCustomBaseUrl] = useState(storedCustomBaseUrl);
  const [customAuthType, setCustomAuthType] = useState<"none" | "bearer" | "api_key">(storedCustomAuthType);
  const [customAuthValue, setCustomAuthValue] = useState("");
  const customKeyLoadRevision = useRef(0);

  // Check which providers have stored API keys (for badge display)
  useEffect(() => {
    async function checkAllKeys() {
      const cloudProviders = ["openai", "anthropic", "groq", "gemini", "openrouter"];
      const status: Record<string, boolean> = {};
      for (const p of cloudProviders) {
        try { status[p] = await hasApiKey(p); } catch { status[p] = false; }
      }
      setKeyStatusMap(status);
    }
    checkAllKeys();
  }, []);

  // Load API key when provider changes
  useEffect(() => {
    let cancelled = false;
    const info = PROVIDER_DISPLAY[selectedProvider];
    setApiKeyValue("");
    setShowApiKey(false);
    setKeySaved(false);
    if (info?.requiresKey) {
      getApiKey(selectedProvider)
        .then((key) => { if (!cancelled) setApiKeyValue(key || ""); })
        .catch(() => { if (!cancelled) setApiKeyValue(""); });
    }
    setConnectionStatus("idle");
    setConnectionMessage("");
    setModels([]);
    setOpenRouterModels([]);
    setModelsError("");
    return () => { cancelled = true; };
  }, [selectedProvider]);

  // Custom provider: load persisted base URL / auth type + stored token when the
  // provider is selected, so the user's endpoint is restored after a restart.
  useEffect(() => {
    if (selectedProvider !== "custom") return;
    let cancelled = false;
    const revision = ++customKeyLoadRevision.current;
    setCustomAuthValue("");
    setCustomBaseUrl(useConfigStore.getState().customLlmBaseUrl);
    setCustomAuthType(useConfigStore.getState().customLlmAuthType);
    getApiKey("custom")
      .then((v) => { if (!cancelled && revision === customKeyLoadRevision.current) setCustomAuthValue(v || ""); })
      .catch(() => { if (!cancelled && revision === customKeyLoadRevision.current) setCustomAuthValue(""); });
    return () => { cancelled = true; };
  }, [selectedProvider]);

  // Build the provider config JSON for backend calls
  const buildProviderConfig = useCallback(() => {
    const config: Record<string, unknown> = { provider_type: selectedProvider };
    if (apiKey.trim()) config.api_key = apiKey.trim();
    if (selectedProvider === "custom") {
      if (customBaseUrl.trim()) config.base_url = customBaseUrl.trim().replace(/\/+$/, "");
      if (customAuthType !== "none") {
        config.auth_type = customAuthType;
        config.auth_value = customAuthValue.trim();
      }
    }
    return JSON.stringify(config);
  }, [selectedProvider, apiKey, customBaseUrl, customAuthType, customAuthValue]);

  const handleProviderChange = (provider: LLMProviderType) => {
    setSelectedProvider(provider);
    setSelectedModel(useConfigStore.getState().lastModelByProvider[provider] || "");
    setModels([]);
    setOpenRouterModels([]);
    setConnectionStatus("idle");
    setConnectionMessage("");
    setModelsError("");
    setModelsLoading(false);
  };

  const applyFreeCodexPreset = () => {
    setCustomBaseUrl("https://freecodex.fun/v1");
    setCustomAuthType("bearer");
    setSelectedModel("gpt-5.6-luna");
    // Never reuse a token belonging to another endpoint or let its pending load
    // refill the field. The saved credential is untouched until the user saves.
    customKeyLoadRevision.current += 1;
    setCustomAuthValue("");
    setKeySaved(false);
    setConnectionStatus("idle");
    setConnectionMessage("");
    setModels([]);
    setModelsError("");
  };

  const saveCredentials = async () => {
    const key = selectedProvider === "custom" ? customAuthValue.trim() : apiKey.trim();
    if (selectedProvider === "custom" && customAuthType !== "none" && !key) {
      throw new Error("Введите ключ выбранного сервиса");
    }
    if (key) await storeApiKey(selectedProvider, key);
    if (selectedProvider === "custom") {
      // Commit the endpoint only after its new credential has been saved, so a
      // draft/preset can never pair a new host with the previous saved token.
      const baseUrl = customBaseUrl.trim().replace(/\/+$/, "");
      const stored = useConfigStore.getState();
      if (baseUrl !== stored.customLlmBaseUrl || customAuthType !== stored.customLlmAuthType) {
        setVerifiedCloudProviders(stored.verifiedCloudProviders.filter((provider) => provider !== "custom"));
      }
      setCustomLlmConfig(baseUrl, customAuthType);
    }
    if (key) setKeyStatusMap((prev) => ({ ...prev, [selectedProvider]: true }));
  };

  const handleSaveApiKey = async () => {
    if (!(selectedProvider === "custom" ? customAuthValue.trim() : apiKey.trim())) return;
    setKeySaving(true);
    const provider = selectedProvider;
    try {
      await saveCredentials();
      if (selectedRef.current === provider) setKeySaved(true);
    } catch {
      showToast("Не удалось сохранить API-ключ", "error");
    } finally {
      setKeySaving(false);
    }
  };

  // Test connection — on success, add to verifiedCloudProviders
  const handleTestConnection = async () => {
    const provider = selectedProvider;
    setConnectionStatus("testing");
    setConnectionMessage("");
    try {
      await saveCredentials();
      const configJson = buildProviderConfig();
      const success = await testLLMConnection(configJson);
      if (selectedRef.current !== provider) return;
      if (success) {
        setConnectionStatus("success");
        setConnectionMessage("Подключение установлено");
        // Mark as verified
        const verified = useConfigStore.getState().verifiedCloudProviders;
        if (!verified.includes(selectedProvider)) {
          setVerifiedCloudProviders([...verified, selectedProvider]);
        }
        setKeyStatusMap((prev) => ({ ...prev, [selectedProvider]: true }));
      } else {
        setConnectionStatus("error");
        setConnectionMessage("Не удалось подключиться");
      }
    } catch (err) {
      if (selectedRef.current !== provider) return;
      setConnectionStatus("error");
      setConnectionMessage(err instanceof Error ? err.message : "Не удалось подключиться");
    }
  };

  const handleLoadModels = async () => {
    const provider = selectedProvider;
    setModelsLoading(true);
    setModelsError("");
    setModels([]);
    // Don't clear openRouterModels here — keep showing existing catalog during refresh
    try {
      await saveCredentials();

      if (selectedProvider === "openrouter") {
        // Browsing only: the key is already stored, so this never touches the active provider
        // Use enriched OpenRouter endpoint
        const orModels = await listOpenRouterModels(true);
        if (selectedRef.current !== provider) return;
        setOpenRouterModels(orModels);
        if (orModels.length === 0) {
          setModelsError("Текстовые модели не найдены");
        }
      } else {
        // Use generic model listing for other providers
        const configJson = buildProviderConfig();
        const modelList = await listModels(configJson);
        if (selectedRef.current !== provider) return;
        const chatModels = filterChatModels(modelList);
        setModels(chatModels);
        if (chatModels.length === 0) {
          setModelsError(
            modelList.length > 0
              ? "Модели чата не найдены (модели эмбеддингов скрыты)"
              : "Модели не найдены"
          );
        }
      }
    } catch (err) {
      if (selectedRef.current === provider) setModelsError(err instanceof Error ? err.message : "Не удалось загрузить модели");
    } finally {
      if (selectedRef.current === provider) setModelsLoading(false);
    }
  };

  const handleModelSelect = async (modelId: string) => {
    setSelectedModel(modelId);
    if (!modelId) return;
    setActivating(true);
    try {
      await saveCredentials();
      await activateLLMProvider(selectedProvider, { model: modelId, providerConfig: buildProviderConfig() });
      showToast("Модель подключена и сохранена", "success");
    } catch (error) {
      showToast(`Не удалось подключить модель: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally { setActivating(false); }
  };

  const handleActivate = async () => {
    setActivating(true);
    try {
      await saveCredentials();
      await activateLLMProvider(selectedProvider, {
        model: selectedModel.trim(),
        providerConfig: buildProviderConfig(),
      });
      showToast("Модель подключена", "success");
    } catch (e) {
      showToast(`Не удалось подключить модель: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setActivating(false);
    }
  };

  const info = PROVIDER_DISPLAY[selectedProvider];
  const requiresApiKey = info?.requiresKey ?? false;
  const isLocal = info?.isLocal ?? false;
  const isCustom = selectedProvider === "custom";
  const isClaudeCli = selectedProvider === "claude_cli";
  // Claude can be made active once the CLI is found and logged in (or while
  // its login state is unknown); it has no model of its own to pick here.
  const claudeUnusable =
    isClaudeCli && !!claudeStatus && (!claudeStatus.installed || claudeStatus.auth?.logged_in === false);

  return (
    <div className="space-y-6">
      {/* Active Provider + Model Banner */}
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3.5">
        <Zap className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Активный сервис: {PROVIDER_DISPLAY[llmProvider]?.label || llmProvider}
            {llmProvider === "claude_cli" ? "" : llmModel ? ` / ${llmModel}` : " — модель не выбрана"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {llmProvider === "claude_cli"
              ? `Быстрая: ${claudeTierLabel(claudeCliConfig.fast_model, claudeCliConfig.fast_effort, claudeModels)} — Глубокая: ${claudeTierLabel(claudeCliConfig.deep_model, claudeCliConfig.deep_effort, claudeModels)}`
              : llmModel
                ? "Этот сервис и модель используются для ответов ИИ"
                : "Выберите сервис, проверьте подключение и выберите модель ниже"}
          </p>
        </div>
      </div>

      {/* Subscription (local CLI) providers */}
      <ClaudeCliSettings
        selected={isClaudeCli}
        active={llmProvider === "claude_cli"}
        onSelect={() => handleProviderChange("claude_cli")}
      />

      {/* Provider Selection */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <h3 className="mb-3 text-sm font-semibold text-primary/80">Сервисы ИИ и локальные модели</h3>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          Сохраните ключи нескольких сервисов и переключайтесь между моделями. У каждого сервиса свой ключ и последняя выбранная модель.
        </p>
        <div className="grid grid-cols-4 gap-2.5">
          {ALL_PROVIDERS.map((pType) => {
            const display = PROVIDER_DISPLAY[pType];
            const isSelected = selectedProvider === pType;
            const isActive = llmProvider === pType;
            const badge = getBadgeState(pType, verifiedCloudProviders, keyStatusMap[pType] ?? false);
            return (
              <button
                key={pType}
                onClick={() => handleProviderChange(pType)}
                aria-pressed={isSelected}
                className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer ${
                  isSelected
                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                    : "border-border/50 hover:border-border hover:bg-accent/50"
                }`}
              >
                {/* Status badge */}
                <div className="absolute -top-1 -right-1">
                  <div
                    className={`h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                      isActive && badge.variant === "ready" ? DOT_STYLES["ready"] : DOT_STYLES[badge.variant]
                    }`}
                    title={isActive ? `Активен — ${badge.text}` : badge.text}
                    aria-hidden="true"
                  />
                </div>
                <div className="flex w-full items-center gap-1.5">
                  {display.isLocal ? (
                    <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : pType === "custom" ? (
                    <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Cloud className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium truncate">{display.label}</span>
                </div>
                <span className="mt-0.5 text-meta text-muted-foreground line-clamp-1">
                  {display.description}
                </span>
                {/* Badge label */}
                <span className={`mt-1.5 inline-flex items-center rounded-full border px-1.5 py-0.5 text-meta font-medium ${BADGE_STYLES[badge.variant]}`}>
                  {badge.text}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* API Key Input (for cloud providers) */}
      {requiresApiKey && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">API-ключ</h3>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => { setApiKeyValue(e.target.value); setKeySaved(false); }}
                aria-label="API-ключ"
                autoComplete="off"
                spellCheck={false}
                placeholder={`Введите API-ключ ${PROVIDER_DISPLAY[selectedProvider]?.label || selectedProvider}`}
                maxLength={2048}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                title={showApiKey ? "Скрыть" : "Показать"}
                aria-label={showApiKey ? "Скрыть API-ключ" : "Показать API-ключ"}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <button
            onClick={handleSaveApiKey}
            disabled={!apiKey.trim() || keySaving}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm text-primary disabled:opacity-50"
          >
            {keySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {keySaved ? "Ключ сохранён" : "Сохранить ключ"}
          </button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Ключ хранится в защищённом хранилище Windows. Ключи разных сервисов сохраняются отдельно.
          </p>
        </div>
      )}

      {/* Свой сервис API Config */}
      {isCustom && (
        <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="text-sm font-semibold text-primary/80">Свой сервис API</h3>
          <div className="space-y-2 rounded-lg border border-border/30 bg-accent/20 px-4 py-3">
            <button
              type="button"
              onClick={applyFreeCodexPreset}
              disabled={connectionStatus === "testing" || modelsLoading || activating || keySaving}
              className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm text-primary disabled:opacity-50"
            >
              Настроить FreeCodex
            </button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Заполнит адрес FreeCodex, авторизацию Bearer и модель gpt-5.6-luna. Введите ключ FreeCodex и нажмите «Подключить модель».
              Это настройка ответов ИИ; распознавание речи подключается отдельно.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">Базовый адрес API</label>
            <input
              aria-label="Адрес API"
              type="text"
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              placeholder="http://localhost:8080/v1"
              maxLength={512}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-foreground">Авторизация</label>
              <select
                aria-label="Способ авторизации"
                value={customAuthType}
                onChange={(e) => setCustomAuthType(e.target.value as "none" | "bearer" | "api_key")}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              >
                <option value="none">Без авторизации</option>
                <option value="bearer">Токен Bearer</option>
                <option value="api_key">Заголовок API-ключа</option>
              </select>
            </div>
            {customAuthType !== "none" && (
              <div className="flex-1">
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  {customAuthType === "bearer" ? "Токен" : "API-ключ"}
                </label>
                <input
                  type="password"
                  value={customAuthValue}
                  onChange={(e) => { setCustomAuthValue(e.target.value); setKeySaved(false); }}
                  aria-label="Ключ своего сервиса"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={customAuthType === "bearer" ? "Введите токен Bearer…" : "Введите API-ключ…"}
                  maxLength={2048}
                  className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                />
              </div>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Подходит для сервисов с API, совместимым с OpenAI. Укажите базовый адрес с /v1, способ авторизации и точный идентификатор модели ниже.
            Адрес и авторизация сохранятся после сохранения ключа, проверки подключения или подключения модели.
          </p>
          {customAuthType !== "none" && (
            <button onClick={handleSaveApiKey} disabled={!customAuthValue.trim() || keySaving}
              className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm text-primary disabled:opacity-50">
              {keySaved ? "Ключ сохранён" : "Сохранить ключ"}
            </button>
          )}
        </div>
      )}

      {/* Local Provider Status */}
      {isLocal && (
        <div className="flex items-center gap-3 rounded-xl border border-border/30 bg-accent/20 px-4 py-3">
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">
            {selectedProvider === "ollama"
              ? "Запустите Ollama на localhost:11434"
              : "Запустите LM Studio на localhost:1234"}
          </span>
        </div>
      )}

      {/* Connection Test & Model Loading (Claude has its own above) */}
      {!isClaudeCli && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">Подключение</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === "testing" || (requiresApiKey && !apiKey) || (isCustom && (!customBaseUrl.trim() || (customAuthType !== "none" && !customAuthValue.trim())))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer"
            >
              {connectionStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
              Проверить подключение
            </button>
            <button
              onClick={handleLoadModels}
              disabled={modelsLoading || (requiresApiKey && !apiKey) || (isCustom && (!customBaseUrl.trim() || (customAuthType !== "none" && !customAuthValue.trim())))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-accent hover:-translate-y-px active:translate-y-px active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100 cursor-pointer"
            >
              {modelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Загрузить модели
            </button>
            {connectionStatus === "success" && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                <span className="text-xs">{connectionMessage}</span>
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                <span className="text-xs truncate max-w-[200px]">{connectionMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Model Selection (Claude uses its Fast / Deep settings instead) */}
      {!isClaudeCli && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">Модель</h3>
          {selectedProvider === "openrouter" && openRouterModels.length > 0 ? (
            <OpenRouterModelCatalog models={openRouterModels} />
          ) : models.length > 0 ? (
            <select
              aria-label="Выбор модели ИИ"
              disabled={activating}
              value={selectedModel}
              onChange={(e) => handleModelSelect(e.target.value)}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
            >
              <option value="">Выберите модель…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.context_window ? ` (${Math.round(m.context_window / 1000)} тыс. контекст)` : ""}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-lg border border-border/30 bg-accent/20 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                {modelsError || (modelsLoading ? "Загрузка моделей…" : 'Нажмите «Загрузить модели», чтобы получить список')}
              </p>
            </div>
          )}
          <div className="mt-4 space-y-2 border-t border-border/30 pt-4">
            <label htmlFor="manual-llm-model" className="block text-xs font-medium text-foreground">Идентификатор модели</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="manual-llm-model"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="Например: gpt-4.1, gemini-2.5-flash или имя вашей модели"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
              />
              <button
                onClick={handleActivate}
                disabled={activating || !selectedModel.trim() || (requiresApiKey && !apiKey.trim()) || (isCustom && (!customBaseUrl.trim() || (customAuthType !== "none" && !customAuthValue.trim())))}
                className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm font-medium text-primary disabled:opacity-50"
              >
                {activating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Подключить модель
              </button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Выберите модель из списка или введите её точный ID вручную, если сервис не возвращает список моделей.
            </p>
          </div>
        </div>
      )}

      {/* Make Active button — only when different from active AND provider is ready */}
      {selectedProvider !== llmProvider && (
        <button
          disabled={claudeUnusable || activating || (!isClaudeCli && (!selectedModel.trim() || (requiresApiKey && !apiKey.trim()) || (isCustom && (!customBaseUrl.trim() || (customAuthType !== "none" && !customAuthValue.trim())))))}
          onClick={handleActivate}
          className="w-full rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary transition-all duration-150 hover:bg-primary/10 hover:-translate-y-px active:translate-y-px active:scale-[0.99] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:active:scale-100"
        >
          Использовать {PROVIDER_DISPLAY[selectedProvider]?.label || selectedProvider}
        </button>
      )}
    </div>
  );
}
