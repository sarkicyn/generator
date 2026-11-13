// STT Settings — provider selector with inline model management per provider.
// Badges: always-ready=green, no model/key=red, downloaded-not-active=amber,
//         cloud-key-stored=amber, cloud-tested=green.

import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useConfigStore } from "../stores/configStore";
import { FasterWhisperSettings } from "./FasterWhisperSettings";
import {
  setSTTProvider,
  testSTTConnection,
  listLocalSTTEngines,
  deleteApiKey,
} from "../lib/ipc";
import { storeApiKey, getApiKey, hasApiKey } from "../lib/ipc";
import type { STTProviderType, LocalSTTEngineInfo, DeepgramConfig, GroqConfig } from "../lib/types";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Cloud,
  Server,
  Globe,
  Wifi,
  HardDrive,
  Monitor,
  Zap,
  Trash2,
  ChevronDown,
  ChevronUp,
  Settings2,
  Cpu,
} from "lucide-react";
import { LocalModelManager } from "./LocalModelManager";

// ── Provider definitions ──

interface ProviderOption {
  value: STTProviderType;
  label: string;
  description: string;
  requiresApiKey: boolean;
  isLocal: boolean;
  credentialKey: string;
  needsRegion?: boolean;
  /** Engine ID whose models must be downloaded + activated for readiness */
  requiresModels?: string;
  /** Always ready (no download / key needed) */
  alwaysReady?: boolean;
  /** Batch-only: cannot be used for live streaming; shown with badge */
  batchOnly?: boolean;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: "web_speech",
    label: "Web Speech",
    description: "Встроено в браузер, бесплатно",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    alwaysReady: true,
  },
  {
    value: "windows_native",
    label: "Windows Speech",
    description: "Встроено в Windows, без загрузки",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    alwaysReady: true,
  },
  {
    value: "sherpa_onnx",
    label: "Sherpa-ONNX",
    description: "Локально, в реальном времени, бесплатно",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    requiresModels: "sherpa_onnx",
  },
  {
    value: "ort_streaming",
    label: "ORT Streaming",
    description: "На компьютере, без API-ключа",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    requiresModels: "ort_streaming",
  },
  {
    value: "faster_whisper",
    label: "Faster Whisper",
    description: "Whisper Turbo INT8, русский и английский, офлайн",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    requiresModels: "faster_whisper",
  },
  {
    value: "whisper_cpp",
    label: "Whisper.cpp",
    description: "Распознавание записей завершённых встреч",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    requiresModels: "whisper_cpp",
    batchOnly: true,
  },
  {
    value: "parakeet_tdt",
    label: "Parakeet TDT",
    description: "Высокая точность, офлайн, несколько языков",
    requiresApiKey: false,
    isLocal: true,
    credentialKey: "",
    requiresModels: "parakeet_tdt",
  },
  {
    value: "deepgram",
    label: "Deepgram",
    description: "Потоковое распознавание высокого качества",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "deepgram",
  },
  {
    value: "whisper_api",
    label: "Whisper API",
    description: "Напрямую OpenAI, нужен ключ OpenAI",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "whisper_api",
  },
  {
    value: "azure_speech",
    label: "Azure Speech",
    description: "Azure Cognitive Services",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "azure_speech",
    needsRegion: true,
  },
  {
    value: "groq_whisper",
    label: "Groq Whisper",
    description: "Быстрое распознавание Whisper",
    requiresApiKey: true,
    isLocal: false,
    credentialKey: "groq_whisper",
  },
];

const LANGUAGES = [
  { value: "en-US", label: "Английский (США)" },
  { value: "en-GB", label: "Английский (Великобритания)" },
  { value: "es-ES", label: "Испанский" },
  { value: "fr-FR", label: "Французский" },
  { value: "de-DE", label: "Немецкий" },
  { value: "it-IT", label: "Итальянский" },
  { value: "pt-BR", label: "Португальский (Бразилия)" },
  { value: "ja-JP", label: "Японский" },
  { value: "zh-CN", label: "Китайский (упрощённый)" },
  { value: "ko-KR", label: "Корейский" },
  { value: "nl-NL", label: "Нидерландский" },
  { value: "hi-IN", label: "Хинди" },
  { value: "ru-RU", label: "Русский" },
  { value: "ar-SA", label: "Арабский" },
  { value: "tr-TR", label: "Турецкий" },
  { value: "pl-PL", label: "Польский" },
  { value: "cs-CZ", label: "Чешский" },
  { value: "sv-SE", label: "Шведский" },
];

// ── Deepgram Models ──

interface DeepgramModelInfo {
  id: string;
  label: string;
  tier: "latest" | "standard" | "economy" | "whisper";
  description: string;
  costPerMin: number;
}

const DEEPGRAM_MODELS: DeepgramModelInfo[] = [
  { id: "nova-3", label: "Nova 3", tier: "latest", description: "Новейшая модель с высокой точностью", costPerMin: 0.0059 },
  { id: "nova-2", label: "Nova 2", tier: "standard", description: "Популярная модель с высокой точностью", costPerMin: 0.0043 },
  { id: "nova", label: "Nova", tier: "standard", description: "Предыдущее поколение", costPerMin: 0.0043 },
  { id: "enhanced", label: "Улучшенная", tier: "standard", description: "Высокая точность, консервативное распознавание", costPerMin: 0.0043 },
  { id: "base", label: "Базовая", tier: "economy", description: "Самая быстрая и экономичная", costPerMin: 0.0043 },
  { id: "whisper-large", label: "Whisper Large", tier: "whisper", description: "OpenAI Whisper large", costPerMin: 0.0048 },
  { id: "whisper-medium", label: "Whisper Medium", tier: "whisper", description: "OpenAI Whisper medium", costPerMin: 0.0048 },
  { id: "whisper-small", label: "Whisper Small", tier: "whisper", description: "OpenAI Whisper small", costPerMin: 0.0048 },
  { id: "whisper-tiny", label: "Whisper Tiny", tier: "whisper", description: "Самая компактная и быстрая Whisper", costPerMin: 0.0048 },
  { id: "whisper-base", label: "Whisper Base", tier: "whisper", description: "OpenAI Whisper base", costPerMin: 0.0048 },
];

// ── Deepgram Presets ──

interface DeepgramPreset {
  id: string;
  label: string;
  description: string;
  config: DeepgramConfig;
}

const DEEPGRAM_PRESETS: DeepgramPreset[] = [
  {
    id: "default",
    label: "По умолчанию",
    description: "Сбалансированные настройки для большинства встреч",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: true,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "low_latency",
    label: "Минимальная задержка",
    description: "Быстрый ответ, минимум дополнительной обработки",
    config: {
      model: "nova-3", smart_format: false, interim_results: true,
      endpointing: 150, punctuate: false, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "high_accuracy",
    label: "Высокая точность",
    description: "Высокое качество текста и умное форматирование",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 500, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "meeting_mode",
    label: "Встреча",
    description: "Определение говорящих и форматирование",
    config: {
      model: "nova-3", smart_format: true, interim_results: true,
      endpointing: 400, punctuate: true, diarize: true,
      profanity_filter: false, numerals: true, dictation: false,
      vad_events: true, keyterms: [],
    },
  },
  {
    id: "economy",
    label: "Экономичный",
    description: "Модель Nova 2, низкая стоимость",
    config: {
      model: "nova-2", smart_format: false, interim_results: true,
      endpointing: 300, punctuate: true, diarize: false,
      profanity_filter: false, numerals: false, dictation: false,
      vad_events: false, keyterms: [],
    },
  },
];

function configMatchesPreset(config: DeepgramConfig, preset: DeepgramConfig): boolean {
  return (
    config.model === preset.model &&
    config.smart_format === preset.smart_format &&
    config.interim_results === preset.interim_results &&
    config.endpointing === preset.endpointing &&
    config.punctuate === preset.punctuate &&
    config.diarize === preset.diarize &&
    config.profanity_filter === preset.profanity_filter &&
    config.numerals === preset.numerals &&
    config.dictation === preset.dictation &&
    config.vad_events === preset.vad_events
    // keyterms excluded from preset matching — user-specific
  );
}

type ConnectionStatus = "idle" | "testing" | "success" | "error";
type BadgeVariant = "ready" | "warning" | "error";
interface BadgeState { text: string; variant: BadgeVariant }

// A failed replacement must finish restoring its snapshot before another test
// temporarily writes credentials in the same settings session.
let credentialTestQueue: Promise<void> = Promise.resolve();

function connectionFailureMessage(error: unknown, secrets: Array<string | null>): string {
  let message = typeof error === "string" ? error
    : error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message
    : "Провайдер отклонил проверку. Проверьте сервис, доступ ключа к распознаванию речи и подключение к интернету.";
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[ключ скрыт]");
  }
  message = message.replace(/\bBearer\s+\S+/gi, "Bearer [ключ скрыт]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[ключ скрыт]");
  return `Проверка не пройдена: ${message.slice(0, 1200)}`;
}

export function STTSettings() {
  const sttProvider = useConfigStore((s) => s.sttProvider);
  const setConfigSTTProvider = useConfigStore((s) => s.setSTTProvider);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);
  const sttLanguage = useConfigStore((s) => s.sttLanguage);
  const setSTTLanguage = useConfigStore((s) => s.setSTTLanguage);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);
  // Persisted: providers whose key has been saved + tested successfully
  const verifiedCloudProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const setVerifiedCloudProviders = useConfigStore((s) => s.setVerifiedCloudProviders);

  const [selectedProvider, setSelectedProvider] =
    useState<STTProviderType>(sttProvider);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  // keyDirty: user has typed a new key that differs from stored — show Save & Test
  const [keyDirty, setKeyDirty] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const [azureRegion, setAzureRegion] = useState("eastus");
  const [hasStoredRegion, setHasStoredRegion] = useState(false);
  const selectedProviderRef = useRef(selectedProvider);
  selectedProviderRef.current = selectedProvider;
  const providerEpoch = useRef(0);
  const keyInputRevision = useRef(0);

  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const activeParakeetModel = useConfigStore((s) =>
    s.activeModelPerEngine.parakeet_tdt ?? "parakeet-tdt-0.6b-v3-int8"
  );
  const parakeetCtcEnglishOnly =
    activeParakeetModel.includes("ctc-110m") && !sttLanguage.toLowerCase().startsWith("en");

  const currentProviderOption = PROVIDER_OPTIONS.find(
    (p) => p.value === selectedProvider
  );

  // ── Load readiness state ──

  const loadLocalEngines = useCallback(async () => {
    try {
      const data = await listLocalSTTEngines();
      setLocalEngines(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadLocalEngines();
  }, [loadLocalEngines]);

  // Refresh engine readiness whenever any model download completes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ status: string }>("model_download_progress", (event) => {
      if (event.payload.status === "complete") {
        loadLocalEngines();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [loadLocalEngines]);

  // ── Badge & readiness logic ──

  function getEngineDownloadedModels(engineId: string) {
    const engine = localEngines.find((e) => e.engine === engineId);
    if (!engine) return [];
    return engine.models.filter(
      (m) => !m.id.startsWith("binary-") && m.is_downloaded
    );
  }

  function getBadgeState(p: ProviderOption): BadgeState {
    if (p.alwaysReady) return { text: "Готово", variant: "ready" };

    // Batch-only: green "Batch" if model downloaded, amber "Batch" if not
    if (p.batchOnly) {
      const downloaded = p.requiresModels
        ? getEngineDownloadedModels(p.requiresModels)
        : [];
      return { text: "Пакетная обработка", variant: downloaded.length > 0 ? "ready" : "warning" };
    }

    if (p.requiresApiKey) {
      // Verified = key was saved+tested successfully (persisted across page navigations)
      if (verifiedCloudProviders.includes(p.value)) return { text: "Готово", variant: "ready" };
      return { text: "Нет ключа", variant: "error" };
    }

    if (p.requiresModels) {
      const downloaded = getEngineDownloadedModels(p.requiresModels);
      if (downloaded.length === 0) return { text: "Нет модели", variant: "error" };
      return { text: "Готово", variant: "ready" };
    }

    return { text: "Готово", variant: "ready" };
  }

  function isProviderReady(p: ProviderOption): boolean {
    return getBadgeState(p).variant === "ready";
  }

  // ── Key loading (load stored key display when switching providers) ──

  useEffect(() => {
    const epoch = ++providerEpoch.current;
    const inputRevision = keyInputRevision.current;
    let cancelled = false;
    const current = () => !cancelled && providerEpoch.current === epoch && selectedProviderRef.current === selectedProvider;
    const loadKeyForProvider = async () => {
      setApiKey("");
      setShowApiKey(false);
      setHasStoredKey(false);
      setKeyDirty(false);
      setConnectionStatus("idle");
      setStatusMessage("");

      if (!currentProviderOption?.requiresApiKey) return;

      const credKey = currentProviderOption.credentialKey;
      if (!credKey) return;

      try {
        const keyExists = await hasApiKey(credKey);
        if (current()) setHasStoredKey(keyExists);
        if (keyExists) {
          const stored = await getApiKey(credKey);
          if (stored && current() && inputRevision === keyInputRevision.current) setApiKey(stored);
        }
      } catch (e) {
        console.warn("Failed to load STT API key:", e);
      }

      if (currentProviderOption.needsRegion) {
        try {
          const regionExists = await hasApiKey("azure_speech_region");
          if (current()) setHasStoredRegion(regionExists);
          if (regionExists) {
            const stored = await getApiKey("azure_speech_region");
            if (stored && current()) setAzureRegion(stored);
          }
        } catch (e) {
          console.warn("Failed to load Azure region:", e);
        }
      }
    };
    loadKeyForProvider();
    return () => { cancelled = true; };
  }, [selectedProvider, currentProviderOption?.credentialKey, currentProviderOption?.requiresApiKey, currentProviderOption?.needsRegion]);

  // ── Handlers ──

  const handleProviderChange = useCallback(
    async (provider: STTProviderType) => {
      selectedProviderRef.current = provider;
      setSelectedProvider(provider);
      setConnectionStatus("idle");
      setStatusMessage("");
      try {
        await setSTTProvider(provider);
        if (selectedProviderRef.current !== provider) return;
        setConfigSTTProvider(provider);
        // Sync meetingAudioConfig so useAudioConfigSync hot-swaps the live capture.
        if (meetingAudioConfig) {
          setMeetingAudioConfig({
            ...meetingAudioConfig,
            you: { ...meetingAudioConfig.you, stt_provider: provider },
          });
        }
      } catch (e) {
        console.error("Failed to set STT provider:", e);
      }
    },
    [setConfigSTTProvider, meetingAudioConfig, setMeetingAudioConfig]
  );

  /** Validate a replacement without losing the previously saved credential. */
  const handleSaveAndTest = useCallback(async () => {
    if (!apiKey.trim() || !currentProviderOption?.credentialKey) return;
    const provider = selectedProvider;
    const option = currentProviderOption;
    const candidate = apiKey.trim();
    const region = azureRegion.trim();
    const epoch = providerEpoch.current;
    const inputRevision = keyInputRevision.current;
    const current = () => selectedProviderRef.current === provider && providerEpoch.current === epoch && keyInputRevision.current === inputRevision;
    setConnectionStatus("testing");
    setStatusMessage("Проверка подключения…");
    const operation = credentialTestQueue.catch(() => {}).then(async () => {
      let previousKey: string | null = null;
      let previousRegion: string | null = null;
      let keyWriteAttempted = false;
      let regionWriteAttempted = false;
      const previouslyVerified = useConfigStore.getState().verifiedCloudProviders.includes(provider);
      try {
        // Snapshot first. If reading fails, leave the credential store untouched.
        previousKey = await getApiKey(option.credentialKey);
        if (option.needsRegion) previousRegion = await getApiKey("azure_speech_region");
        keyWriteAttempted = true;
        await storeApiKey(option.credentialKey, candidate);
        if (option.needsRegion && region) {
          regionWriteAttempted = true;
          await storeApiKey("azure_speech_region", region);
        }
        if (!(await testSTTConnection(provider))) throw new Error("Провайдер отклонил проверку. Проверьте ключ и его разрешения для распознавания речи.");
        const verified = useConfigStore.getState().verifiedCloudProviders;
        setVerifiedCloudProviders(Array.from(new Set([...verified, provider])));
        if (current()) {
          setHasStoredKey(true);
          if (option.needsRegion) setHasStoredRegion(Boolean(region || previousRegion));
          setKeyDirty(false);
          setConnectionStatus("success");
          setStatusMessage("Соединение установлено — провайдер готов");
        }
      } catch (error) {
        let restored = true;
        const restore = async (key: string, oldValue: string | null) => {
          try {
            if (oldValue !== null) await storeApiKey(key, oldValue);
            else await deleteApiKey(key);
          } catch { restored = false; }
        };
        if (keyWriteAttempted) await restore(option.credentialKey, previousKey);
        if (regionWriteAttempted) await restore("azure_speech_region", previousRegion);
        // A successful old credential remains verified when it was restored.
        if (keyWriteAttempted && !(previousKey !== null && previouslyVerified && restored)) {
          setVerifiedCloudProviders(useConfigStore.getState().verifiedCloudProviders.filter(p => p !== provider));
        }
        if (current()) {
          setHasStoredKey(previousKey !== null && restored);
          if (option.needsRegion) setHasStoredRegion(previousRegion !== null && restored);
          setKeyDirty(true); // Keep the candidate visible for correction/retry.
          setConnectionStatus("error");
          const detail = connectionFailureMessage(error, [candidate, previousKey]);
          setStatusMessage(detail + (!restored ? " Не удалось восстановить прежние данные в хранилище Windows." : previousKey !== null ? " Прежний сохранённый ключ восстановлен." : " Новый ключ не сохранён."));
        }
      }
    });
    credentialTestQueue = operation.catch(() => {});
    await operation;
  }, [apiKey, azureRegion, selectedProvider, currentProviderOption, setVerifiedCloudProviders]);

  const handleClearApiKey = useCallback(async () => {
    if (!currentProviderOption?.credentialKey) return;
    try { await deleteApiKey(currentProviderOption.credentialKey); } catch { /* ok */ }
    setApiKey("");
    setHasStoredKey(false);
    setKeyDirty(false);
    setConnectionStatus("idle");
    setStatusMessage("");
    const updated = verifiedCloudProviders.filter((p) => p !== selectedProvider);
    setVerifiedCloudProviders(updated);
  }, [currentProviderOption?.credentialKey, selectedProvider, verifiedCloudProviders, setVerifiedCloudProviders]);

  const handleSaveRegion = useCallback(async () => {
    if (!azureRegion.trim()) return;
    try {
      await storeApiKey("azure_speech_region", azureRegion.trim());
      setHasStoredRegion(true);
    } catch (e) {
      console.warn("Failed to save Azure region:", e);
    }
  }, [azureRegion]);

  /** Test Connection — only for local/always-ready providers; cloud uses handleSaveAndTest. */
  const handleTestConnection = useCallback(async () => {
    setConnectionStatus("testing");
    setStatusMessage("Проверка…");

    try {
      if (currentProviderOption?.requiresModels) {
        const engines = await listLocalSTTEngines();
        setLocalEngines(engines);
        const eng = engines.find((e) => e.engine === currentProviderOption.requiresModels);
        const downloaded = eng?.models.filter((m) => m.is_downloaded && !m.id.startsWith("binary-")) ?? [];
        if (downloaded.length === 0) {
          setConnectionStatus("error");
          setStatusMessage("Модели пока нет. Сначала скачайте её ниже.");
          return;
        }
        setConnectionStatus("success");
        setStatusMessage(`Готово. Доступных моделей: ${downloaded.length}`);
        return;
      }

      const success = await testSTTConnection(selectedProvider);
      setConnectionStatus(success ? "success" : "error");
      setStatusMessage(success ? "Готово" : "Не удалось подключиться");
    } catch (e) {
      setConnectionStatus("error");
      setStatusMessage(`Проверка не пройдена: ${e}`);
    }
  }, [selectedProvider, currentProviderOption]);

  // Does the selected provider need an inline model panel?
  const showModelPanel = !!currentProviderOption?.requiresModels;
  const modelEngineId = currentProviderOption?.requiresModels;

  const localProviders = PROVIDER_OPTIONS.filter((p) => p.isLocal);
  const cloudProviders = PROVIDER_OPTIONS.filter((p) => !p.isLocal);

  return (
    <div className="space-y-6">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Провайдер ответов ИИ и провайдер распознавания речи настраиваются отдельно.
      </p>
      {/* Provider Selection — grouped: Local then Cloud */}
      <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
        {/* Local Providers */}
        <div className="px-5 pt-4 pb-3 border-b border-border/20 bg-muted/10">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-success/10">
              <HardDrive className="h-3 w-3 text-success" />
            </div>
            <span className="text-xs font-semibold text-foreground">Локальные и встроенные</span>
            <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">Бесплатно · Без API-ключа</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {localProviders.map((p) => (
              <ProviderCard
                key={p.value}
                provider={p}
                isSelected={selectedProvider === p.value}
                isActive={sttProvider === p.value}
                badge={getBadgeState(p)}
                onClick={() => handleProviderChange(p.value)}
              />
            ))}
          </div>
        </div>

        {/* Cloud Providers */}
        <div className="px-5 pt-4 pb-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-info/10">
              <Cloud className="h-3 w-3 text-info" />
            </div>
            <span className="text-xs font-semibold text-foreground">Облачные</span>
            <span className="ml-auto text-meta text-muted-foreground/60 font-medium uppercase tracking-wider">Нужен API-ключ</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {cloudProviders.map((p) => (
              <ProviderCard
                key={p.value}
                provider={p}
                isSelected={selectedProvider === p.value}
                isActive={sttProvider === p.value}
                badge={getBadgeState(p)}
                onClick={() => handleProviderChange(p.value)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Inline Model Panel — shown when the selected provider needs models */}
      {showModelPanel && modelEngineId && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-1 text-sm font-semibold text-primary/80 flex items-center gap-1.5">
            <HardDrive className="h-4 w-4" />
            {currentProviderOption?.label} Модели
            {currentProviderOption?.batchOnly && (
              <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
                Пакетная обработка
              </span>
            )}
          </h3>
          {currentProviderOption?.batchOnly && (
            <p className="mb-3 text-xs text-muted-foreground/70">
              Whisper.cpp распознаёт записи после встречи. Обработка доступна в истории встреч.
            </p>
          )}
          {!currentProviderOption?.batchOnly && (
            <p className="mb-3 text-xs text-muted-foreground">
              Скачайте модель и нажмите <strong>Включить</strong> для включения этого провайдера.
            </p>
          )}
          <LocalModelManager engineFilter={modelEngineId} />
        </div>
      )}

      {/* API Key — cloud providers only. Save & Test flow: test first, persist only on success. */}
      {currentProviderOption?.requiresApiKey && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">API-ключ</h3>
          {selectedProvider === "whisper_api" && (
            <p id="whisper-api-key-help" className="mb-3 text-xs leading-relaxed text-muted-foreground">
              Whisper API подключается напрямую к OpenAI (api.openai.com). Нужен ключ OpenAI с доступом к распознаванию речи. Ключи FreeCodex и других посредников для этого подключения не подходят.
            </p>
          )}

          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  keyInputRevision.current++;
                  setApiKey(e.target.value);
                  setKeyDirty(true);
                  setConnectionStatus("idle");
                  setStatusMessage("");
                }}
                placeholder={
                  hasStoredKey && !keyDirty
                    ? "Ключ сохранён — введите новый для замены"
                    : `Введите API-ключ ${currentProviderOption.label}`
                }
                aria-label="API-ключ распознавания речи"
                aria-describedby={selectedProvider === "whisper_api" ? "whisper-api-key-help" : undefined}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                type="button"
                aria-label={showApiKey ? "Скрыть API-ключ" : "Показать API-ключ"}
                aria-pressed={showApiKey}
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Save & Test — shown whenever user has typed a key */}
            {(keyDirty || (!hasStoredKey && apiKey.trim())) && (
              <button
                onClick={handleSaveAndTest}
                disabled={!apiKey.trim() || connectionStatus === "testing"}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connectionStatus === "testing" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wifi className="h-3.5 w-3.5" />
                )}
                Сохранить и проверить
              </button>
            )}

            {/* Clear — only if key is stored and verified, and user hasn't started typing a new one */}
            {hasStoredKey && !keyDirty && (
              <button
                onClick={handleClearApiKey}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Очистить
              </button>
            )}
          </div>

          {/* Status feedback */}
          <div className="mt-2 min-h-[18px]">
            {connectionStatus === "success" && (
              <div className="flex items-center gap-1.5 text-xs text-success">
                <CheckCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {connectionStatus === "error" && (
              <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive whitespace-pre-wrap break-words">
                <XCircle className="h-3 w-3" />
                {statusMessage}
              </div>
            )}
            {connectionStatus === "idle" && hasStoredKey && !keyDirty && (
              <p className="text-xs text-success/70">
                API-ключ сохранён в защищённом хранилище
              </p>
            )}
            {connectionStatus === "idle" && !hasStoredKey && (
              <p className="text-xs text-muted-foreground">
                Введите ключ и нажмите «Сохранить и проверить»
              </p>
            )}
          </div>
        </div>
      )}

      {/* Azure Region Input */}
      {currentProviderOption?.needsRegion && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">
            Регион Azure
          </h3>
          <input
            type="text"
            value={azureRegion}
            onChange={(e) => setAzureRegion(e.target.value)}
            onBlur={handleSaveRegion}
            placeholder="eastus"
            className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Регион вашего ресурса Azure Speech Services, например eastus или westeurope
          </p>
        </div>
      )}

      {/* Universal Pause Detection */}
      <PauseThresholdSetting />

      {/* Deepgram Advanced Settings — shown when Deepgram is selected */}
      {selectedProvider === "deepgram" && <DeepgramAdvancedSettings />}

      {/* Groq Whisper Settings — shown when Groq is selected */}
      {selectedProvider === "groq_whisper" && <GroqAdvancedSettings />}

      {/* Whisper.cpp Dual-Pass Settings */}
      {selectedProvider === "whisper_cpp" && <DualPassSettings />}
      {selectedProvider === "faster_whisper" && <FasterWhisperSettings />}

      {/* Language Selection */}
      {selectedProvider !== "faster_whisper" && <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <h3 className="mb-3 text-sm font-semibold text-primary/80">
          Язык
        </h3>
        <select
          value={sttLanguage}
          onChange={(e) => setSTTLanguage(e.target.value)}
          aria-label="Язык распознавания"
          className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
        {selectedProvider === "parakeet_tdt" && parakeetCtcEnglishOnly && (
          <p className="mt-2 text-xs text-warning">
            Parakeet CTC 110M распознаёт только английский. Для русского используйте Parakeet TDT 0.6B v3.
          </p>
        )}
      </div>}

      {/* Test Connection — only for local/always-ready providers; cloud uses Save & Test in the key section */}
      {!currentProviderOption?.requiresApiKey && selectedProvider !== "faster_whisper" && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5">
          <h3 className="mb-3 text-sm font-semibold text-primary/80">Подключение</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === "testing"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connectionStatus === "testing" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )}
              Проверить подключение
            </button>

            {connectionStatus === "success" && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3.5 w-3.5" />
                <span className="text-xs">{statusMessage}</span>
              </div>
            )}
            {connectionStatus === "error" && (
              <div className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                <span className="text-xs truncate max-w-[200px]">{statusMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Provider Card ──

function ProviderCard({
  provider,
  isSelected,
  isActive,
  badge,
  onClick,
}: {
  provider: ProviderOption;
  isSelected: boolean;
  isActive: boolean;
  badge: BadgeState;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={isSelected}
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary/20 shadow-sm"
          : "border-border/40 bg-card/30 hover:border-border/70 hover:bg-accent/60"
      }`}
    >
      <div className="flex w-full items-start justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <ProviderIcon value={provider.value} isSelected={isSelected} />
          <span className={`text-xs font-medium truncate ${isSelected ? "text-primary" : "text-foreground"}`}>
            {provider.label}
          </span>
        </div>
        <ProviderBadge
          text={badge.text}
          variant={badge.variant}
        />
      </div>
      <span className="text-meta text-muted-foreground/70 line-clamp-1 leading-tight">
        {provider.batchOnly ? "Только обработка записей" : provider.description}
      </span>
    </button>
  );
}

// ── Provider Badge ──

function ProviderBadge({ text, variant }: { text: string; variant: BadgeVariant }) {
  const styles: Record<BadgeVariant, string> = {
    ready: "bg-success/20 text-success border-success/20",
    warning: "bg-warning/20 text-warning border-warning/20",
    error: "bg-destructive/20 text-destructive border-destructive/20",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[8px] font-semibold tracking-wide ${styles[variant]}`}
    >
      {text}
    </span>
  );
}

// ── Provider icon helper ──

function ProviderIcon({ value, isSelected }: { value: STTProviderType; isSelected?: boolean }) {
  const cls = `h-3.5 w-3.5 shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`;
  switch (value) {
    case "web_speech":
      return <Globe className={cls} />;
    case "windows_native":
      return <Monitor className={cls} />;
    case "whisper_cpp":
    case "sherpa_onnx":
      return <HardDrive className={cls} />;
    case "ort_streaming":
      return <Zap className={cls} />;
    case "parakeet_tdt":
      return <Cpu className={cls} />;
    case "deepgram":
    case "whisper_api":
    case "azure_speech":
      return <Cloud className={cls} />;
    case "groq_whisper":
      return <Zap className={cls} />;
    default:
      return <Server className={cls} />;
  }
}

// ── Universal Pause Threshold Setting ──

function PauseThresholdSetting() {
  const pauseThresholdMs = useConfigStore((s) => s.pauseThresholdMs);
  const setPauseThresholdMs = useConfigStore((s) => s.setPauseThresholdMs);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        Пауза перед новой строкой
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        После такой паузы текст начинается с новой строки. Короткая пауза создаёт больше строк, длинная — более крупные абзацы. Применяется ко всем движкам.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={500}
          max={5000}
          step={100}
          value={pauseThresholdMs}
          onChange={(e) => setPauseThresholdMs(parseInt(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <span className="min-w-[4rem] text-right text-xs font-mono text-primary tabular-nums">
          {(pauseThresholdMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="mt-1.5 flex justify-between text-meta text-muted-foreground/70">
        <span>0,5 с (больше строк)</span>
        <span>5,0 с (длиннее абзацы)</span>
      </div>
    </div>
  );
}

// ── Deepgram Advanced Settings ──

function DeepgramAdvancedSettings() {
  const deepgramConfig = useConfigStore((s) => s.deepgramConfig);
  const setDeepgramConfig = useConfigStore((s) => s.setDeepgramConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keytermInput, setKeytermInput] = useState("");

  const activePresetId = DEEPGRAM_PRESETS.find((p) =>
    configMatchesPreset(deepgramConfig, p.config)
  )?.id ?? "custom";

  const applyPreset = (preset: DeepgramPreset) => {
    setDeepgramConfig({ ...preset.config, keyterms: deepgramConfig.keyterms });
  };

  const updateField = <K extends keyof DeepgramConfig>(key: K, value: DeepgramConfig[K]) => {
    setDeepgramConfig({ ...deepgramConfig, [key]: value });
  };

  const addKeyterm = () => {
    const term = keytermInput.trim();
    if (!term || deepgramConfig.keyterms.includes(term) || deepgramConfig.keyterms.length >= 100) return;
    updateField("keyterms", [...deepgramConfig.keyterms, term]);
    setKeytermInput("");
  };

  const removeKeyterm = (term: string) => {
    updateField("keyterms", deepgramConfig.keyterms.filter((k) => k !== term));
  };

  const activeModel = DEEPGRAM_MODELS.find((m) => m.id === deepgramConfig.model);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">Настройки Deepgram</span>
          {activePresetId !== "custom" && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {DEEPGRAM_PRESETS.find((p) => p.id === activePresetId)?.label}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              Свой вариант
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              ${activeModel.costPerMin.toFixed(4)}/min · {activeModel.label}
            </span>
          )}
        </div>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">Готовые настройки</p>
        <div className="flex flex-wrap gap-1.5">
          {DEEPGRAM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={preset.description}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Модель</label>
        <div className="grid grid-cols-2 gap-1.5">
          {DEEPGRAM_MODELS.map((model) => {
            const tierColors: Record<string, string> = {
              latest: "text-success",
              standard: "text-info",
              economy: "text-warning",
              whisper: "text-purple-400",
            };
            return (
              <button
                key={model.id}
                onClick={() => updateField("model", model.id)}
                className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                  deepgramConfig.model === model.id
                    ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                    : "border-border/30 hover:border-border/60 hover:bg-accent/40"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-semibold ${deepgramConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                      {model.label}
                    </span>
                    {model.tier === "latest" && (
                      <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">НОВОЕ</span>
                    )}
                  </div>
                  <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{model.description}</p>
                  <p className={`text-meta font-mono mt-0.5 ${tierColors[model.tier]}`}>${model.costPerMin.toFixed(4)}/min</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Core Feature Toggles */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-2 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Возможности</label>
        <div className="space-y-2">
          <DeepgramToggle
            label="Умное форматирование"
            param="smart_format"
            description="Форматировать даты, время, числа и делить текст на абзацы"
            checked={deepgramConfig.smart_format}
            onChange={(v) => updateField("smart_format", v)}
          />
          <DeepgramToggle
            label="Промежуточные результаты"
            param="interim_results"
            description="Показывать текст во время речи для быстрого отклика"
            checked={deepgramConfig.interim_results}
            onChange={(v) => updateField("interim_results", v)}
          />
          <DeepgramToggle
            label="Пунктуация"
            param="punctuate"
            description="Добавлять знаки препинания и заглавные буквы"
            checked={deepgramConfig.punctuate}
            onChange={(v) => updateField("punctuate", v)}
          />
          <DeepgramToggle
            label="Определение речи"
            param="vad_events"
            description="Определять начало и конец речи для точного разделения фраз"
            checked={deepgramConfig.vad_events}
            onChange={(v) => updateField("vad_events", v)}
          />
        </div>
      </div>

      {/* Endpointing */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">Определение конца фразы</span>
            <code className="ml-2 text-meta text-muted-foreground/60">endpointing=NUMBER</code>
          </div>
          <button
            onClick={() => updateField("endpointing", deepgramConfig.endpointing === null ? 300 : null)}
            className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
              deepgramConfig.endpointing !== null ? "bg-primary" : "bg-muted"
            }`}
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              deepgramConfig.endpointing !== null ? "translate-x-4" : "translate-x-0.5"
            }`} />
          </button>
        </div>
        {deepgramConfig.endpointing !== null && (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-meta text-muted-foreground">Порог тишины</span>
              <span className="text-meta font-mono text-primary tabular-nums">{deepgramConfig.endpointing}ms</span>
            </div>
            <input
              type="range"
              min={10}
              max={2000}
              step={10}
              value={deepgramConfig.endpointing}
              onChange={(e) => updateField("endpointing", parseInt(e.target.value))}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">10 мс (быстро)</span>
              <span className="text-meta text-muted-foreground/70">2000 мс (медленно)</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              Выдавать текст после такой паузы. Обычно подходят значения 10–999 мс.
            </p>
          </>
        )}
        {deepgramConfig.endpointing === null && (
          <p className="text-meta text-muted-foreground/60">Выключено — используются настройки сервера</p>
        )}
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">Дополнительные настройки</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Advanced Feature Toggles */}
          <div className="px-5 py-3 border-b border-border/20 space-y-2">
            <DeepgramToggle
              label="Различать голоса собеседников"
              param="diarize"
              description="Отмечать каждого собеседника номером: Участник 1, 2… Не применяется к вашему микрофону."
              checked={deepgramConfig.diarize}
              onChange={(v) => updateField("diarize", v)}
            />
            <DeepgramToggle
              label="Числа цифрами"
              param="numerals"
              description='Convert spoken numbers to digits ("nine hundred" → "900")'
              checked={deepgramConfig.numerals}
              onChange={(v) => updateField("numerals", v)}
            />
            <DeepgramToggle
              label="Фильтр ненормативной лексики"
              param="profanity_filter"
              description="Удалять ненормативную лексику из текста"
              checked={deepgramConfig.profanity_filter}
              onChange={(v) => updateField("profanity_filter", v)}
            />
            <DeepgramToggle
              label="Диктовка"
              param="dictation"
              description='Format spoken punctuation commands ("period" → ".")'
              checked={deepgramConfig.dictation}
              onChange={(v) => updateField("dictation", v)}
            />
          </div>

          {/* Keyterm Prompting */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">Ключевые слова</span>
              <code className="text-meta text-muted-foreground/60">keyterm=TERM</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              Улучшайте распознавание имён, названий и терминов. До 100 ключевых слов.
            </p>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={keytermInput}
                onChange={(e) => setKeytermInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addKeyterm(); }}
                placeholder="Введите слово или фразу…"
                className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
              <button
                onClick={addKeyterm}
                disabled={!keytermInput.trim() || deepgramConfig.keyterms.length >= 100}
                className="rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                Добавить
              </button>
            </div>
            {deepgramConfig.keyterms.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {deepgramConfig.keyterms.map((term) => (
                  <span
                    key={term}
                    className="flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-2 py-0.5 text-meta text-foreground"
                  >
                    {term}
                    <button
                      onClick={() => removeKeyterm(term)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {deepgramConfig.keyterms.length === 0 && (
              <p className="text-meta text-muted-foreground/70">Ключевые слова не заданы — стандартное распознавание</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Deepgram Toggle Row ──

function DeepgramToggle({
  label,
  param,
  description,
  checked,
  onChange,
}: {
  label: string;
  param: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <code className="text-meta text-muted-foreground/70">{param}={checked ? "true" : "false"}</code>
        </div>
        <p className="text-meta text-muted-foreground/60 leading-tight mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`shrink-0 relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`} />
      </button>
    </div>
  );
}

// ── Groq Models & Presets ──

interface GroqModelInfo {
  id: string;
  label: string;
  description: string;
  costPerHour: number;
  speedFactor: string;
}

const GROQ_MODELS: GroqModelInfo[] = [
  {
    id: "whisper-large-v3",
    label: "Whisper Large v3",
    description: "Высокая точность, более 99 языков",
    costPerHour: 0.111,
    speedFactor: "189x",
  },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    description: "Быстро и недорого",
    costPerHour: 0.04,
    speedFactor: "216x",
  },
];

interface GroqPreset {
  id: string;
  label: string;
  description: string;
  config: GroqConfig;
}

const GROQ_PRESETS: GroqPreset[] = [
  {
    id: "default",
    label: "По умолчанию",
    description: "Баланс: быстрая модель, фрагменты по 5 с",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
  {
    id: "low_latency",
    label: "Минимальная задержка",
    description: "Фрагменты по 3 с для быстрого результата",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 3.0,
    },
  },
  {
    id: "high_accuracy",
    label: "Высокая точность",
    description: "Точная модель, фрагменты по 8 с для контекста",
    config: {
      model: "whisper-large-v3",
      language: "en",
      temperature: 0,
      response_format: "json",
      timestamp_granularities: [],
      prompt: "",
      segment_duration_secs: 8.0,
    },
  },
  {
    id: "verbose",
    label: "Подробно",
    description: "Временные метки слов и данные фрагментов",
    config: {
      model: "whisper-large-v3-turbo",
      language: "en",
      temperature: 0,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      prompt: "",
      segment_duration_secs: 5.0,
    },
  },
];

function groqConfigMatchesPreset(config: GroqConfig, preset: GroqConfig): boolean {
  return (
    config.model === preset.model &&
    config.temperature === preset.temperature &&
    config.response_format === preset.response_format &&
    config.segment_duration_secs === preset.segment_duration_secs &&
    JSON.stringify(config.timestamp_granularities) === JSON.stringify(preset.timestamp_granularities)
    // prompt excluded from preset matching — user-specific
  );
}

// ── Groq Advanced Settings ──

function GroqAdvancedSettings() {
  const groqConfig = useConfigStore((s) => s.groqConfig);
  const setGroqConfig = useConfigStore((s) => s.setGroqConfig);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activePresetId = GROQ_PRESETS.find((p) =>
    groqConfigMatchesPreset(groqConfig, p.config)
  )?.id ?? "custom";

  const applyPreset = (preset: GroqPreset) => {
    setGroqConfig({ ...preset.config, prompt: groqConfig.prompt });
  };

  const updateField = <K extends keyof GroqConfig>(key: K, value: GroqConfig[K]) => {
    setGroqConfig({ ...groqConfig, [key]: value });
  };

  const activeModel = GROQ_MODELS.find((m) => m.id === groqConfig.model);

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border/20">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
            <Settings2 className="h-3 w-3 text-primary" />
          </div>
          <span className="text-xs font-semibold text-foreground">Настройки Groq Whisper</span>
          {activePresetId !== "custom" && (
            <span className="ml-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-meta font-semibold text-primary uppercase tracking-wide">
              {GROQ_PRESETS.find((p) => p.id === activePresetId)?.label}
            </span>
          )}
          {activePresetId === "custom" && (
            <span className="ml-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta font-semibold text-warning uppercase tracking-wide">
              Свой вариант
            </span>
          )}
          {activeModel && (
            <span className="ml-auto text-meta text-muted-foreground/60">
              ${activeModel.costPerHour.toFixed(3)}/ч · {activeModel.speedFactor} от реального времени
            </span>
          )}
        </div>
        <p className="mt-1.5 text-meta text-muted-foreground/60 leading-tight">
          Пакетный режим: звук накапливается и отправляется каждые {groqConfig.segment_duration_secs}s.
          Общая задержка — около {groqConfig.segment_duration_secs + 1}–{groqConfig.segment_duration_secs + 2} с.
        </p>
      </div>

      {/* Presets */}
      <div className="px-5 py-3 border-b border-border/20 bg-muted/5">
        <p className="mb-2 text-meta font-medium text-muted-foreground uppercase tracking-wider">Готовые настройки</p>
        <div className="flex flex-wrap gap-1.5">
          {GROQ_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              title={preset.description}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                activePresetId === preset.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model Selection */}
      <div className="px-5 py-3 border-b border-border/20">
        <label className="mb-1.5 block text-meta font-medium text-muted-foreground uppercase tracking-wider">Модель</label>
        <div className="grid grid-cols-2 gap-1.5">
          {GROQ_MODELS.map((model) => (
            <button
              key={model.id}
              onClick={() => updateField("model", model.id)}
              className={`flex items-start rounded-lg border px-3 py-2 text-left transition-all ${
                groqConfig.model === model.id
                  ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                  : "border-border/30 hover:border-border/60 hover:bg-accent/40"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-semibold ${groqConfig.model === model.id ? "text-primary" : "text-foreground"}`}>
                    {model.label}
                  </span>
                  {model.id === "whisper-large-v3-turbo" && (
                    <span className="rounded bg-success/10 px-1 py-0.5 text-[8px] font-bold text-success">БЫСТРО</span>
                  )}
                  {model.id === "whisper-large-v3" && (
                    <span className="rounded bg-info/10 px-1 py-0.5 text-[8px] font-bold text-info">ТОЧНО</span>
                  )}
                </div>
                <p className="text-meta text-muted-foreground/70 leading-tight mt-0.5">{model.description}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-meta font-mono text-success">${model.costPerHour.toFixed(3)}/hr</span>
                  <span className="text-meta text-muted-foreground/70">{model.speedFactor}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Batch Duration */}
      <div className="px-5 py-3 border-b border-border/20">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs font-medium text-foreground">Длина аудиофрагмента</span>
            <code className="ml-2 text-meta text-muted-foreground/60">segment={groqConfig.segment_duration_secs}s</code>
          </div>
        </div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-meta text-muted-foreground">Время накопления звука</span>
          <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.segment_duration_secs.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min={2}
          max={15}
          step={0.5}
          value={groqConfig.segment_duration_secs}
          onChange={(e) => updateField("segment_duration_secs", parseFloat(e.target.value))}
          className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between mt-0.5">
          <span className="text-meta text-muted-foreground/70">2 с (быстрее, меньше контекста)</span>
          <span className="text-meta text-muted-foreground/70">15 с (медленнее, больше контекста)</span>
        </div>
        <p className="mt-1 text-meta text-muted-foreground/60">
          Короткие фрагменты дают быстрый ответ, но меньше контекста. Минимальная оплачиваемая длина — 10 с.
        </p>
      </div>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex w-full items-center justify-between px-5 py-2.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <span className="font-medium">Дополнительные настройки</span>
        {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {showAdvanced && (
        <div className="border-t border-border/20">
          {/* Temperature */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">Температура</span>
                <code className="text-meta text-muted-foreground/70">temperature={groqConfig.temperature}</code>
              </div>
              <span className="text-meta font-mono text-primary tabular-nums">{groqConfig.temperature.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={groqConfig.temperature}
              onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
              className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-meta text-muted-foreground/70">0 (предсказуемо)</span>
              <span className="text-meta text-muted-foreground/70">1 (творчески)</span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground/60">
              Низкие значения дают стабильный результат. Для распознавания рекомендуется 0.
            </p>
          </div>

          {/* Response Format */}
          <div className="px-5 py-3 border-b border-border/20">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-xs font-medium text-foreground">Формат ответа</span>
              <code className="text-meta text-muted-foreground/70">response_format={groqConfig.response_format}</code>
            </div>
            <div className="flex gap-1.5">
              {(["json", "verbose_json", "text"] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => {
                    updateField("response_format", fmt);
                    // Clear granularities when switching away from verbose_json
                    if (fmt !== "verbose_json") {
                      updateField("timestamp_granularities", []);
                    }
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                    groqConfig.response_format === fmt
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/40 bg-card/50 text-muted-foreground hover:border-border/70 hover:text-foreground"
                  }`}
                >
                  {fmt === "json" ? "JSON" : fmt === "verbose_json" ? "Verbose JSON" : "Text"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-meta text-muted-foreground/60">
              {groqConfig.response_format === "verbose_json"
                ? "Временные метки слов и фрагментов, уверенность и вероятность отсутствия речи"
                : groqConfig.response_format === "text"
                  ? "Только текст, без дополнительных данных"
                  : "Стандартный JSON с полем текста"}
            </p>
          </div>

          {/* Timestamp Granularities — only for verbose_json */}
          {groqConfig.response_format === "verbose_json" && (
            <div className="px-5 py-3 border-b border-border/20">
              <span className="text-xs font-medium text-foreground mb-2 block">Временные метки</span>
              <div className="space-y-2">
                {(["segment", "word"] as const).map((gran) => (
                  <DeepgramToggle
                    key={gran}
                    label={gran === "segment" ? "Метки фрагментов" : "Метки слов"}
                    param={`timestamp_granularities[]=${gran}`}
                    description={gran === "segment"
                      ? "Добавлять время начала и конца каждого фрагмента"
                      : "Добавлять время начала и конца каждого слова"}
                    checked={groqConfig.timestamp_granularities.includes(gran)}
                    onChange={(v) => {
                      const current = groqConfig.timestamp_granularities;
                      const updated = v
                        ? [...current, gran]
                        : current.filter((g) => g !== gran);
                      updateField("timestamp_granularities", updated);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Prompt */}
          <div className="px-5 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground">Инструкция</span>
              <code className="text-meta text-muted-foreground/60">prompt</code>
            </div>
            <p className="mb-2 text-meta text-muted-foreground/70">
              Укажите стиль, написание терминов или контекст. До 224 токенов на языке аудиозаписи.
            </p>
            <textarea
              value={groqConfig.prompt}
              onChange={(e) => updateField("prompt", e.target.value)}
              placeholder="e.g., NexQ, Tauri, WASAPI, transcription..."
              rows={2}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
            />
            {groqConfig.prompt && (
              <p className="mt-1 text-meta text-muted-foreground/70">
                ~{Math.ceil(groqConfig.prompt.length / 4)} токенов (не более 224)
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dual-Pass Settings ──

function DualPassSettings() {
  const dualPass = useConfigStore((s) => s.whisperDualPass);
  const setDualPass = useConfigStore((s) => s.setWhisperDualPass);

  const update = (key: keyof typeof dualPass, value: number) => {
    setDualPass({ ...dualPass, [key]: value });
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-primary/80">
        Тонкая настройка распознавания
      </h3>
      <p className="mb-4 text-meta text-muted-foreground">
        Первый проход быстро показывает слова, второй уточняет текст. Изменения применяются сразу.
      </p>

      <div className="space-y-4">
        <SliderSetting
          label="Интервал быстрого прохода"
          value={dualPass.shortChunkSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint="Shorter = faster words but less accurate"
          onChange={(v) => update("shortChunkSecs", v)}
        />
        <SliderSetting
          label="Интервал уточнения"
          value={dualPass.longChunkSecs}
          min={2.0}
          max={8.0}
          step={0.5}
          unit="s"
          hint="Longer = more context for correction"
          onChange={(v) => update("longChunkSecs", v)}
        />
        <SliderSetting
          label="Пауза перед новой строкой"
          value={dualPass.pauseSecs}
          min={0.5}
          max={3.0}
          step={0.1}
          unit="s"
          hint="Silence before starting a new transcript line"
          onChange={(v) => update("pauseSecs", v)}
        />
      </div>
    </div>
  );
}

function SliderSetting({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-foreground">{label}</label>
        <span className="text-xs font-mono text-primary tabular-nums">
          {value.toFixed(1)}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full bg-muted appearance-none cursor-pointer accent-primary"
      />
      <p className="mt-0.5 text-meta text-muted-foreground/60">{hint}</p>
    </div>
  );
}
