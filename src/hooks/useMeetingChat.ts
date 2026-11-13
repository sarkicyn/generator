import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { askMeeting, cancelGeneration, getAgentSessions, listMeetingChat } from "../lib/ipc";
import {
  onAgentSessionStatus,
  onStreamEnd,
  onStreamError,
  onStreamStart,
  onStreamToken,
} from "../lib/events";
import type { AgentSessionStatus, MeetingChatMessage } from "../lib/types";

/**
 * - `saved`: loaded from the database
 * - `pending`: a question waiting for its answer
 * - `streaming`: an answer arriving
 * - `done`: a question sent / an answer finished in this view (the backend saved it)
 * - `stopped`: stopped by the user (not saved)
 * - `error`: failed (not saved)
 */
export type ChatItemStatus = "saved" | "pending" | "streaming" | "done" | "stopped" | "error";

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatItemStatus;
  /** Why the request failed, or why a finished answer was not saved. */
  error?: string;
  model?: string | null;
  provider?: string | null;
  createdAt: number;
}

export interface MeetingChatState {
  items: ChatItem[];
  loading: boolean;
  /** The saved chat could not be loaded. */
  loadError: string | null;
  isAsking: boolean;
  /** This meeting's Claude session (Claude CLI only; null when unknown). */
  session: AgentSessionStatus | null;
  ask: (question: string) => Promise<void>;
  stop: () => void;
}

interface Options {
  /** Load and ask through the backend (off in demo mode). */
  enabled?: boolean;
  /** Follow this meeting's Claude session status. */
  trackSession?: boolean;
}

interface ChatRequest {
  id: string;
  meetingId: string;
  generation: number;
  sent: boolean;
  disposed: boolean;
  finished: boolean;
  unlisteners: UnlistenFn[];
  finish: (status: ChatItemStatus, error?: string) => void;
}

function fromSaved(message: MeetingChatMessage): ChatItem {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: "saved",
    model: message.model,
    createdAt: message.created_at,
  };
}

/** Answered question/answer pairs, oldest first (for the AI Log). */
export function answeredExchanges(items: ChatItem[]): { question: ChatItem; answer: ChatItem }[] {
  const out: { question: ChatItem; answer: ChatItem }[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    const [question, answer] = [items[i], items[i + 1]];
    if (
      question.role === "user" &&
      answer.role === "assistant" &&
      (answer.status === "saved" || answer.status === "done")
    ) {
      out.push({ question, answer });
    }
  }
  return out;
}

/**
 * "Ask this meeting": the meeting's saved chat plus questions asked in this
 * view. Answers stream through the request-scoped `llm_stream_*` events (the
 * listeners are subscribed before the request starts).
 */
export function useMeetingChat(meetingId: string, { enabled = true, trackSession = false }: Options = {}): MeetingChatState {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [session, setSession] = useState<AgentSessionStatus | null>(null);
  const requestRef = useRef<ChatRequest | null>(null);
  const generationRef = useRef(0);
  const viewRef = useRef({ meetingId, enabled });
  viewRef.current = { meetingId, enabled };

  const dropListeners = useCallback((request: ChatRequest) => {
    request.unlisteners.splice(0).forEach((unlisten) => unlisten());
  }, []);

  // A view change owns its own lifecycle. A late cleanup only cancels its
  // request id, never a new question from a different meeting/window.
  useEffect(() => {
    const generation = ++generationRef.current;
    setIsAsking(false);
    return () => {
      const request = requestRef.current;
      if (!request || request.generation !== generation) return;
      request.disposed = true;
      requestRef.current = null;
      dropListeners(request);
      if (request.sent && !request.finished) cancelGeneration(request.id).catch(() => {});
    };
  }, [meetingId, enabled, dropListeners]);

  // Saved chat of this meeting.
  useEffect(() => {
    setItems([]);
    setLoadError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    listMeetingChat(meetingId)
      .then((saved) => {
        if (!alive) return;
        // Questions asked while the history loaded stay after it.
        setItems((local) => [...saved.map(fromSaved), ...local]);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [meetingId, enabled]);

  // This meeting's Claude session: current snapshot, then live updates.
  useEffect(() => {
    setSession(null);
    if (!enabled || !trackSession) return;
    let alive = true;
    const ours = (s: AgentSessionStatus) => s.scope === "past" && s.meeting_id === meetingId;
    const unlisten = onAgentSessionStatus((status) => {
      if (alive && ours(status)) setSession(status);
    });
    getAgentSessions()
      .then((all) => {
        const current = all.find(ours);
        // A status event that arrived meanwhile is newer than the snapshot.
        if (alive && current) setSession((prev) => prev ?? current);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten.then((fn) => fn());
    };
  }, [meetingId, enabled, trackSession]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || !enabled || viewRef.current.meetingId !== meetingId || requestRef.current) return;
      setIsAsking(true);

      const requestId = crypto.randomUUID();
      const questionId = `local-q-${requestId}`;
      const answerId = `local-a-${requestId}`;
      const now = Date.now();
      const request: ChatRequest = {
        id: requestId,
        meetingId,
        generation: generationRef.current,
        sent: false,
        disposed: false,
        finished: false,
        unlisteners: [],
        finish: () => {},
      };
      requestRef.current = request;
      setItems((prev) => [
        ...prev,
        { id: questionId, role: "user", content: question, status: "pending", createdAt: now },
        { id: answerId, role: "assistant", content: "", status: "streaming", createdAt: now },
      ]);

      let answer = "";
      const sameView = () => !request.disposed && request.generation === generationRef.current && viewRef.current.meetingId === meetingId && viewRef.current.enabled;
      const update = (id: string, patch: Partial<ChatItem>) =>
        sameView() && setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      const release = () => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        if (sameView()) setIsAsking(false);
      };
      const finish = (status: ChatItemStatus, error?: string) => {
        if (request.finished || !sameView()) return;
        request.finished = true;
        dropListeners(request);
        update(questionId, { status: "done" });
        update(answerId, { status, content: answer, ...(error ? { error } : {}) });
        // Keep the guard until the native invocation (including saving) exits.
        if (!request.sent) release();
      };
      request.finish = finish;
      const active = () => sameView() && requestRef.current === request && !request.finished;
      const ours = (id: string | null) => active() && id === requestId;
      const subscribe = async (register: () => Promise<UnlistenFn>) => {
        const unlisten = await register();
        if (!active()) {
          unlisten();
          return false;
        }
        request.unlisteners.push(unlisten);
        return true;
      };

      try {
        // Subscribe before the request starts so no token is missed.
        if (!await subscribe(() => onStreamStart((event) => {
            if (ours(event.request_id)) update(answerId, { model: event.model, provider: event.provider });
          }))) return;
        if (!await subscribe(() => onStreamToken((event) => {
            if (!ours(event.request_id)) return;
            answer += event.token;
            update(answerId, { content: answer });
          }))) return;
        if (!await subscribe(() => onStreamEnd((event) => {
            if (ours(event.request_id)) finish(event.cancelled ? "stopped" : "done");
          }))) return;
        if (!await subscribe(() => onStreamError((event) => {
            if (ours(event.request_id)) finish("error", event.message);
          }))) return;
        if (!active()) return;
        request.sent = true;
        await askMeeting(meetingId, question, requestId);
        if (!request.finished) finish(answer.trim() ? "done" : "stopped");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (request.finished) {
          // Answered, but the backend could not save it.
          update(answerId, { error: message });
        } else {
          finish("error", message);
        }
      } finally {
        dropListeners(request);
        release();
      }
    },
    [meetingId, enabled, dropListeners],
  );

  const stop = useCallback(() => {
    const request = requestRef.current;
    if (!request || request.disposed || request.finished || request.meetingId !== viewRef.current.meetingId) return;
    if (!request.sent) request.finish("stopped");
    else cancelGeneration(request.id).catch((err) => request.finish("error", err instanceof Error ? err.message : String(err)));
  }, []);

  return { items, loading, loadError, isAsking, session, ask, stop };
}
