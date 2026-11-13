//! Compact, role-preserving chat history for stateless API providers.
use crate::db::meeting_chat::MeetingChatMessage;
use crate::llm::provider::LLMMessage;

pub const HISTORY_CHARS: usize = 24_000;
const TURN_CHARS: usize = 8_000;

fn bounded(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit { return text.to_owned(); }
    let half = (limit.saturating_sub(40)) / 2;
    format!("{}\n[Earlier text shortened]\n{}", chars[..half].iter().collect::<String>(), chars[chars.len()-half..].iter().collect::<String>())
}

/// Preserve complete exchanges, chronological and with their original roles.
/// A very long latest answer is shortened, never allowed to erase all history.
pub fn recent_messages(chat: &[MeetingChatMessage]) -> Vec<LLMMessage> {
    let mut remaining = HISTORY_CHARS;
    let mut pairs = Vec::new();
    for (index,pair) in chat.windows(2).enumerate().rev() {
        if pair[0].role != "user" || pair[1].role != "assistant" { continue; }
        if pair[0].content.trim().is_empty() || pair[1].content.trim().is_empty() { continue; }
        let question = bounded(&pair[0].content, 2_000);
        let answer = bounded(&pair[1].content, TURN_CHARS.saturating_sub(question.chars().count()));
        let size = question.chars().count() + answer.chars().count();
        if size > remaining { break; }
        remaining -= size;
        pairs.push((index,[LLMMessage { role:"user".into(), content:question }, LLMMessage { role:"assistant".into(), content:answer }]));
    }
    pairs.reverse();
    // Keep the opening context (project/name/preferences) even in a long chat,
    // without an extra model call just to summarize the conversation.
    if let Some((index,first)) = chat.windows(2).enumerate().find(|(_,p)|p[0].role=="user" && p[1].role=="assistant" && !p[0].content.trim().is_empty() && !p[1].content.trim().is_empty()) {
        if pairs.first().map(|p|p.0)!=Some(index) {
            let anchor=[LLMMessage {role:"user".into(),content:bounded(&first[0].content,1000)},LLMMessage {role:"assistant".into(),content:bounded(&first[1].content,1000)}];
            let size=anchor.iter().map(|m|m.content.chars().count()).sum::<usize>();
            while remaining<size && !pairs.is_empty() {
                remaining+=pairs.remove(0).1.iter().map(|m|m.content.chars().count()).sum::<usize>();
            }
            pairs.insert(0,(index,anchor));
        }
    }
    pairs.into_iter().flat_map(|(_,pair)|pair).collect()
}

pub fn insert_history(mut current: Vec<LLMMessage>, history: Vec<LLMMessage>) -> Vec<LLMMessage> {
    if let Some(question)=current.pop() { current.extend(history); current.push(question); }
    current
}

/// Hidden reasoning is not part of the conversation replay.
pub fn visible_answer(raw: &str) -> String {
    let mut text = raw.to_owned();
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        while let Some(start) = text.find(open) {
            if let Some(end) = text[start+open.len()..].find(close) {
                text.replace_range(start..start+open.len()+end+close.len(), "");
            } else { text.truncate(start); break; }
        }
    }
    text.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(role: &str, content: &str) -> MeetingChatMessage {
        MeetingChatMessage { id:String::new(), meeting_id:"m".into(), role:role.into(), content:content.into(), model:None, input_tokens:None, output_tokens:None, created_at:0 }
    }
    #[test]
    fn keeps_roles_order_and_earlier_facts_for_followups() {
        let history=recent_messages(&[row("user", "Мой проект называется Луна."), row("assistant", "Запомнил: Луна."), row("user", "Unanswered"), row("user", "Explain its cache"), row("assistant", "Use a local cache.")]);
        assert_eq!(history.iter().map(|m|m.role.as_str()).collect::<Vec<_>>(), ["user","assistant","user","assistant"]);
        assert!(history[0].content.contains("Луна")); assert_eq!(history[2].content, "Explain its cache");
    }
    #[test]
    fn oversized_answer_does_not_drop_the_whole_conversation() {
        let history=recent_messages(&[row("user","Project: Vega"),row("assistant","Noted"),row("user","Explain"),row("assistant", &"я".repeat(200_000))]);
        assert_eq!(history.len(),4); assert!(history[0].content.contains("Vega"));
        assert!(history.iter().map(|m|m.content.chars().count()).sum::<usize>()<=HISTORY_CHARS);
    }
    #[test]
    fn excludes_incomplete_answers_and_hidden_reasoning() {
        assert!(recent_messages(&[row("user","Q"),row("assistant","")]).is_empty());
        assert_eq!(visible_answer("<think>private</think>\nОтвет"),"Ответ");
        assert_eq!(visible_answer("Answer<think>unfinished"),"Answer");
    }
    #[test]
    fn opening_context_survives_a_long_chat_and_the_current_question_is_last() {
        let mut rows=vec![row("user","My project is Vega"),row("assistant","Vega, noted.")];
        for index in 0..20 { rows.push(row("user",&format!("Question {index}"))); rows.push(row("assistant",&"я".repeat(4000))); }
        let messages=insert_history(vec![LLMMessage{role:"system".into(),content:"Answer only the current question".into()},LLMMessage{role:"user".into(),content:"What is my project called?".into()}],recent_messages(&rows));
        assert!(messages[1].content.contains("Vega"));
        assert_eq!(messages.last().unwrap().content,"What is my project called?");
        assert!(messages.iter().any(|m|m.content=="Question 19"));
        assert!(messages[1..messages.len()-1].iter().map(|m|m.content.chars().count()).sum::<usize>()<=HISTORY_CHARS);
    }
}
