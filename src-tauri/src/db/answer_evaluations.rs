use rusqlite::{params, Connection};
use crate::intelligence::answer_evaluation::AnswerEvaluation;

pub fn save(conn: &Connection, result: &AnswerEvaluation) -> Result<(), String> {
    let payload = serde_json::to_string(result).map_err(|_| "Не удалось сохранить оценку")?;
    conn.execute("INSERT INTO answer_evaluations(id,meeting_id,created_at,payload) VALUES(?1,?2,?3,?4)",
        params![result.id,result.meeting_id,result.created_at,payload]).map_err(|_| "Не удалось сохранить оценку")?;
    Ok(())
}

pub fn list(conn: &Connection, meeting_id: &str) -> Result<Vec<AnswerEvaluation>, String> {
    let mut stmt = conn.prepare("SELECT payload FROM (SELECT rowid,payload,created_at FROM answer_evaluations WHERE meeting_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 50) ORDER BY created_at,rowid")
        .map_err(|_| "Не удалось загрузить оценки")?;
    let rows = stmt.query_map([meeting_id], |row|row.get::<_,String>(0)).map_err(|_| "Не удалось загрузить оценки")?;
    rows.map(|row| row.map_err(|_| "Не удалось загрузить оценки".to_string()).and_then(|json|serde_json::from_str(&json).map_err(|_| "Не удалось прочитать оценку".into()))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evaluations_are_durable_and_isolated_from_normal_chat_and_other_meetings() {
        let conn=Connection::open_in_memory().unwrap(); crate::db::migrations::run(&conn).unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let first=crate::db::meetings::create_meeting_with_topic(&conn,"One","topic").unwrap();
        let second=crate::db::meetings::create_meeting_with_topic(&conn,"Two","").unwrap();
        let result=AnswerEvaluation{id:"e".into(),meeting_id:first.id.clone(),request_id:"r".into(),segment_ids:vec!["a".into()],question:"Q".into(),answer:"A".into(),score:Some(72),missing:"Example".into(),improved:"Better".into(),model:"test".into(),created_at:1};
        save(&conn,&result).unwrap(); assert_eq!(list(&conn,&first.id).unwrap()[0].score,Some(72));
        assert!(list(&conn,&second.id).unwrap().is_empty());
        assert!(crate::db::meeting_chat::list_chat_messages(&conn,&first.id).unwrap().is_empty());
        conn.execute("DELETE FROM meetings WHERE id=?1",[first.id]).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM answer_evaluations",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
}
