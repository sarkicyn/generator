import { LLMSettings } from "../../settings/LLMSettings";
import { Brain, Server } from "lucide-react";

interface LLMSetupStepProps {
  ollamaRunning: boolean;
  ollamaModels: string[];
  lmStudioRunning: boolean;
  lmStudioModels: string[];
}

/** The wizard and Settings share the same secure provider/model configuration. */
export function LLMSetupStep({
  ollamaRunning,
  ollamaModels,
  lmStudioRunning,
  lmStudioModels,
}: LLMSetupStepProps) {
  const hasLocalLLM = ollamaRunning || lmStudioRunning;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Brain className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Подключение моделей ИИ</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Добавьте API-ключ своего сервиса или выберите локальную модель.
        </p>
      </div>
      {hasLocalLLM && (
        <div className="rounded-xl border border-success/20 bg-success/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <Server className="h-4 w-4" /> Локальный сервис обнаружен
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {ollamaRunning && `Ollama: моделей — ${ollamaModels.length}. `}
            {lmStudioRunning && `LM Studio: моделей — ${lmStudioModels.length}.`}
          </p>
        </div>
      )}
      <LLMSettings />
    </div>
  );
}
