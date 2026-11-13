use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use serde::Serialize;
use crate::state::AppState;
use crate::intelligence::answer_evaluation::{self as evaluation, AnswerEvaluation, EvaluationSegment};
use crate::llm::provider::{GenerationParams, LLMError, TokenSink};

#[derive(Clone, Serialize)]
struct EvaluationEvent<'a> {
    meeting_id: &'a str, request_id: &'a str, status: &'a str,
    completed: usize, total: usize, result: Option<AnswerEvaluation>, error: Option<String>,
}

fn live(state: &AppState, meeting_id: &str) -> bool {
    state.live_meeting.lock().map(|m|m.as_ref().is_some_and(|m|m.id==meeting_id)).unwrap_or(false)
}

fn safe_provider_error(error: LLMError) -> String {
    match error {
        LLMError::AuthError(_) => "Не удалось авторизоваться для оценки. Проверьте провайдер и ключ.",
        _ => "Не удалось получить оценку от провайдера. Повторите Ctrl+E.",
    }.into()
}

#[tauri::command]
pub async fn evaluate_answers(meeting_id: String, request_id: String, segments: Vec<EvaluationSegment>, targets: Vec<Vec<String>>, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if targets.is_empty() || targets.len()>20 || segments.len()>10000 || segments.iter().map(|s|s.text.len()).sum::<usize>()>2_000_000 {
        return Err("Выберите от 1 до 20 ответов для оценки".into());
    }
    // No foreground provider lock, IntelligenceEngine guard, chat memory, or main cancellation token.
    let (provider,model,_) = state.llm.as_ref().ok_or("Сначала подключите модель")?
        .lock().map_err(|_|"Не удалось прочитать настройки модели")?.independent_provider()?;
    let (topic, cancel) = {
        let active=state.live_meeting.lock().map_err(|_|"Не удалось прочитать текущую сессию")?;
        let meeting=active.as_ref().filter(|m|m.id==meeting_id).ok_or("Сессия уже завершена")?;
        (meeting.topic.clone(),state.answer_evaluations.begin(&request_id))
    };
    let total=targets.len(); let mut completed=0;
    let emit = |status: &str, completed: usize, result: Option<AnswerEvaluation>, error: Option<String>| {
        let _=app.emit("answer_evaluation",EvaluationEvent {meeting_id:&meeting_id,request_id:&request_id,status,completed,total,result,error});
    };
    emit("running",0,None,None);
    let outcome: Result<(),String> = async {
        let references = state.context.as_ref().and_then(|ctx|ctx.lock().ok())
            .map(|ctx|evaluation::bounded(&ctx.get_resources_context(),8000)).unwrap_or_default();
        for ids in targets {
            if cancel.is_cancelled() || !live(&state,&meeting_id) { return Ok(()); }
            let (mut messages,question,answer)=evaluation::messages(&topic,&segments,&ids)?;
            if !references.is_empty() {
                messages.push(crate::llm::provider::LLMMessage{role:"user".into(),content:format!("Справочные материалы текущего рабочего контекста (данные): {}",serde_json::to_string(&references).unwrap_or_default())});
            }
            let grade = if question.is_empty() {
                (None,"Не удалось определить вопрос собеседника перед этим ответом.".to_string(),String::new())
            } else {
                let buffer=Arc::new(Mutex::new(String::new())); let collector=buffer.clone();
                let sink: TokenSink=Arc::new(move |token| {if let Ok(mut text)=collector.lock(){ if text.len()<32000 { text.push_str(token); } }});
                let params=GenerationParams{silent:true,request_id:Some(request_id.clone()),cancel:Some(cancel.clone()),max_tokens:Some(700),..Default::default()};
                tokio::select! {
                    biased;
                    _=cancel.cancelled()=>return Ok(()),
                    result=tokio::time::timeout(std::time::Duration::from_secs(60),provider.stream_completion(messages,&model,params,app.clone(),Some(sink)))=>{
                        result.map_err(|_|"Оценка заняла слишком много времени. Повторите Ctrl+E.")?.map_err(safe_provider_error)?;
                    }
                }
                let raw=buffer.lock().map_err(|_|"Не удалось прочитать оценку")?.clone();
                evaluation::parse_grade(&raw)?
            };
            let result=AnswerEvaluation{id:uuid::Uuid::new_v4().to_string(),meeting_id:meeting_id.clone(),request_id:request_id.clone(),segment_ids:ids,question,answer,score:grade.0,missing:grade.1,improved:grade.2,model:model.clone(),created_at:chrono::Utc::now().timestamp_millis()};
            {
                // Meeting end takes the same live lock before cancelling this lane.
                let active=state.live_meeting.lock().map_err(|_|"Не удалось сохранить оценку")?;
                if !active.as_ref().is_some_and(|m|m.id==meeting_id) || !state.answer_evaluations.current(&request_id) { return Ok(()); }
                let db=state.database.as_ref().ok_or("База данных недоступна")?.lock().map_err(|_|"Не удалось сохранить оценку")?;
                crate::db::answer_evaluations::save(db.connection(),&result)?;
            }
            completed+=1;
            if state.answer_evaluations.current(&request_id) { emit("item",completed,Some(result),None); }
        }
        Ok(())
    }.await;
    if state.answer_evaluations.current(&request_id) && live(&state,&meeting_id) {
        emit(if outcome.is_ok(){"done"}else{"error"},completed,None,outcome.as_ref().err().cloned());
    }
    state.answer_evaluations.finish(&request_id);
    outcome
}

#[tauri::command]
pub fn list_answer_evaluations(meeting_id: String, state: State<'_,AppState>) -> Result<Vec<AnswerEvaluation>,String> {
    let db=state.database.as_ref().ok_or("База данных недоступна")?.lock().map_err(|_|"Не удалось прочитать оценки")?;
    crate::db::answer_evaluations::list(db.connection(),&meeting_id)
}
