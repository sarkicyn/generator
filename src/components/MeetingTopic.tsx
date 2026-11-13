import { useEffect, useId, useState } from "react";
import { Pencil, MessageSquareText } from "lucide-react";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";

const placeholder = "Например: собеседование по C# — сборка мусора и Large Object Heap";
const inputClass = "w-full resize-y rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none";

export function DraftMeetingTopic() {
  const id = useId();
  const topic = useMeetingStore((s) => s.draftTopic);
  const setTopic = useMeetingStore((s) => s.setDraftTopic);
  return (
    <div className="space-y-2 rounded-xl border border-border/30 bg-secondary/10 p-3">
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-medium text-foreground/80">
        <MessageSquareText className="h-3.5 w-3.5" /> Тема записи
      </label>
      <textarea id={id} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={2000} rows={2} placeholder={placeholder} className={inputClass} />
      <p className="text-[11px] text-muted-foreground">Необязательно. ИИ учтёт тему при ответах на ваши вопросы.</p>
    </div>
  );
}

export function LiveMeetingTopic() {
  const id = useId();
  const meeting = useMeetingStore((s) => s.activeMeeting);
  const updateTopic = useMeetingStore((s) => s.updateTopic);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEditing(false); setSaving(false); }, [meeting?.id]);
  if (!meeting) return null;
  const topic = meeting.topic ?? "";
  return (
    <div className="shrink-0 border-b border-border/20 px-4 py-1.5">
      {!editing ? (
        <button type="button" aria-label="Изменить тему записи" title={topic || "Добавить тему записи"}
          onClick={() => { setDraft(topic); setEditing(true); }}
          className="flex w-full min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground">
          <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Тема записи: {topic || "добавить"}</span>
          <Pencil className="h-3 w-3 shrink-0" />
        </button>
      ) : (
        <form className="space-y-2 py-1" onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          try { await updateTopic(draft); setEditing(false); }
          catch (error) { showToast(error instanceof Error ? error.message : "Не удалось сохранить тему записи", "error"); }
          finally { setSaving(false); }
        }}>
          <label htmlFor={id} className="text-xs font-medium">Тема записи</label>
          <textarea autoFocus id={id} value={draft} disabled={saving} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={2} placeholder={placeholder} className={inputClass} />
          <div className="flex items-center gap-3 text-xs">
            <button type="submit" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">{saving ? "Сохранение…" : "Сохранить тему"}</button>
            <button type="button" disabled={saving} onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">Отмена</button>
            <span className="text-[11px] text-muted-foreground">Применится к следующим ответам ИИ.</span>
          </div>
        </form>
      )}
    </div>
  );
}
