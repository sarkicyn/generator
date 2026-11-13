import { useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { getFasterWhisperStatus } from "../lib/ipc";
import type { FasterWhisperConfig } from "../lib/types";

export function FasterWhisperSettings() {
  const config = useConfigStore((state) => state.fasterWhisperConfig);
  const setConfig = useConfigStore((state) => state.setFasterWhisperConfig);
  const model = useConfigStore((state) => state.activeModelPerEngine.faster_whisper ?? "voxta/faster-whisper-large-v3-turbo-int8");
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("");
  const update = (changes: Partial<FasterWhisperConfig>) => { setConfig({ ...config, ...changes }); setStatus(""); };
  const check = async () => {
    setChecking(true); setStatus("");
    try {
      const value = await getFasterWhisperStatus(model);
      setStatus(`Готово: ${value.device === "cuda" ? "видеокарта NVIDIA" : "процессор CPU"}, ${value.compute_type}.` +
        (value.warning ? " Использован совместимый резервный режим." : "") +
        (value.device === "cpu" ? " На CPU обработка может отставать от речи; для меньшей задержки выберите «Быстро»." : ""));
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setChecking(false); }
  };
  const selectClass = "w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm";
  return <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-5">
    <h3 className="text-sm font-semibold text-primary/80">Faster Whisper — локальное распознавание</h3>
    <p className="text-xs text-muted-foreground">Звук обрабатывается на компьютере. Модель сохраняется после скачивания; API-ключ не требуется.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs">Язык речи
        <select aria-label="Язык Faster Whisper" className={selectClass} value={config.language} onChange={(e) => update({ language: e.target.value as FasterWhisperConfig["language"] })}>
          <option value="auto">Определять автоматически</option><option value="ru">Русский</option><option value="en">Английский</option>
        </select>
      </label>
      <label className="space-y-1 text-xs">Обработка звука
        <select aria-label="Устройство Faster Whisper" className={selectClass} value={config.device} onChange={(e) => update({ device: e.target.value as FasterWhisperConfig["device"] })}>
          <option value="auto">Автоматически — GPU или CPU</option><option value="cuda">Видеокарта NVIDIA (CUDA)</option><option value="cpu">Процессор (CPU)</option>
        </select>
      </label>
      <label className="space-y-1 text-xs">Качество и скорость
        <select aria-label="Качество Faster Whisper" className={selectClass} value={config.quality} onChange={(e) => update({ quality: e.target.value as FasterWhisperConfig["quality"] })}>
          <option value="fast">Быстро</option><option value="balanced">Сбалансированно</option><option value="accurate">Точнее</option>
        </select>
      </label>
      <label className="space-y-1 text-xs">Формат вычислений
        <select aria-label="Формат Faster Whisper" className={selectClass} value={config.computeType} onChange={(e) => update({ computeType: e.target.value as FasterWhisperConfig["computeType"] })}>
          <option value="auto">Автоматически (рекомендуется)</option><option value="int8">INT8</option><option value="int8_float16">INT8 + FP16</option><option value="float16">FP16</option><option value="float32">FP32</option>
        </select>
      </label>
    </div>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.vadFilter} onChange={(e) => update({ vadFilter: e.target.checked })} />Фильтровать паузы и шум с помощью Silero VAD</label>
    <label className="block space-y-1 text-xs">Термины и названия
      <textarea aria-label="Термины Faster Whisper" className={selectClass} rows={2} maxLength={2000} value={config.hotwords} placeholder="Large Object Heap, .NET, API" onChange={(e) => update({ hotwords: e.target.value })} />
    </label>
    <p className="text-xs text-muted-foreground">Промежуточный текст уточняется после паузы. При необходимости движок подбирает совместимый формат или резервный режим CPU.</p>
    <button type="button" onClick={check} disabled={checking} className="rounded-lg border border-border/50 px-3 py-2 text-xs hover:bg-accent disabled:opacity-50">{checking ? "Загружаем и проверяем модель…" : "Проверить движок и устройство"}</button>
    {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
  </div>;
}
