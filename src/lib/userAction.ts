// A user-invoked AI action (button, shortcut, Ask, detected question): the
// picked transcript scope is resolved and sent, the right panel shows
// "Sending…" at once, and a non-sticky scope goes back to the default.
// Background generations (summary, action items, bookmarks) call
// generateAssist directly and never carry a scope.

import { cancelGenerationAndWait, generateAssist } from "./ipc";
import { resolveScope, DEFAULT_CONTEXT_SCOPE } from "./contextScope";
import { getActionDisplayName, getModeLabel } from "./utils";
import type { GenerateAssistOptions, IntelligenceMode } from "./types";
import { latestAssistSegment } from "./latestAssist";
import { assistSegments } from "./assistSegments";
import { useConfigStore } from "../stores/configStore";
import { useStreamStore } from "../stores/streamStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";

/** The name the action row shows for `mode` ("F/U", a custom action's name...). */
export function actionLabel(mode: string): string {
  const actions = useAIActionsStore.getState().configs.actions;
  const cfg = actions[mode] ?? Object.values(actions).find((a) => a.mode === mode);
  return (cfg?.name && getActionDisplayName(cfg.mode, cfg.name)) || getModeLabel(mode as IntelligenceMode) || mode;
}

type ActionInput = Pick<GenerateAssistOptions, "transcriptSegments" | "scope" | "requestId" | "captureScreen">;
type LatestIntent = { mode: string; question?: string; input: ActionInput; meetingId: string | null };
type LatestJob = { id: string; settled: boolean; stopped?: boolean; stop?: Promise<void> };
let latestIntent: LatestIntent | null = null;
let latestWorker: Promise<void> | null = null;
let latestJob: LatestJob | null = null;
const pauseReplacement = () => new Promise<void>((resolve) => window.setTimeout(resolve, 20));

function stopLatestJob(job: LatestJob): void {
  if (job.stop) return;
  job.stop = (async () => {
    // A fast second press can precede native begin_generation. Retry the
    // request-owned cancellation until that invocation has really settled.
    while (!job.settled) {
      await cancelGenerationAndWait(job.id);
      if (!job.settled) await pauseReplacement();
    }
  })().catch((error) => {
    showToast(error instanceof Error ? error.message : "Не удалось остановить предыдущий ответ", "error");
  });
}

async function drainLatestAssist(): Promise<void> {
  // Let the caller install the worker before any completion path can clear it.
  await Promise.resolve();
  let busyRetries = 0;
  try {
    while (latestIntent) {
      if (latestIntent.meetingId !== (useMeetingStore.getState().activeMeeting?.id ?? null)) {
        latestIntent = null;
        continue;
      }
      // Native preparation/background jobs can own the model before this
      // window has seen a stream-start event, so do not rely on UI busy state.
      await cancelGenerationAndWait();
      // A newer Space may have arrived while cancellation was finishing.
      const intent = latestIntent;
      latestIntent = null;
      if (!intent) continue; // Stop may clear it while cancellation is pending.
      if (intent.meetingId !== (useMeetingStore.getState().activeMeeting?.id ?? null)) continue;
      const job: LatestJob = { id: intent.input.requestId ?? crypto.randomUUID(), settled: false };
      latestJob = job;
      let failure: unknown;
      let failed = false;
      try {
        await executeUserAction(intent.mode, intent.question, { ...intent.input, requestId: job.id });
        busyRetries = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.stopped) {
          // Explicit Stop must not revive a request through the busy retry.
        } else if (message.includes("Generation already in progress") && busyRetries++ < 5) {
          latestIntent ??= intent;
          await pauseReplacement();
        } else if (!latestIntent) {
          failure = error;
          failed = true;
        }
      } finally {
        job.settled = true;
        if (latestJob === job) latestJob = null;
        await job.stop;
      }
      // A new request can arrive while the old stop is finishing. It must not
      // be stranded behind an error that belongs to the superseded request.
      if (failed && !latestIntent) throw failure;
    }
  } finally {
    latestWorker = null;
  }
}

/** Space and the Assist button snapshot the same complete current paragraph. */
export async function runLatestAssist(): Promise<void> {
  const transcript = useTranscriptStore.getState().segments;
  const latest = latestAssistSegment(transcript);
  if (!latest) {
    showToast("Пока нет распознанного вопроса. Произнесите вопрос и дождитесь текста.", "info");
    return;
  }
  // The selected paragraph is the explicit request. Earlier final paragraphs
  // are reference context, subject to the configured transcript window.
  const currentIds = new Set(latest.originalIds ?? [latest.id]);
  const segments = assistSegments(transcript.filter((segment) => segment.is_final && !currentIds.has(segment.id)), false, Object.values(useSpeakerStore.getState().speakers));
  await queueUserAction("Assist", latest.text, { transcriptSegments: segments });
}

/** Ctrl+S snapshots the checked fragments as one explicit request, in transcript order. */
export async function runMergedAssist(): Promise<void> {
  if (!useMeetingStore.getState().activeMeeting) return;
  const { segments: transcript, selectedSegmentIds } = useTranscriptStore.getState();
  const selected = new Set(selectedSegmentIds);
  const fragments = transcript
    .filter((segment) => selected.has(segment.id))
    .map((segment) => ({ ...segment, text: (segment.pending_text ?? segment.text).trim() }))
    .filter((segment) => segment.text);
  if (!fragments.length) {
    showToast("Отметьте фрагменты галочками слева и нажмите Ctrl+S.", "info");
    return;
  }
  const ids = new Set(fragments.map((segment) => segment.id));
  const background = assistSegments(transcript.filter((segment) => segment.is_final && !ids.has(segment.id)), false, Object.values(useSpeakerStore.getState().speakers));
  const request = queueUserAction("Assist", fragments.map((segment) => segment.text).join(" "), { transcriptSegments: background });
  useTranscriptStore.getState().clearSelection();
  await request;
}

async function queueUserAction(mode: string, question: string | undefined, input: ActionInput): Promise<void> {
  latestIntent = {
    mode, question,
    meetingId: useMeetingStore.getState().activeMeeting?.id ?? null,
    input,
  };
  if (latestJob) stopLatestJob(latestJob);
  latestWorker ??= drainLatestAssist();
  await latestWorker;
}

export async function runUserAction(mode: string, customQuestion?: string, input: ActionInput = {}): Promise<void> {
  if (mode === "Assist" && customQuestion === undefined) return runLatestAssist();
  return queueUserAction(mode, customQuestion, input);
}

/** A manual screen question shares normal chat cancellation/history and the live topic. */
export async function runScreenAssist(): Promise<void> {
  if (!useMeetingStore.getState().activeMeeting) return;
  await queueUserAction("AskQuestion", "Посмотри на приложенный снимок экрана. Найди основной видимый вопрос, задачу, код или ошибку и дай ответ или решение. Если задач несколько — ответь по порядку. Ответь по-русски, кратко и по делу. Если задание не видно или текст неразборчив, сообщи об этом.", { captureScreen: true });
}

/** Stop the current answer and discard a replacement that has not started. */
export async function stopUserActions(): Promise<void> {
  latestIntent = null;
  const job = latestJob;
  if (job) {
    job.stopped = true;
    stopLatestJob(job);
  }
  await cancelGenerationAndWait(job?.id);
}

async function executeUserAction(mode: string, customQuestion?: string, input: ActionInput = {}): Promise<void> {
  const config = useConfigStore.getState();
  const setting = config.contextScope ?? DEFAULT_CONTEXT_SCOPE;
  const stream = useStreamStore.getState();
  const scope = input.scope !== undefined ? input.scope : resolveScope(setting, mode, actionLabel(mode), stream.lastUserRequest, Date.now());
  const requestId = input.requestId ?? crypto.randomUUID();
  // Another action is already on its way: the backend will refuse this one.
  const busy = stream.isStreaming || stream.phase === "sending";

  stream.setPending(mode, requestId);
  // A one-off scope is used up by this action (not by a click the running
  // stream will refuse).
  if (input.scope === undefined && !config.contextScopeSticky && setting.kind !== "default" && !busy) {
    config.setContextScope({ ...setting, kind: "default" });
  }

  try {
    await generateAssist(mode, customQuestion, { ...input, requestId, scope });
  } finally {
    // A cancellation can finish successfully before stream_start (for example
    // while context is prepared). No stream event consumes that pending id.
    // Once a stream did start, clearPending is a no-op and leaves it alone.
    useStreamStore.getState().clearPending(requestId);
  }
}
