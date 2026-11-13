import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAnswerEvaluationStore } from "../stores/answerEvaluationStore";
import type { EvaluationEvent } from "../lib/answerEvaluation";

export function useAnswerEvaluation() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<EvaluationEvent>("answer_evaluation", (event) => useAnswerEvaluationStore.getState().apply(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
