// Shared service status bar used in both Dashboard and Meeting Overlay footers.
// Shows LLM, You STT, and Them STT with provider + model, lighting up when active.
// During recording: STT chips are interactive (click to swap provider), with mute toggles.

import { useState, useEffect, useLayoutEffect, useRef, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Brain, Mic, MicOff, Volume2, VolumeX, Zap, Cpu,
  ChevronUp, CheckCircle, Globe, Monitor, HardDrive, Cloud, ArrowUpCircle,
} from "lucide-react";
import { storedProviderConfig, useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import { hasApiKey, listLocalSTTEngines, getApiKey } from "../lib/ipc";
import type { STTProviderType, LLMProviderType, LocalSTTEngineInfo } from "../lib/types";
import { showToast } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { useAgentStore } from "../stores/agentStore";
import { AgentStatusChip } from "./AgentStatusChip";
import { StreamLatency } from "./StreamLatency";
import { claudeTierLabel } from "../settings/ClaudeCliSettings";
import { restartToUpdate } from "../hooks/useUpdater";

// ── Human-friendly provider labels ──
const LLM_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  custom: "Свой провайдер",
  claude_cli: "Claude",
};

export const STT_LABELS: Record<string, string> = {
  faster_whisper: "Faster Whisper",
  web_speech: "Web Speech",
  whisper_cpp: "Whisper.cpp",
  deepgram: "Deepgram",
  whisper_api: "Whisper API",
  azure_speech: "Azure",
  groq_whisper: "Groq STT",
  sherpa_onnx: "Sherpa-ONNX",
  ort_streaming: "ORT Streaming",
  parakeet_tdt: "Parakeet TDT",
  windows_native: "Windows Speech",
};

// ── STT provider options for the quick-swap picker ──
// Mirrors MeetingAudioSettings.tsx STT_OPTIONS — same availability rules apply.
const STT_PROVIDER_OPTIONS: {
  value: STTProviderType;
  label: string;
  IconComponent: React.ComponentType<{ className?: string }>;
  requiresKey: boolean;
  isCloud: boolean;
  inputOnly?: boolean;
  requiresDownload?: string;
}[] = [
  { value: "faster_whisper", label: "Faster Whisper", IconComponent: Cpu, requiresKey: false, isCloud: false, requiresDownload: "faster_whisper" },
  { value: "web_speech", label: "Web Speech", IconComponent: Globe, requiresKey: false, isCloud: false, inputOnly: true },
  { value: "windows_native", label: "Windows Speech", IconComponent: Monitor, requiresKey: false, isCloud: false, inputOnly: true },
  { value: "sherpa_onnx", label: "Sherpa-ONNX", IconComponent: HardDrive, requiresKey: false, isCloud: false, requiresDownload: "sherpa_onnx" },
  { value: "ort_streaming", label: "ORT Streaming", IconComponent: Zap, requiresKey: false, isCloud: false, requiresDownload: "ort_streaming" },
  { value: "parakeet_tdt", label: "Parakeet TDT", IconComponent: Cpu, requiresKey: false, isCloud: false, requiresDownload: "parakeet_tdt" },
  { value: "deepgram", label: "Deepgram", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "whisper_api", label: "Whisper API", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "azure_speech", label: "Azure Speech", IconComponent: Cloud, requiresKey: true, isCloud: true },
  { value: "groq_whisper", label: "Groq Whisper", IconComponent: Zap, requiresKey: true, isCloud: true },
];

// ── Web Speech / Windows Speech mutual exclusion ──
// These providers capture from the OS default mic via a single SpeechRecognition instance.
// Only one can be active across both parties at any time.
const EXCLUSIVE_PROVIDERS: STTProviderType[] = ["web_speech", "windows_native"];

const EXCLUSIVE_FALLBACK_ORDER: STTProviderType[] = [
  "deepgram", "groq_whisper", "whisper_api", "azure_speech",
  "faster_whisper", "sherpa_onnx", "ort_streaming", "parakeet_tdt",
];

function isExclusiveProvider(provider: string): boolean {
  return EXCLUSIVE_PROVIDERS.includes(provider as STTProviderType);
}

// ── LLM provider options for quick-swap ──
const LLM_PROVIDER_OPTIONS: {
  value: LLMProviderType;
  label: string;
  IconComponent: React.ComponentType<{ className?: string }>;
  requiresKey: boolean;
  isLocal: boolean;
}[] = [
  { value: "ollama", label: "Ollama", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "lm_studio", label: "LM Studio", IconComponent: Monitor, requiresKey: false, isLocal: true },
  { value: "openai", label: "OpenAI", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "anthropic", label: "Anthropic", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "groq", label: "Groq", IconComponent: Zap, requiresKey: true, isLocal: false },
  { value: "gemini", label: "Gemini", IconComponent: Cloud, requiresKey: true, isLocal: false },
  { value: "openrouter", label: "OpenRouter", IconComponent: Globe, requiresKey: true, isLocal: false },
  { value: "custom", label: "Свой провайдер", IconComponent: HardDrive, requiresKey: false, isLocal: false },
];

function formatModel(model: string): string {
  return model || "Модель не выбрана";
}

function formatSttModel(modelId: string): string {
  if (!modelId) return "";
  return modelId
    .replace(/^sherpa-onnx-nemo-/, "")
    .replace(/^sherpa-onnx-/, "")
    .replace(/^parakeet-/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")  // Strip date suffix
    .replace(/-int8$/, "")
    .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatSttLabel(provider: string, localModelId?: string): { provider: string; model: string } {
  const providerLabel = STT_LABELS[provider] || provider;
  if (provider === "faster_whisper") return { provider: providerLabel, model: localModelId?.includes("int8") ? "Turbo INT8" : localModelId?.replace("large-v3", "Large V3") ?? "Turbo INT8" };
  const localProviders = ["whisper_cpp", "sherpa_onnx", "ort_streaming", "parakeet_tdt"];
  if (localProviders.includes(provider) && localModelId) {
    return { provider: providerLabel, model: formatSttModel(localModelId) };
  }
  return { provider: providerLabel, model: "" };
}

/**
 * Unified service status bar for both Dashboard footer and Meeting overlay footer.
 * Reads directly from Zustand stores so it reacts to settings changes immediately.
 *
 * `compact` — used in the meeting overlay (less padding, tighter spacing)
 *
 * During an active recording, STT chips become interactive:
 * - Click to open an upward dropdown to switch STT provider
 * - Mute toggle button to silence each audio source
 */
export function ServiceStatusBar({ compact = false }: { compact?: boolean }) {
  // Config (reactive)
  const llmProvider = useConfigStore((s) => s.llmProvider);
  const llmModel = useConfigStore((s) => s.llmModel);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  const activeWhisperModel = useConfigStore((s) => s.activeWhisperModel);
  const activeModelPerEngine = useConfigStore((s) => s.activeModelPerEngine);
  const setMeetingAudioConfig = useConfigStore((s) => s.setMeetingAudioConfig);

  // Active state
  const isRecording = useMeetingStore((s) => s.isRecording);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const speakerOrder = useSpeakerStore((s) => s.speakerOrder);
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const streamProvider = useStreamStore((s) => s.currentProvider);
  const streamModel = useStreamStore((s) => s.currentModel);
  const { micLevel, systemLevel } = useAudioLevel();

  // Mute state (session-only, not persisted)
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);

  // Picker state (LLM or STT)
  const [pickerOpen, setPickerOpen] = useState<"llm" | "you" | "them" | null>(null);
  const llmAnchor = useRef<HTMLDivElement>(null);
  const activateLLMProvider = useConfigStore((s) => s.activateLLMProvider);

  // ── Derive display values ──
  // While an answer streams, name what serves it (it can be a fallback);
  // otherwise the active provider. The stream store keeps the last stream's
  // provider until the meeting ends, so it must not outlive the stream.
  const shownProvider = (isStreaming && streamProvider) || llmProvider;
  const shownModel = (isStreaming && streamModel) || llmModel;
  const llmProviderLabel = LLM_LABELS[shownProvider] || shownProvider;
  const llmModelLabel = formatModel(shownModel);

  const DEFAULT_MODEL_PER_ENGINE: Record<string, string> = {
    faster_whisper: "voxta/faster-whisper-large-v3-turbo-int8",
    sherpa_onnx: "streaming-zipformer-en-20M",
    ort_streaming: "zipformer-en-20M",
    parakeet_tdt: "parakeet-tdt-0.6b-v3-int8",
  };

  const youSttProvider = meetingAudioConfig?.you.stt_provider ?? "web_speech";
  const youLocalModel = meetingAudioConfig?.you.local_model_id
    || activeModelPerEngine[youSttProvider]
    || DEFAULT_MODEL_PER_ENGINE[youSttProvider]
    || (youSttProvider === "whisper_cpp" ? activeWhisperModel : undefined);
  const youStt = formatSttLabel(youSttProvider, youLocalModel || undefined);
  const youActive = isRecording && !mutedYou && micLevel > 0.02;

  const themSttProvider = meetingAudioConfig?.them.stt_provider ?? "—";
  const themLocalModel = meetingAudioConfig?.them.local_model_id
    || activeModelPerEngine[themSttProvider]
    || DEFAULT_MODEL_PER_ENGINE[themSttProvider]
    || (themSttProvider === "whisper_cpp" ? activeWhisperModel : undefined);
  const themStt = formatSttLabel(themSttProvider, themLocalModel || undefined);
  const themActive = isRecording && !mutedThem && systemLevel > 0.02;

  // ── Provider change handler ──
  // Updates meetingAudioConfig; useAudioConfigSync automatically restarts capture.
  const handleProviderChange = useCallback((party: "you" | "them", provider: STTProviderType) => {
    if (!meetingAudioConfig) return;
    const updates: Partial<typeof meetingAudioConfig.you> = { stt_provider: provider };
    if (provider === "faster_whisper" || provider === "sherpa_onnx" || provider === "ort_streaming" || provider === "parakeet_tdt") {
      const activeModelPerEngine = useConfigStore.getState().activeModelPerEngine;
      const engineModel = activeModelPerEngine[provider]
        ?? DEFAULT_MODEL_PER_ENGINE[provider]
        ?? useConfigStore.getState().activeWhisperModel;
      if (engineModel) updates.local_model_id = engineModel;
    }
    setMeetingAudioConfig({
      ...meetingAudioConfig,
      [party]: { ...meetingAudioConfig[party], ...updates },
      preset_name: null,
    });
    setPickerOpen(null);
  }, [meetingAudioConfig, setMeetingAudioConfig]);

  return (
    <div className={`flex flex-wrap items-center gap-2.5 ${compact ? "px-3 py-2" : "px-5 py-2.5"}`}>
      {/* LLM — always interactive */}
      <div className="relative min-w-0 max-w-full" ref={llmAnchor}>
        {llmProvider === "claude_cli" ? (
          <AgentStatusChip
            compact={compact}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
          />
        ) : (
          <STTChip
            icon={<Brain className="h-3.5 w-3.5" />}
            provider={llmProviderLabel}
            model={llmModelLabel}
            active={isStreaming}
            color="blue"
            label=""
            muted={false}
            interactive={true}
            pickerOpen={pickerOpen === "llm"}
            onClick={() => setPickerOpen(pickerOpen === "llm" ? null : "llm")}
            tooltip={`LLM: ${llmProviderLabel} / ${llmModelLabel}`}
          />
        )}
        {pickerOpen === "llm" && (
          <LLMPickerDropdown
            currentProvider={llmProvider}
            currentModel={llmModel}
            anchor={llmAnchor.current}
            onApply={async (provider, model) => {
              try {
                await activateLLMProvider(provider as LLMProviderType, { model });
              } catch (e) {
                console.warn("[ServiceStatusBar] Failed to switch LLM:", e);
                showToast(`Не удалось переключить модель: ${e instanceof Error ? e.message : String(e)}`, "error");
                throw e;
              }
              setPickerOpen(null);
            }}
            onClose={() => setPickerOpen(null)}
          />
        )}
      </div>

      <Divider />

      {audioMode === "in_person" ? (
        /* In-Person mode: single Room STT indicator + speaker count */
        <div className="flex items-center gap-2">
          <div className="relative">
            <STTChip
              icon={<Mic className="h-3.5 w-3.5" />}
              provider={themStt.provider}
              model={themStt.model}
              active={themActive || youActive}
              color="purple"
              label="ОЧНО"
              muted={mutedThem}
              interactive={isRecording}
              pickerOpen={pickerOpen === "them"}
              onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
              tooltip={`Речь в помещении: ${themStt.provider}${themStt.model ? ` / ${themStt.model}` : ""}`}
            />
            {pickerOpen === "them" && (
              <STTPickerDropdown
                currentProvider={themSttProvider as STTProviderType}
                isInput={meetingAudioConfig?.them.is_input_device ?? false}
                onSelect={(p) => handleProviderChange("them", p)}
                onClose={() => setPickerOpen(null)}
                otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
                otherPartyLabel="Вы"
              />
            )}
          </div>
          <span className="text-xs text-muted-foreground/60">
            {speakerOrder.length > 0
              ? `Участников: ${speakerOrder.length}`
              : ""}
          </span>
        </div>
      ) : (
        <>
          {/* Online mode: You STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Mic className="h-3.5 w-3.5" />}
                provider={youStt.provider}
                model={youStt.model}
                active={youActive}
                color="sky"
                label="Вы"
                muted={mutedYou}
                interactive={isRecording}
                pickerOpen={pickerOpen === "you"}
                onClick={() => setPickerOpen(pickerOpen === "you" ? null : "you")}
                tooltip={`Ваша речь: ${youStt.provider}${youStt.model ? ` / ${youStt.model}` : ""}`}
              />
              {pickerOpen === "you" && (
                <STTPickerDropdown
                  currentProvider={youSttProvider as STTProviderType}
                  isInput={meetingAudioConfig?.you.is_input_device ?? true}
                  onSelect={(p) => handleProviderChange("you", p)}
                  onClose={() => setPickerOpen(null)}
                  otherPartyProvider={meetingAudioConfig?.them.stt_provider ?? null}
                  otherPartyLabel="Собеседники"
                />
              )}
            </div>
            {isRecording && (
              <MuteButton type="mic" muted={mutedYou} onToggle={toggleMuteYou} label="Вы" />
            )}
          </div>

          <Divider />

          {/* Online mode: Them STT — interactive during recording */}
          <div className="flex items-center gap-1">
            <div className="relative">
              <STTChip
                icon={<Volume2 className="h-3.5 w-3.5" />}
                provider={themStt.provider}
                model={themStt.model}
                active={themActive}
                color="amber"
                label="Собеседники"
                muted={mutedThem}
                interactive={isRecording}
                pickerOpen={pickerOpen === "them"}
                onClick={() => setPickerOpen(pickerOpen === "them" ? null : "them")}
                tooltip={`Речь собеседников: ${themStt.provider}${themStt.model ? ` / ${themStt.model}` : ""}`}
          />
          {pickerOpen === "them" && (
            <STTPickerDropdown
              currentProvider={themSttProvider as STTProviderType}
              isInput={meetingAudioConfig?.them.is_input_device ?? false}
              onSelect={(p) => handleProviderChange("them", p)}
              onClose={() => setPickerOpen(null)}
              otherPartyProvider={meetingAudioConfig?.you.stt_provider ?? null}
              otherPartyLabel="Вы"
            />
          )}
            </div>
            {isRecording && (
              <MuteButton type="speaker" muted={mutedThem} onToggle={toggleMuteThem} label="Собеседники" />
            )}
          </div>
        </>
      )}

      {/* Latency: live timer while an answer streams, then the last answer's time */}
      <StreamLatency divider={<Divider />} />

      {/* Update ready — launcher footer only (the updater runs in the launcher) */}
      {!compact && <UpdatePill />}
    </div>
  );
}

// ── Update Pill ────────────────────────────────────────────────────

function UpdatePill() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const [installing, setInstalling] = useState(false);

  if (phase !== "ready" || !version) return null;

  const handleClick = async () => {
    setInstalling(true);
    try {
      await restartToUpdate();
    } finally {
      // Only reached if the user cancelled or the install failed.
      setInstalling(false);
    }
  };

  return (
    <>
      <Divider />
      <button
        onClick={handleClick}
        disabled={installing}
        title={`Перезапустить NexQ для установки v${version}`}
        className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
      >
        <ArrowUpCircle className="h-3 w-3" />
        <span>Обновление готово · v{version}</span>
        <span className="text-primary/50">—</span>
        <span className="font-semibold">{installing ? "Перезапуск…" : "Перезапустить"}</span>
      </button>
    </>
  );
}

// ── Color Map ──────────────────────────────────────────────────────

const COLOR_MAP = {
  blue: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  sky: {
    active: "text-info",
    dot: "bg-info",
    bg: "bg-info/10",
    border: "border-info/20",
    glow: "shadow-info/20",
  },
  amber: {
    active: "text-warning",
    dot: "bg-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
    glow: "shadow-warning/20",
  },
  purple: {
    active: "text-purple-400",
    dot: "bg-purple-400",
    bg: "bg-purple-400/10",
    border: "border-purple-400/20",
    glow: "shadow-purple-400/20",
  },
} as const;

// ── Service Chip (display-only, used for LLM) ──────────────────────

function ServiceChip({
  icon,
  provider,
  model,
  active,
  color,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        active
          ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
          : "bg-secondary/30 border border-transparent"
      }`}
      title={tooltip}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${active ? c.active : "text-muted-foreground/60"}`}>
        {icon}
      </span>

      {/* Text */}
      <div className="flex items-center gap-1 min-w-0">
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && (
          <span className={`text-meta truncate max-w-[70px] transition-colors duration-200 ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>
    </div>
  );
}

// ── STT Chip (interactive during recording) ─────────────────────────

function STTChip({
  icon,
  provider,
  model,
  active,
  color,
  label,
  muted,
  interactive,
  pickerOpen,
  onClick,
  tooltip,
}: {
  icon: React.ReactNode;
  provider: string;
  model: string;
  active: boolean;
  color: keyof typeof COLOR_MAP;
  label: string;
  muted: boolean;
  interactive: boolean;
  pickerOpen: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  const c = COLOR_MAP[color];

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all duration-200 ${
        muted
          ? "bg-destructive/5 border border-destructive/10"
          : active
            ? `${c.bg} border ${c.border} shadow-sm ${c.glow}`
            : "bg-secondary/30 border border-transparent"
      } ${interactive ? "cursor-pointer hover:brightness-110" : ""}`}
      title={tooltip}
      onClick={interactive ? onClick : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? pickerOpen : undefined}
      aria-label={interactive ? tooltip : undefined}
      onKeyDown={interactive ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}
    >
      {/* Status dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {active && !muted && (
          <span className={`absolute inline-flex h-full w-full animate-pulse rounded-full ${c.dot} opacity-40`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-200 ${
          muted ? "bg-destructive/50" : active ? c.dot : "bg-muted-foreground/30"
        }`} />
      </span>

      {/* Icon */}
      <span className={`shrink-0 transition-colors duration-200 ${
        muted ? "text-destructive/60" : active ? c.active : "text-muted-foreground/60"
      }`}>
        {icon}
      </span>

      {/* Text */}
      <div className={`flex min-w-0 items-center gap-1 ${!label ? "flex-wrap" : ""}`}>
        {label && (
          <span className={`shrink-0 text-meta font-semibold uppercase tracking-wide transition-colors duration-200 ${
            muted ? "text-destructive/50" : active ? c.active : "text-muted-foreground/60"
          }`}>
            {label}
          </span>
        )}
        <span className={`text-xs font-medium truncate max-w-[100px] transition-colors duration-200 ${
          muted ? "text-destructive/50 line-through" : active ? "text-foreground/90" : "text-muted-foreground/70"
        }`}>
          {provider}
        </span>
        {model && !muted && (
          <span className={`text-meta transition-colors duration-200 ${label ? "truncate max-w-[70px]" : "break-all text-foreground/80"} ${
            active ? "text-foreground/60" : "text-muted-foreground/60"
          }`}>
            {model}
          </span>
        )}
      </div>

      {/* Chevron — visible only when interactive */}
      {interactive && (
        <ChevronUp className={`h-2.5 w-2.5 shrink-0 transition-all duration-200 ${
          pickerOpen ? "text-foreground/60 rotate-0" : "text-muted-foreground/50 rotate-180"
        }`} />
      )}
    </div>
  );
}

// ── Mute Button ─────────────────────────────────────────────────────

function MuteButton({
  type,
  muted,
  onToggle,
  label,
}: {
  type: "mic" | "speaker";
  muted: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onToggle}
      className={`shrink-0 rounded-full p-1 transition-all duration-150 cursor-pointer ${
        muted
          ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "text-muted-foreground/60 hover:text-foreground/70 hover:bg-accent/40"
      }`}
      title={muted ? `Включить звук: ${label}` : `Выключить звук: ${label}`}
    >
      {type === "mic"
        ? (muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />)
        : (muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />)
      }
    </button>
  );
}

// ── STT Provider Picker Dropdown (opens upward from footer) ─────────

function STTPickerDropdown({
  currentProvider,
  isInput,
  onSelect,
  onClose,
  otherPartyProvider,
  otherPartyLabel,
}: {
  currentProvider: STTProviderType;
  isInput: boolean;
  onSelect: (provider: STTProviderType) => void;
  onClose: () => void;
  otherPartyProvider: STTProviderType | null;
  otherPartyLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const [localEngines, setLocalEngines] = useState<LocalSTTEngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [stealTarget, setStealTarget] = useState<STTProviderType | null>(null);

  // Load availability data on mount (lazy — only when dropdown opens)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloudProviders = ["deepgram", "whisper_api", "azure_speech", "groq_whisper"];
        const [engines, ...keyResults] = await Promise.all([
          listLocalSTTEngines(),
          ...cloudProviders.map(async (p) => {
            try { return { p, ok: await hasApiKey(p) }; }
            catch { return { p, ok: false }; }
          }),
        ]);
        if (cancelled) return;
        setLocalEngines(engines);
        const status: Record<string, boolean> = {};
        for (const k of keyResults) status[k.p] = k.ok;
        setApiKeyStatus(status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Click outside to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setStealTarget(null);
        onClose();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  function isLocalEngineReady(engineId: string): boolean {
    const eng = localEngines.find((e) => e.engine === engineId);
    if (!eng) return false;
    return eng.models.some((m) => !m.id.startsWith("binary-") && m.is_downloaded);
  }

  function isAvailable(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    if (opt.inputOnly && !isInput) return false;
    if (opt.requiresDownload) return isLocalEngineReady(opt.requiresDownload);
    // Assume available if key status hasn't loaded yet — prevents false fallbacks
    if (opt.requiresKey) return apiKeyStatus[opt.value] ?? true;
    return true;
  }

  function isExclusiveLocked(opt: (typeof STT_PROVIDER_OPTIONS)[0]): boolean {
    if (!isExclusiveProvider(opt.value)) return false;
    if (!otherPartyProvider) return false;
    return isExclusiveProvider(otherPartyProvider);
  }

  function findExclusiveFallback(): STTProviderType | null {
    for (const provider of EXCLUSIVE_FALLBACK_ORDER) {
      const opt = STT_PROVIDER_OPTIONS.find((o) => o.value === provider);
      if (opt && isAvailable(opt)) return provider;
    }
    return null;
  }

  function handleStealConfirm() {
    if (!stealTarget) return;
    const freshConfig = useConfigStore.getState().meetingAudioConfig;
    if (!freshConfig) return;

    const thisRole = freshConfig.you.stt_provider === otherPartyProvider ? "them" : "you";
    const otherRole = thisRole === "you" ? "them" : "you";
    const otherStillExclusive = isExclusiveProvider(freshConfig[otherRole].stt_provider);

    if (!otherStillExclusive) {
      onSelect(stealTarget);
      setStealTarget(null);
      onClose();
      return;
    }

    const fallback = findExclusiveFallback();
    if (!fallback) {
      showToast("Нет резервного распознавания речи. Добавьте API-ключ или скачайте локальную модель.", "error");
      setStealTarget(null);
      return;
    }

    const updatedConfig = { ...freshConfig };
    updatedConfig[thisRole] = {
      ...updatedConfig[thisRole],
      stt_provider: stealTarget,
      local_model_id: undefined,
    };
    updatedConfig[otherRole] = {
      ...updatedConfig[otherRole],
      stt_provider: fallback,
      local_model_id: undefined,
    };
    useConfigStore.getState().setMeetingAudioConfig(updatedConfig);

    const stealLabel = STT_PROVIDER_OPTIONS.find((o) => o.value === stealTarget)?.label ?? stealTarget;
    const fallbackLabel = STT_PROVIDER_OPTIONS.find((o) => o.value === fallback)?.label ?? fallback;
    showToast(
      `${stealLabel} включён для: ${thisRole === "you" ? "Вы" : "Собеседники"}. Для другой стороны выбран ${fallbackLabel}.`,
      "info"
    );

    setStealTarget(null);
    onClose();
  }

  const localOpts = STT_PROVIDER_OPTIONS.filter((o) => !o.isCloud && isAvailable(o));
  const cloudOpts = STT_PROVIDER_OPTIONS.filter((o) => o.isCloud && isAvailable(o));

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl border border-border/30 bg-popover/90 backdrop-blur-md shadow-2xl z-50 overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
    >
      {loading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Загрузка провайдеров…</div>
      ) : (
        <>
          {localOpts.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <HardDrive className="h-2.5 w-2.5 text-emerald-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Локальные и встроенные
                </span>
              </div>
              {localOpts.map((opt) => {
                const Icon = opt.IconComponent;
                const selected = currentProvider === opt.value;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onSelect(opt.value);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-emerald-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">Используется: {otherPartyLabel}</span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {cloudOpts.length > 0 && (
            <div className={localOpts.length > 0 ? "border-t border-border/20" : ""}>
              <div className="flex items-center gap-1.5 bg-muted/20 px-3 py-1.5 border-b border-border/20">
                <Cloud className="h-2.5 w-2.5 text-blue-400" />
                <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Облако
                </span>
              </div>
              {cloudOpts.map((opt) => {
                const Icon = opt.IconComponent;
                const selected = currentProvider === opt.value;
                const locked = isExclusiveLocked(opt);
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      if (locked) {
                        setStealTarget(opt.value);
                      } else {
                        onSelect(opt.value);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer ${
                      locked ? "opacity-50 hover:opacity-70" : ""
                    } ${
                      selected ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-accent/40"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-primary" : "text-blue-400"}`} />
                    <span className="flex-1 text-left font-medium">
                      {opt.label}
                      {locked && (
                        <span className="block text-meta text-muted-foreground/50">Используется: {otherPartyLabel}</span>
                      )}
                    </span>
                    {selected && !locked && <CheckCircle className="h-3 w-3 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}

          {localOpts.length === 0 && cloudOpts.length === 0 && (
            <p className="px-4 py-3 text-meta text-muted-foreground/60">
              Нет провайдеров — добавьте их в настройках
            </p>
          )}

          {stealTarget && (
            <div className="border-t border-border/20 bg-amber-500/5 px-3 py-2.5">
              <p className="text-meta leading-relaxed text-amber-200/80 mb-2">
                <span className="font-semibold text-amber-400">
                  {STT_PROVIDER_OPTIONS.find((o) => o.value === stealTarget)?.label}
                </span>{" "}
                can only run on one source at a time. Switch to this party?
                The other party will fall back to{" "}
                <span className="font-medium">
                  {(() => {
                    const fb = findExclusiveFallback();
                    return fb ? (STT_PROVIDER_OPTIONS.find((o) => o.value === fb)?.label ?? fb) : "no available engine";
                  })()}
                </span>.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleStealConfirm}
                  className="rounded-lg bg-amber-500/20 border border-amber-500/30 px-3 py-1 text-meta font-semibold text-amber-400 hover:bg-amber-500/30 cursor-pointer"
                >
                  Переключить
                </button>
                <button
                  type="button"
                  onClick={() => setStealTarget(null)}
                  className="rounded-lg bg-muted/30 px-3 py-1 text-meta font-medium text-muted-foreground hover:bg-muted/50 cursor-pointer"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── LLM Provider + Model Picker (single interaction, opens upward) ───
// Shows verified providers, loads models inline when provider is picked.
// User selects provider → models load → user picks model → dropdown closes.

const EMBEDDING_PATTERNS = [
  "embed", "all-minilm", "nomic-embed", "bge-",
  "text-embedding", "snowflake-arctic", "jina-embedding",
];

export function LLMPickerDropdown({ currentProvider, currentModel, anchor, onApply, onClose }: {
  currentProvider: string;
  currentModel: string;
  anchor: HTMLElement | null;
  onApply: (provider: string, model: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const verifiedProviders = useConfigStore((s) => s.verifiedCloudProviders);
  const rememberedModels = useConfigStore((s) => s.lastModelByProvider);
  const customBaseUrl = useConfigStore((s) => s.customLlmBaseUrl);
  const claudeCliConfig = useConfigStore((s) => s.claudeCliConfig);
  const claudeModels = useConfigStore((s) => s.claudeModels) ?? undefined;
  const claudeStatus = useAgentStore((s) => s.status);
  const refreshClaudeStatus = useAgentStore((s) => s.refreshStatus);
  const [pendingProvider, setPendingProvider] = useState(currentProvider);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [modelId, setModelId] = useState(currentModel || rememberedModels[currentProvider] || "");
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({ left: 12, bottom: 12, width: 340, maxHeight: 440 });

  // The overlay footer is inside several overflow/transform containers. A
  // viewport-bound portal keeps the picker visible and clickable in either pane.
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const width = Math.min(380, Math.max(220, window.innerWidth - 24));
      const left = Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - width - 12));
      const top = rect?.top ?? window.innerHeight - 12;
      if (top >= 180) setPosition({ left, bottom: window.innerHeight - top + 8, width, maxHeight: Math.min(480, top - 16) });
      else setPosition({ left, top: (rect?.bottom ?? 12) + 8, width, maxHeight: Math.max(140, window.innerHeight - (rect?.bottom ?? 12) - 20) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);

  useEffect(() => {
    if (!useAgentStore.getState().status) refreshClaudeStatus();
    let cancelled = false;
    Promise.all(LLM_PROVIDER_OPTIONS.filter((p) => p.requiresKey).map(async (p) => [p.value, await hasApiKey(p.value).catch(() => false)] as const))
      .then((entries) => { if (!cancelled) setKeys(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [refreshClaudeStatus]);
  const claudeAvailable = currentProvider === "claude_cli" || !!claudeStatus?.auth?.logged_in;

  useEffect(() => {
    let cancelled = false;
    setError("");
    setModels([]);
    setModelId(pendingProvider === currentProvider ? currentModel : rememberedModels[pendingProvider] || "");
    if (pendingProvider === "claude_cli") { setModelsLoading(false); return; }
    setModelsLoading(true);
    (async () => {
      try {
        const { listModels } = await import("../lib/ipc");
        const list = await listModels(await storedProviderConfig(pendingProvider as LLMProviderType));
        if (cancelled) return;
        setModels(list.filter((m) => !EMBEDDING_PATTERNS.some((p) => m.id.toLowerCase().includes(p))).map((m) => ({ id: m.id, name: m.name || m.id })));
      } catch {
        if (!cancelled) setError("Не удалось получить список. Введите точный ID модели вручную или повторите загрузку.");
      } finally { if (!cancelled) setModelsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [pendingProvider, retry]); // Stored IDs remain available even when listing is unavailable.

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [anchor, onClose]);

  const apply = async (model: string) => {
    if (!model.trim() || applying) return;
    setApplying(true); setError("");
    try { await onApply(pendingProvider, model.trim()); }
    catch { setError("Не удалось применить модель. Проверьте настройки подключения и попробуйте снова."); }
    finally { setApplying(false); }
  };
  const available = LLM_PROVIDER_OPTIONS.filter((p) => p.value === currentProvider || p.isLocal ||
    (p.value === "custom" ? !!customBaseUrl : keys[p.value] || verifiedProviders.includes(p.value)));

  return createPortal(
    <div ref={ref} role="dialog" aria-label="Выбор провайдера и модели" style={position}
      className="fixed z-[100] flex flex-col overflow-y-auto rounded-xl border border-border bg-popover p-3 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Провайдер и модель ИИ</h3>
        <button type="button" onClick={onClose} aria-label="Закрыть выбор модели" className="rounded px-2 py-1 text-xs hover:bg-accent">Закрыть</button>
      </div>
      <p className="mb-3 break-all text-xs text-muted-foreground">Сейчас: {LLM_LABELS[currentProvider] || currentProvider} / {currentModel || "Модель не выбрана"}</p>
      <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Доступные провайдеры">
        {available.map((provider) => <button type="button" key={provider.value} disabled={applying}
          aria-pressed={pendingProvider === provider.value} onClick={() => setPendingProvider(provider.value)}
          className={`rounded-lg border px-2.5 py-1.5 text-xs ${pendingProvider === provider.value ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          {provider.label}
        </button>)}
        {claudeAvailable && <button type="button" disabled={applying} aria-pressed={pendingProvider === "claude_cli"}
          onClick={() => setPendingProvider("claude_cli")} className="rounded-lg border border-border px-2.5 py-1.5 text-xs">Claude</button>}
      </div>
      {pendingProvider === "claude_cli" ? <button type="button" disabled={applying} onClick={() => apply(claudeCliConfig.fast_model)}
        className="rounded-lg border border-primary/30 p-3 text-left text-xs">
        Использовать Claude<br />
        Быстро: {claudeTierLabel(claudeCliConfig.fast_model, claudeCliConfig.fast_effort, claudeModels)}<br />
        Глубоко: {claudeTierLabel(claudeCliConfig.deep_model, claudeCliConfig.deep_effort, claudeModels)}
      </button> : <>
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <span>Модели {LLM_LABELS[pendingProvider] || pendingProvider}</span>
          <button type="button" disabled={modelsLoading || applying} onClick={() => setRetry((n) => n + 1)} className="rounded px-2 py-1 hover:bg-accent">
            {modelsLoading ? "Загрузка…" : "Обновить список"}
          </button>
        </div>
        {models.length > 0 && <div className="mb-3 max-h-44 shrink-0 overflow-y-auto rounded-lg border border-border">
          {models.map((model) => <button type="button" key={model.id} title={model.id} disabled={applying}
            onClick={() => apply(model.id)} className={`block w-full break-all px-3 py-2 text-left text-xs hover:bg-accent ${model.id === currentModel && pendingProvider === currentProvider ? "text-primary" : ""}`}>
            {model.name} {model.id === currentModel && pendingProvider === currentProvider ? "✓" : ""}
          </button>)}
        </div>}
        {!modelsLoading && models.length === 0 && !error && <p className="mb-2 text-xs text-muted-foreground">Список пуст. Можно указать ID модели вручную.</p>}
        <form onSubmit={(event) => { event.preventDefault(); void apply(modelId); }} className="space-y-2">
          <label className="block text-xs font-medium" htmlFor="quick-llm-model">Идентификатор модели</label>
          <input id="quick-llm-model" value={modelId} disabled={applying} onChange={(event) => setModelId(event.target.value)}
            placeholder="Точный ID модели" autoComplete="off" spellCheck={false}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={!modelId.trim() || applying} className="w-full rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {applying ? "Подключение…" : "Применить модель"}
          </button>
        </form>
      </>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      <button type="button" onClick={() => { useMeetingStore.getState().openSettings("llm"); onClose(); }}
        className="mt-3 rounded-lg border border-border px-3 py-2 text-xs hover:bg-accent">API-ключи и настройки сервисов</button>
    </div>, document.body,
  );
}

// ── Divider ─────────────────────────────────────────────────────────

function Divider() {
  return <div className="h-4 w-px shrink-0 bg-border/20" />;
}
