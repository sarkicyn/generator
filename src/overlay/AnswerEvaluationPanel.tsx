import { useState, useEffect } from "react";
import { useAnswerEvaluationStore } from "../stores/answerEvaluationStore";

/** Separate, compact pane: it never changes the main chat's stream or selected response. */
export function AnswerEvaluationPanel() {
  const { status, results, error, completed, total, requestId } = useAnswerEvaluationStore();
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [requestId]);
  if (status === "idle") return null;
  const result = results[Math.min(index, Math.max(0, results.length - 1))];
  return (
    <section aria-label="Оценка моего ответа" className="shrink-0 max-h-[42vh] overflow-y-auto rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2 text-meta text-muted-foreground">
        <span>Мой ответ · {status === "running" ? `Оценка ${Math.min(completed + 1, total)}/${total}…` : `${completed}/${total}`}</span>
        {results.length > 1 && <div className="flex items-center gap-2">
          <button type="button" aria-label="Предыдущая оценка" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} className="disabled:opacity-30">←</button>
          <span>{index + 1}/{results.length}</span>
          <button type="button" aria-label="Следующая оценка" disabled={index >= results.length - 1} onClick={() => setIndex((i) => i + 1)} className="disabled:opacity-30">→</button>
        </div>}
      </div>
      {result && <div className="space-y-1 leading-relaxed">
        <p className="font-semibold text-primary">Оценка: {result.score == null ? "Недостаточно данных" : `${result.score}%`}</p>
        <p><span className="text-muted-foreground">Чего не хватает: </span>{result.missing}</p>
        <p><span className="text-muted-foreground">Улучшенный ответ: </span>{result.improved || "—"}</p>
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </section>
  );
}
