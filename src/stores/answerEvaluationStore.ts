import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { evaluationTargets, type AnswerEvaluation, type EvaluationEvent } from "../lib/answerEvaluation";
import { useMeetingStore } from "./meetingStore";
import { useTranscriptStore } from "./transcriptStore";
import { showToast } from "./toastStore";

interface EvaluationState {
  requestId: string | null;
  localRequestId: string | null;
  status: "idle" | "running" | "done" | "error";
  completed: number; total: number;
  results: AnswerEvaluation[];
  error: string | null;
  run: () => Promise<void>;
  apply: (event: EvaluationEvent) => void;
  reset: () => void;
}
const empty = { requestId: null, localRequestId: null, status: "idle" as const, completed: 0, total: 0, results: [], error: null };

export const useAnswerEvaluationStore = create<EvaluationState>((set, get) => ({
  ...empty,
  reset: () => set(empty),
  apply: (event) => {
    if (useMeetingStore.getState().activeMeeting?.id !== event.meeting_id) return;
    if (event.status === "running") {
      if (get().localRequestId && get().localRequestId !== event.request_id) return;
      set({ ...empty, localRequestId: get().localRequestId, requestId: event.request_id, status: "running", total: event.total });
      return;
    }
    if (get().requestId !== event.request_id) return;
    set((state) => ({
      status: event.status === "item" ? "running" : event.status,
      completed: event.completed, total: event.total,
      results: event.result && !state.results.some((r) => r.id === event.result!.id) ? [...state.results, event.result] : state.results,
      error: event.error ?? null,
    }));
  },
  run: async () => {
    const meeting = useMeetingStore.getState().activeMeeting;
    if (!meeting) return;
    const transcript = useTranscriptStore.getState();
    const targets = evaluationTargets(transcript.segments, transcript.selectedSegmentIds);
    if (!targets.length) {
      showToast(transcript.selectedSegmentIds.length ? "В выбранных фрагментах нет законченного ответа с пометкой «Вы»." : "Дождитесь законченного блока вашей речи («Вы»).", "info");
      return;
    }
    if (targets.length > 20) { showToast("За один раз можно оценить до 20 ответов.", "info"); return; }
    const requestId = crypto.randomUUID();
    set({ ...empty, requestId, localRequestId: requestId, status: "running", total: targets.length });
    const segments = transcript.segments.filter((s) => s.is_final).sort((a, b) => a.timestamp_ms - b.timestamp_ms).map((s) => ({
      id: s.id, text: s.text, speaker: s.speaker, timestamp_ms: s.timestamp_ms, is_final: s.is_final,
    }));
    // Selection is local to the overlay. The global shortcut asks that window to run.
    useTranscriptStore.getState().clearSelection();
    try {
      await invoke("evaluate_answers", { meetingId: meeting.id, requestId, segments, targets });
    } catch (error) {
      if (get().requestId === requestId && useMeetingStore.getState().activeMeeting?.id === meeting.id) {
        set({ status: "error", error: typeof error === "string" ? error : "Не удалось оценить ответ. Повторите Ctrl+E." });
      }
    }
  },
}));
