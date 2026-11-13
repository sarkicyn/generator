// Sub-PRD 3: Audio device selection, level meters

import { useEffect, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { useAudioLevel } from "../hooks/useAudioLevel";
import {
  listAudioDevices,
  startAudioTest,
  stopAudioTest,
} from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import type { AudioDeviceList } from "../lib/types";

export function AudioSettings() {
  const {
    micDeviceId,
    systemDeviceId,
    setMicDeviceId,
    setSystemDeviceId,
  } = useConfigStore();

  const { micLevel, systemLevel, micPeak, systemPeak } = useAudioLevel();

  const [devices, setDevices] = useState<AudioDeviceList>({
    inputs: [],
    outputs: [],
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [testingDevice, setTestingDevice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    deviceId: string;
    success: boolean;
  } | null>(null);

  // Load devices on mount
  useEffect(() => {
    loadDevices();
  }, []);

  async function loadDevices() {
    setLoadingDevices(true);
    try {
      const deviceList = await listAudioDevices();
      setDevices(deviceList);

      // Auto-select default devices if none selected
      if (!micDeviceId) {
        const defaultInput = deviceList.inputs.find((d) => d.is_default);
        if (defaultInput) {
          setMicDeviceId(defaultInput.id);
        }
      }
      if (!systemDeviceId) {
        const defaultOutput = deviceList.outputs.find((d) => d.is_default);
        if (defaultOutput) {
          setSystemDeviceId(defaultOutput.id);
        }
      }
    } catch (err) {
      console.error("Failed to load audio devices:", err);
      showToast("Не удалось обнаружить аудиоустройства. Проверьте подключение.", "error");
    } finally {
      setLoadingDevices(false);
    }
  }

  async function handleTestDevice(deviceId: string, isInput: boolean) {
    setTestingDevice(deviceId);
    setTestResult(null);
    try {
      // Start real audio capture test — this emits audio_level events
      await startAudioTest(deviceId, isInput);

      // Let it capture for 3 seconds so the user sees the level meter
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Stop test and get whether audio was detected
      const detected = await stopAudioTest();
      setTestResult({ deviceId, success: detected });
    } catch (err) {
      console.error("Audio test failed:", err);
      setTestResult({ deviceId, success: false });
    } finally {
      setTestingDevice(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Microphone Device */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Микрофон</label>
        <div className="flex gap-2">
          <select
            value={micDeviceId || ""}
            onChange={(e) => setMicDeviceId(e.target.value || null)}
            disabled={loadingDevices}
            aria-label="Микрофон"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">
              {loadingDevices ? "Поиск микрофонов…" : "Выберите микрофон"}
            </option>
            {devices.inputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.is_default ? " (по умолчанию)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => micDeviceId && handleTestDevice(micDeviceId, true)}
            disabled={!micDeviceId || testingDevice !== null}
            aria-label="Проверить микрофон"
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            {testingDevice === micDeviceId ? "Проверка…" : "Проверить"}
          </button>
        </div>

        {/* Mic Level Meter */}
        <AudioLevelMeter
          level={micLevel}
          peak={micPeak}
          label="Микрофон"
        />

        {testingDevice === micDeviceId && (
          <p className="text-xs text-info">
            Скажите что-нибудь в микрофон…
          </p>
        )}
        {testResult && testResult.deviceId === micDeviceId && !testingDevice && (
          <p
            className={`text-xs ${testResult.success ? "text-success" : "text-warning"}`}
          >
            {testResult.success
              ? "Звук обнаружен — устройство работает"
              : "Звук не обнаружен. Говорите громче или проверьте микрофон."}
          </p>
        )}
      </div>

      {/* System Audio Device */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Системный звук (выход)</label>
        <div className="flex gap-2">
          <select
            value={systemDeviceId || ""}
            onChange={(e) => setSystemDeviceId(e.target.value || null)}
            disabled={loadingDevices}
            aria-label="Устройство системного звука"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">
              {loadingDevices ? "Поиск устройств вывода…" : "Выберите устройство вывода"}
            </option>
            {devices.outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.is_default ? " (по умолчанию)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              systemDeviceId && handleTestDevice(systemDeviceId, false)
            }
            disabled={!systemDeviceId || testingDevice !== null}
            aria-label="Проверить системный звук"
            className="rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            {testingDevice === systemDeviceId ? "Проверка…" : "Проверить"}
          </button>
        </div>

        {/* System Level Meter */}
        <AudioLevelMeter
          level={systemLevel}
          peak={systemPeak}
          label="Система"
        />

        {testingDevice === systemDeviceId && (
          <p className="text-xs text-info">
            Включите звук на компьютере…
          </p>
        )}
        {testResult && testResult.deviceId === systemDeviceId && !testingDevice && (
          <p
            className={`text-xs ${testResult.success ? "text-success" : "text-warning"}`}
          >
            {testResult.success
              ? "Звук обнаружен — устройство работает"
              : "Звук не обнаружен. Включите воспроизведение на компьютере."}
          </p>
        )}
      </div>

      {/* Refresh Devices */}
      <button
        onClick={loadDevices}
        disabled={loadingDevices}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {loadingDevices ? "Refreshing..." : "Обновить список устройств"}
      </button>
    </div>
  );
}

/**
 * Horizontal audio level meter with green/yellow/red zones.
 */
function AudioLevelMeter({
  level,
  peak,
  label,
}: {
  level: number;
  peak: number;
  label: string;
}) {
  const clampedLevel = Math.min(Math.max(level, 0), 1);
  const clampedPeak = Math.min(Math.max(peak, 0), 1);

  return (
    <div
      className="flex items-center gap-2"
      role="meter"
      aria-label={`${label} audio level`}
      aria-valuenow={Math.round(clampedLevel * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted/20">
        {/* Gradient level bar — color follows position (green → yellow → red) */}
        <div
          className="absolute inset-y-0 left-0 rounded-full audio-level-gradient audio-bar-spring"
          style={{ width: `${clampedLevel * 100}%` }}
        />
        {/* Peak indicator */}
        {clampedPeak > 0.01 && (
          <div
            className="absolute inset-y-0 w-[2px] rounded-full bg-foreground/40 transition-all duration-150"
            style={{ left: `${clampedPeak * 100}%` }}
          />
        )}
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
        {Math.round(clampedLevel * 100)}
      </span>
    </div>
  );
}
