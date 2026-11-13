//! "Ask this meeting" chat: the questions asked about a past meeting and the
//! answers given, saved with the meeting.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// One chat message about a meeting. `created_at` is Unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingChatMessage {
    pub id: String,
    pub meeting_id: String,
    /// `"user"` | `"assistant"`.
    pub role: String,
    pub content: String,
    /// The model that answered (assistant rows).
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub created_at: i64,
}

pub fn insert_chat_message(conn: &Connection, msg: &MeetingChatMessage) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meeting_chat
            (id, meeting_id, role, content, model, input_tokens, output_tokens, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            msg.id,
            msg.meeting_id,
            msg.role,
            msg.content,
            msg.model,
            msg.input_tokens,
            msg.output_tokens,
            msg.created_at,
        ],
    )?;
    Ok(())
}

/// One completed exchange is saved atomically; a failed answer never leaves an orphan question.
pub fn insert_exchange(conn: &Connection, rows: &[MeetingChatMessage; 2]) -> rusqlite::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    insert_chat_message(&transaction, &rows[0])?;
    insert_chat_message(&transaction, &rows[1])?;
    transaction.commit()
}

/// The meeting's chat, oldest first (insert order breaks ties).
pub fn list_chat_messages(conn: &Connection, meeting_id: &str) -> rusqlite::Result<Vec<MeetingChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, role, content, model, input_tokens, output_tokens, created_at
         FROM meeting_chat WHERE meeting_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingChatMessage {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            input_tokens: row.get(5)?,
            output_tokens: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Remove a meeting's chat (the meeting is being deleted).
pub fn delete_chat_messages(conn: &Connection, meeting_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM meeting_chat WHERE meeting_id = ?1", params![meeting_id])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{meetings, migrations};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn msg(id: &str, meeting_id: &str, role: &str, content: &str, created_at: i64) -> MeetingChatMessage {
        MeetingChatMessage {
            id: id.into(),
            meeting_id: meeting_id.into(),
            role: role.into(),
            content: content.into(),
            model: (role == "assistant").then(|| "sonnet".to_string()),
            input_tokens: (role == "assistant").then_some(120),
            output_tokens: (role == "assistant").then_some(30),
            created_at,
        }
    }

    #[test]
    fn chat_roundtrip_in_memory() {
        let conn = db();
        // Inserted out of order: listing follows created_at.
        let answer = msg("a1", "m1", "assistant", "Friday.", 2_000);
        let question = msg("q1", "m1", "user", "When do we ship?", 1_000);
        insert_chat_message(&conn, &answer).unwrap();
        insert_chat_message(&conn, &question).unwrap();
        insert_chat_message(&conn, &msg("q9", "other", "user", "Unrelated", 1_500)).unwrap();

        let listed = list_chat_messages(&conn, "m1").unwrap();
        assert_eq!(listed, vec![question, answer]);
        assert!(list_chat_messages(&conn, "nope").unwrap().is_empty());
    }

    #[test]
    fn meeting_chat_rejects_unknown_role() {
        let conn = db();
        assert!(insert_chat_message(&conn, &msg("x", "m1", "system", "no", 1)).is_err());
    }
    #[test]
    fn failed_exchange_rolls_back_the_question() {
        let conn=db();
        let rows=[msg("q","m","user","Q",1),msg("a","m","invalid","A",2)];
        assert!(insert_exchange(&conn,&rows).is_err());
        assert!(list_chat_messages(&conn,"m").unwrap().is_empty());
    }
    #[test]
    fn saved_conversation_survives_reopening_and_stays_in_its_meeting() {
        let path=std::env::temp_dir().join(format!("nexq-chat-{}.sqlite",uuid::Uuid::new_v4()));
        {
            let conn=Connection::open(&path).unwrap(); migrations::run(&conn).unwrap();
            insert_exchange(&conn,&[msg("q","m1","user","Project: Vega",1),msg("a","m1","assistant","Vega, noted",2)]).unwrap();
        }
        {
            let conn=Connection::open(&path).unwrap();
            let history=crate::intelligence::conversation::recent_messages(&list_chat_messages(&conn,"m1").unwrap());
            assert_eq!(history.len(),2); assert!(history[0].content.contains("Vega"));
            assert!(list_chat_messages(&conn,"m2").unwrap().is_empty());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn meeting_chat_same_millisecond_keeps_insert_order() {
        let conn = db();
        insert_chat_message(&conn, &msg("q", "m1", "user", "Q", 5)).unwrap();
        insert_chat_message(&conn, &msg("a", "m1", "assistant", "A", 5)).unwrap();
        let ids: Vec<String> = list_chat_messages(&conn, "m1").unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["q", "a"]);
    }

    #[test]
    fn migration_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        migrations::run(&conn).unwrap();
        insert_chat_message(&conn, &msg("q1", "m1", "user", "Still works?", 1)).unwrap();
        assert_eq!(list_chat_messages(&conn, "m1").unwrap().len(), 1);
    }

    #[test]
    fn meeting_chat_deleted_with_its_meeting() {
        let conn = db();
        let meeting = meetings::create_meeting(&conn, "Standup").unwrap();
        insert_chat_message(&conn, &msg("q1", &meeting.id, "user", "Q", 1)).unwrap();
        insert_chat_message(&conn, &msg("a1", &meeting.id, "assistant", "A", 2)).unwrap();
        meetings::delete_meeting(&conn, &meeting.id).unwrap();
        assert!(list_chat_messages(&conn, &meeting.id).unwrap().is_empty());
    }
}
