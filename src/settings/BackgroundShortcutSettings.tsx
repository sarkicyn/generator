import { useEffect, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { BACKGROUND_LABELS, DEFAULT_BACKGROUND_SHORTCUTS, backgroundShortcutConflict, type BackgroundAction } from "../lib/backgroundShortcuts";
import { acceleratorFromEvent, formatShortcut } from "../lib/shortcutLabel";
import { showToast } from "../stores/toastStore";

export function BackgroundShortcutSettings() {
  const bindings = useConfigStore(s => s.backgroundShortcuts);
  const stealthKey = useConfigStore(s => s.stealthShortcut);
  const setBindings = useConfigStore(s => s.setBackgroundShortcuts);
  const [editing, setEditing] = useState<BackgroundAction | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!editing) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { setEditing(null); return; }
      if (event.repeat) return;
      const key = acceleratorFromEvent(event);
      if (!key) return;
      const conflict = backgroundShortcutConflict(key, bindings, editing, stealthKey);
      if (conflict) { setError(conflict); return; }
      setBindings({ ...bindings, [editing]: key });
      setEditing(null); setError("");
      showToast("Сочетание сохранено", "success");
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [editing, bindings, stealthKey, setBindings]);
  return <div className="rounded-xl border border-border/30 bg-card/50 p-5 space-y-3">
    <h3 className="text-sm font-medium">Управление из других приложений</h3>
    <p className="text-xs text-muted-foreground">Ответ и снимок отправляются в текущую сессию без переключения окна. Ctrl+K — включить или выключить краткий ответ во время сессии. Ctrl+E — оценить ответ; Ctrl+M — завершить сессию и скрыть окна.</p>
    {(Object.keys(BACKGROUND_LABELS) as BackgroundAction[]).map(action => <div key={action} className="flex items-center justify-between gap-3 text-xs">
      <span>{BACKGROUND_LABELS[action]}</span>
      <button className="rounded-lg bg-secondary/60 px-3 py-2 font-mono cursor-pointer" onClick={() => { setEditing(action); setError(""); }}>
        {editing === action ? "Нажмите клавиши… (Esc — отмена)" : formatShortcut(bindings[action])}
      </button>
    </div>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <button className="text-xs text-muted-foreground cursor-pointer" onClick={() => {
      const conflict = (Object.keys(DEFAULT_BACKGROUND_SHORTCUTS) as BackgroundAction[]).map(a => backgroundShortcutConflict(DEFAULT_BACKGROUND_SHORTCUTS[a], DEFAULT_BACKGROUND_SHORTCUTS, a, stealthKey)).find(Boolean);
      if (conflict) { setError(conflict); return; }
      setBindings({ ...DEFAULT_BACKGROUND_SHORTCUTS }); setEditing(null); setError("");
    }}>Восстановить стандартные фоновые сочетания</button>
  </div>;
}
