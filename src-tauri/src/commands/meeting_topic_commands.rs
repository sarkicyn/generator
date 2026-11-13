use tauri::{AppHandle, Emitter, State};
use crate::llm::cli_agent::manager::SessionScope;
use crate::state::AppState;

pub(crate) fn normalize_topic(topic: &str) -> Result<String, String> {
    let topic = topic.trim();
    if topic.chars().count() > 2000 {
        return Err("Тема записи не должна превышать 2000 символов".into());
    }
    Ok(topic.to_string())
}

pub(crate) fn topic_for_scope(state: &AppState, scope: &SessionScope) -> Result<Option<String>, String> {
    match scope {
        SessionScope::Utility => Ok(None),
        SessionScope::Live(id) => Ok(state.live_meeting.lock().map_err(|_| "Meeting lock")?
            .as_ref().filter(|meeting| &meeting.id == id).map(|meeting| meeting.topic.clone())),
        SessionScope::Past(id) => {
            let db = state.database.as_ref().ok_or("Database not initialized")?.lock().map_err(|_| "Database lock")?;
            db.connection().query_row("SELECT topic FROM meetings WHERE id=?1", [id], |row| row.get(0))
                .map(Some).map_err(|_| "Не удалось загрузить тему записи".into())
        }
    }
}

/// Sent on every request, independently of transcript/RAG/action switches.
/// The explicit empty value also clears a previous topic in a warm session.
pub(crate) fn with_topic(prompt: String, topic: Option<&str>) -> String {
    let Some(topic) = topic else { return prompt; };
    let context = if topic.trim().is_empty() {
        "No recording topic is specified for this request. Do not assume a topic from earlier requests.".to_string()
    } else {
        format!("Current recording topic (user-provided context): {}. Use it to interpret this request and its terminology. Do not invent unstated facts.",
            serde_json::to_string(topic).unwrap_or_default())
    };
    format!("{prompt}\n\n## Recording topic\n{context}")
}

#[tauri::command]
pub async fn update_meeting_topic(meeting_id: String, topic: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let topic = normalize_topic(&topic)?;
    {
        let db = state.database.as_ref().ok_or("Database not initialized")?.lock().map_err(|_| "Database lock")?;
        let changed = db.connection().execute("UPDATE meetings SET topic=?1 WHERE id=?2", rusqlite::params![topic, meeting_id])
            .map_err(|_| "Не удалось сохранить тему записи")?;
        if changed == 0 { return Err("Запись не найдена".into()); }
    }
    if let Some(meeting) = state.live_meeting.lock().map_err(|_| "Meeting lock")?.as_mut().filter(|meeting| meeting.id == meeting_id) {
        meeting.topic = topic.clone();
    }
    let _ = app.emit("nexq:meeting_topic_updated", serde_json::json!({"meetingId":meeting_id,"topic":topic}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_keeps_existing_meetings_and_defaults_their_topic_to_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, start_time TEXT, end_time TEXT, duration_seconds INTEGER, transcript TEXT, ai_interactions TEXT, summary TEXT, config_snapshot TEXT);
            INSERT INTO meetings(id,title,start_time,transcript,ai_interactions) VALUES('old','Existing meeting','2026-10-30T00:00:00Z','[]','[]');").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let meeting = crate::db::meetings::get_meeting(&conn, "old").unwrap();
        assert_eq!(meeting.title, "Existing meeting");
        assert!(meeting.topic.is_empty());
    }

    #[test]
    fn a_late_request_for_an_old_meeting_cannot_get_the_new_topic() {
        let state = AppState::new();
        *state.live_meeting.lock().unwrap() = Some(crate::state::LiveMeeting { id:"new".into(), topic:"New recording".into(), start_ms:0 });
        assert_eq!(topic_for_scope(&state, &SessionScope::Live("new".into())).unwrap().as_deref(), Some("New recording"));
        assert!(topic_for_scope(&state, &SessionScope::Live("old".into())).unwrap().is_none());
        assert!(topic_for_scope(&state, &SessionScope::Utility).unwrap().is_none());
    }

    #[test]
    fn topic_is_persistent_editable_and_does_not_leak_to_the_next_meeting() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let meeting = crate::db::meetings::create_meeting_with_topic(&conn, "Interview", ".NET memory management").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        assert_eq!(crate::db::meetings::get_meeting(&conn, &meeting.id).unwrap().topic, ".NET memory management");
        conn.execute("UPDATE meetings SET topic='' WHERE id=?1", [&meeting.id]).unwrap();
        assert!(crate::db::meetings::get_meeting(&conn, &meeting.id).unwrap().topic.is_empty());
        assert!(crate::db::meetings::create_meeting(&conn, "Next").unwrap().topic.is_empty());
    }

    #[test]
    fn each_request_gets_the_current_topic_even_without_a_transcript() {
        let prompt = with_topic("Answer only the latest question".into(), Some(".NET\n\"GC\""));
        assert!(prompt.contains(".NET\\n\\\"GC\\\""));
        assert!(prompt.contains("Answer only the latest question"));
        assert!(with_topic("Follow-up".into(), Some("")).contains("No recording topic is specified"));
        assert_eq!(with_topic("Utility".into(), None), "Utility");
    }

    #[test]
    fn topic_validation_keeps_unicode_and_rejects_oversized_input() {
        assert_eq!(normalize_topic("  Собеседование: C#  ").unwrap(), "Собеседование: C#");
        assert!(normalize_topic(&"я".repeat(2000)).is_ok());
        assert!(normalize_topic(&"я".repeat(2001)).is_err());
    }
}
