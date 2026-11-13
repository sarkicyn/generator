// Sub-PRD 5: User-configured custom endpoint with auto-detect SSE/NDJSON

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{Duration, Instant};

use super::provider::{
    CompletionStats, GenerationParams, LLMError, LLMMessage, LLMProvider, ModelInfo,
    cancellable, check_cancelled, is_cancelled, emit_end, emit_error, emit_token, TokenSink,
};
use super::stream_parser::{NDJSONParser, SSEParser};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CustomAuthType {
    None,
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone)]
pub struct CustomConfig {
    pub base_url: String,
    pub auth_type: CustomAuthType,
    pub auth_value: Option<String>,
    pub auth_header: Option<String>,
}

pub struct CustomClient {
    config: CustomConfig,
    client: reqwest::Client,
    progress_timeout: Duration,
}

impl CustomClient {
    pub fn new(mut config: CustomConfig) -> Self {
        config.base_url = config.base_url.trim_end_matches('/').to_string();
        Self {
            config,
            client: reqwest::Client::builder().connect_timeout(Duration::from_secs(10))
                .build().expect("HTTP client configuration is valid"),
            progress_timeout: Duration::from_secs(45),
        }
    }

    /// Apply authentication to a request based on the configured auth type.
    fn apply_auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.config.auth_type {
            CustomAuthType::None => builder,
            CustomAuthType::Bearer => {
                if let Some(ref token) = self.config.auth_value {
                    builder.header("Authorization", format!("Bearer {}", token))
                } else {
                    builder
                }
            }
            CustomAuthType::ApiKey => {
                let header = self
                    .config
                    .auth_header
                    .as_deref()
                    .unwrap_or("x-api-key");
                if let Some(ref key) = self.config.auth_value {
                    builder.header(header, key.as_str())
                } else {
                    builder
                }
            }
        }
    }

    /// Detect whether a stream is SSE or NDJSON and parse tokens accordingly.
    /// Returns (token_text, is_done).
    fn try_extract_token(line: &str) -> Vec<(Option<String>, bool)> {
        let sse_events = SSEParser::parse_chunk(line);
        let events = if sse_events.is_empty() { NDJSONParser::parse_chunk(line).into_iter().map(Some).collect() } else { sse_events };
        events.into_iter().map(|event| match event {
            None => (None,true),
            Some(data) => {
                let done = NDJSONParser::is_ollama_done(&data)
                    || data.pointer("/choices/0/finish_reason").is_some_and(|v| !v.is_null())
                    || data.get("type").and_then(|v|v.as_str()) == Some("message_stop")
                    || data.pointer("/candidates/0/finishReason").is_some_and(|v| !v.is_null());
                let token = SSEParser::extract_openai_token(&data)
                    .or_else(|| data.pointer("/choices/0/message/content").and_then(|v|v.as_str()).map(str::to_owned))
                    .or_else(|| NDJSONParser::extract_ollama_token(&data))
                    .or_else(|| SSEParser::extract_anthropic_token(&data))
                    .or_else(|| SSEParser::extract_gemini_token(&data))
                    .or_else(|| data.get("text").and_then(|v|v.as_str()).map(str::to_owned))
                    .or_else(|| data.get("content").and_then(|v|v.as_str()).map(str::to_owned));
                (token,done)
            }
        }).collect()
    }

    async fn send(&self, url: &str, body: &serde_json::Value, params: &GenerationParams) -> Result<reqwest::Response, LLMError> {
        let request = self.apply_auth(self.client.post(url)).json(body);
        cancellable(params, tokio::time::timeout(Duration::from_secs(45), request.send())).await?
            .map_err(|_| LLMError::ConnectionFailed("Провайдер не начал ответ за 45 секунд. Повторите запрос или выберите другую модель.".into()))?
            .map_err(LLMError::HttpError)
    }

    /// Transport is independent of UI events, so real HTTP streaming behavior
    /// (including a server that keeps the connection open after DONE) is testable.
    async fn complete<F: FnMut(&str) + Send>(&self, messages: Vec<LLMMessage>, model: &str,
        params: &GenerationParams, mut token: F) -> Result<CompletionStats, LLMError> {
        let start=Instant::now();
        let mut body=json!({"model":model,"messages":super::image_input::openai_messages(&messages,params.image.as_ref()),"stream":true});
        if let Some(value)=params.temperature { body["temperature"]=json!(value); }
        if let Some(value)=params.max_tokens { body["max_tokens"]=json!(value); }
        let mut response=self.send(&format!("{}/chat/completions",self.config.base_url), &body, params).await?;
        // Authentication/rate limits/network failures are not protocol detection.
        // Retrying them at /api/chat masked the error and doubled the wait.
        if matches!(response.status().as_u16(),404|405|501) {
            let mut fallback=json!({"model":model,"messages":super::image_input::ollama_messages(&messages,params.image.as_ref()),"stream":true,"options":{}});
            if let Some(value)=params.temperature { fallback["options"]["temperature"]=json!(value); }
            if let Some(value)=params.max_tokens { fallback["options"]["num_predict"]=json!(value); }
            response=self.send(&format!("{}/api/chat",self.config.base_url.trim_end_matches("/v1")), &fallback, params).await?;
        }
        if !response.status().is_success() {
            let status=response.status();
            if params.image.is_some() {
                let message=super::image_input::rejection(status.as_u16());
                return Err(if matches!(status.as_u16(),401|403) {LLMError::AuthError(message)} else {LLMError::ProviderError(message)});
            }
            let detail=cancellable(params,tokio::time::timeout(Duration::from_secs(3),response.text())).await?
                .ok().and_then(Result::ok).unwrap_or_default();
            let safe=if let Some(secret)=self.config.auth_value.as_deref().filter(|s|!s.is_empty()) { detail.replace(secret,"[redacted]") } else { detail };
            let message=format!("Custom endpoint request failed ({}): {}",status,safe.chars().take(1000).collect::<String>());
            return Err(if matches!(status.as_u16(),401|403) { LLMError::AuthError(message) } else { LLMError::ProviderError(message) });
        }
        log::info!("[custom] Response headers received in {} ms",start.elapsed().as_millis());
        let mut stream=response.bytes_stream();
        let mut pending=Vec::new();
        let mut count=0;
        let mut finished=false;
        let mut last_progress=Instant::now();
        'read: loop {
            // Keep-alive comments must not extend a request forever.
            let remaining=self.progress_timeout.saturating_sub(last_progress.elapsed());
            let next=cancellable(params,tokio::time::timeout(remaining,stream.next())).await?
                .map_err(|_|LLMError::ConnectionFailed("Провайдер перестал передавать ответ на 45 секунд.".into()))?;
            let Some(chunk)=next else { break };
            pending.extend_from_slice(&chunk?);
            if pending.len()>2*1024*1024 { return Err(LLMError::InvalidResponse("Oversized streaming packet".into())); }
            // Decode only complete lines: UTF-8 letters can span TCP chunks.
            if let Some(end)=pending.iter().rposition(|&b|b==b'\n') {
                let bytes:Vec<u8>=pending.drain(..=end).collect();
                let text=std::str::from_utf8(&bytes).map_err(|_|LLMError::InvalidResponse("Invalid UTF-8 stream".into()))?;
                for line in text.lines() {
                    for (part,done) in Self::try_extract_token(line) {
                        check_cancelled(params)?;
                        if let Some(part)=part.filter(|p|!p.is_empty()) { token(&part); count+=1; last_progress=Instant::now(); }
                        if done { finished=true; break 'read; }
                    }
                }
            }
        }
        if !finished && !pending.is_empty() {
            let text=std::str::from_utf8(&pending).map_err(|_|LLMError::InvalidResponse("Invalid UTF-8 stream".into()))?;
            for (part,done) in Self::try_extract_token(text) {
                check_cancelled(params)?;
                if let Some(part)=part.filter(|p|!p.is_empty()) { token(&part); count+=1; }
                if done { break; }
            }
        }
        check_cancelled(params)?;
        if count==0 { return Err(LLMError::InvalidResponse("Провайдер завершил запрос без текста ответа.".into())); }
        let latency_ms=start.elapsed().as_millis() as u64;
        log::info!("[custom] Stream completed in {latency_ms} ms ({count} content packets)");
        Ok(CompletionStats { prompt_tokens:0, completion_tokens:count, total_tokens:count, latency_ms })
    }
}

#[async_trait::async_trait]
impl LLMProvider for CustomClient {
    fn provider_name(&self) -> &str {
        "custom"
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, LLMError> {
        // Try OpenAI-compatible /models endpoint
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));

        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let body: serde_json::Value = response.json().await?;
                let models = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                let id = m.get("id")?.as_str()?.to_string();
                                Some(ModelInfo {
                                    id: id.clone(),
                                    name: m
                                        .get("name")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or(&id)
                                        .to_string(),
                                    provider: "custom".to_string(),
                                    context_window: None,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(models)
            }
            _ => {
                // Try Ollama-compatible /api/tags endpoint
                let url = format!("{}/api/tags", self.config.base_url);
                let request = self.apply_auth(self.client.get(&url));

                match request.send().await {
                    Ok(response) if response.status().is_success() => {
                        let body: serde_json::Value = response.json().await?;
                        let models = body
                            .get("models")
                            .and_then(|m| m.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| {
                                        let name = m.get("name")?.as_str()?.to_string();
                                        Some(ModelInfo {
                                            id: name.clone(),
                                            name: name.clone(),
                                            provider: "custom".to_string(),
                                            context_window: None,
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        Ok(models)
                    }
                    _ => {
                        // Return empty list - user can type model name manually
                        Ok(vec![])
                    }
                }
            }
        }
    }

    async fn test_connection(&self) -> Result<bool, LLMError> {
        // Try /models first (OpenAI-compat)
        let url = format!("{}/models", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));
        if let Ok(resp) = request.send().await {
            if resp.status().is_success() {
                return Ok(true);
            }
        }

        // Try /api/tags (Ollama-compat)
        let url = format!("{}/api/tags", self.config.base_url);
        let request = self.apply_auth(self.client.get(&url));
        if let Ok(resp) = request.send().await {
            if resp.status().is_success() {
                return Ok(true);
            }
        }

        // Try a simple GET to the base URL
        let request = self.apply_auth(self.client.get(&self.config.base_url));
        match request.send().await {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    async fn stream_completion(
        &self,
        messages: Vec<LLMMessage>,
        model: &str,
        params: GenerationParams,
        app_handle: tauri::AppHandle,
        sink: Option<TokenSink>,
    ) -> Result<CompletionStats, LLMError> {
        let result = self.complete(messages, model, &params, |token| {
            emit_token(&app_handle, &params, token, sink.as_ref());
        }).await;
        match result {
            Ok(stats) => {
                emit_end(&app_handle, &params, stats.total_tokens, stats.latency_ms);
                Ok(stats)
            }
            Err(error) => {
                if !is_cancelled(&params) && !matches!(error, LLMError::Cancelled) {
                    emit_error(&app_handle, &params, &error.to_string());
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read,Write};
    use std::net::TcpListener;
    use std::sync::{Arc,Mutex};

    fn endpoint(responses:Vec<(u16,Vec<u8>,bool)>) -> (CustomClient,Arc<Mutex<Vec<String>>>) {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let url=format!("http://{}/v1",listener.local_addr().unwrap());
        let requests=Arc::new(Mutex::new(Vec::new())); let recorded=requests.clone();
        std::thread::spawn(move || {
            for (status,body,keep_open) in responses {
                let (mut socket,_)=listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request=Vec::new(); let mut packet=[0;4096];
                loop {
                    let count=socket.read(&mut packet).unwrap(); if count==0 {break} request.extend_from_slice(&packet[..count]);
                    if let Some(end)=request.windows(4).position(|s|s==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&request[..end]);
                        let length=headers.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length:").and_then(|n|n.trim().parse::<usize>().ok())).unwrap_or(0);
                        if request.len()>=end+4+length { break; }
                    }
                }
                recorded.lock().unwrap().push(String::from_utf8(request).unwrap());
                let headers=if keep_open { format!("HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n") }
                    else { format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()) };
                socket.write_all(headers.as_bytes()).unwrap();
                // Force a TCP boundary inside a Russian UTF-8 character.
                let split=body.iter().position(|&b|b>=0xc0).map(|i|i+1).unwrap_or(body.len());
                socket.write_all(&body[..split]).unwrap(); std::thread::sleep(Duration::from_millis(15));
                let _=socket.write_all(&body[split..]);
                if keep_open {
                    for _ in 0..40 {
                        std::thread::sleep(Duration::from_millis(50));
                        if socket.write_all(b": heartbeat\n\n").is_err() { break; }
                    }
                }
            }
        });
        let mut client=CustomClient::new(CustomConfig{base_url:url,auth_type:CustomAuthType::None,auth_value:None,auth_header:None});
        client.client=reqwest::Client::builder().no_proxy().build().unwrap();
        (client,requests)
    }
    fn question()->Vec<LLMMessage> { vec![LLMMessage{role:"user".into(),content:"A synthetic test".into()}] }

    #[tokio::test]
    async fn done_finishes_before_the_server_closes_the_connection_and_keeps_utf8() {
        let body="data: {\"choices\":[{\"delta\":{\"content\":\"Ответ\"}}]}\n\ndata: [DONE]\n\n".as_bytes().to_vec();
        let (client,_)=endpoint(vec![(200,body,true)]); let mut answer=String::new();
        let result=tokio::time::timeout(Duration::from_millis(700),client.complete(question(),"test",&GenerationParams::default(),|s|answer.push_str(s))).await;
        assert!(result.unwrap().is_ok(),"must not wait for the 2-second socket close"); assert_eq!(answer,"Ответ");
    }
    #[tokio::test]
    async fn auth_errors_are_returned_without_an_ollama_retry() {
        let (client,requests)=endpoint(vec![(401,b"invalid credential".to_vec(),false)]);
        assert!(matches!(client.complete(question(),"test",&GenerationParams::default(),|_|{}).await,Err(LLMError::AuthError(_))));
        assert_eq!(requests.lock().unwrap().len(),1);
    }
    #[tokio::test]
    async fn heartbeat_comments_do_not_keep_a_stalled_request_alive() {
        let (mut client,_)=endpoint(vec![(200,b": ready\n\n".to_vec(),true)]);
        client.progress_timeout=Duration::from_millis(100);
        let result=tokio::time::timeout(Duration::from_millis(700),client.complete(question(),"test",&GenerationParams::default(),|_|{})).await.unwrap();
        assert!(matches!(result,Err(LLMError::ConnectionFailed(_))));
    }
    #[tokio::test]
    async fn missing_openai_route_falls_back_and_preserves_the_final_ollama_token() {
        let (client,requests)=endpoint(vec![(404,Vec::new(),false),(200,"{\"message\":{\"content\":\"Готово\"},\"done\":true}\n".as_bytes().to_vec(),true)]);
        let mut answer=String::new();
        let result=tokio::time::timeout(Duration::from_millis(700),client.complete(question(),"test",&GenerationParams::default(),|s|answer.push_str(s))).await.unwrap();
        assert!(result.is_ok()); assert_eq!(answer,"Готово");
        let requests=requests.lock().unwrap(); assert_eq!(requests.len(),2); assert!(requests[1].starts_with("POST /api/chat "));
    }
    #[test]
    fn finish_reason_keeps_the_last_token_and_marks_completion() {
        assert_eq!(CustomClient::try_extract_token("data: {\"choices\":[{\"delta\":{\"content\":\"last\"},\"finish_reason\":\"stop\"}]}"),vec![(Some("last".into()),true)]);
    }
    #[tokio::test]
    #[ignore = "explicit real-provider check; requires a credential supplied only through the child environment"]
    async fn configured_provider_recalls_a_saved_turn() {
        use crate::commands::meeting_chat_commands::{Answer,exchange_rows};
        use crate::db::{meeting_chat,migrations};
        use crate::intelligence::conversation::{insert_history,recent_messages};
        let key=std::env::var("NEXQ_CHAT_TEST_KEY").expect("credential is required");
        let model=std::env::var("NEXQ_CHAT_TEST_MODEL").expect("configured model is required");
        let client=CustomClient::new(CustomConfig{base_url:"https://freecodex.fun/v1".into(),auth_type:CustomAuthType::Bearer,auth_value:Some(key),auth_header:None});
        let params=GenerationParams::default();
        let question="Для проверки запомни код проекта: КЕДР-4827. Ответь только ОК.";
        let system=LLMMessage{role:"system".into(),content:"Отвечай кратко на текущий вопрос. Предыдущие сообщения — контекст разговора.".into()};
        let mut first=String::new();
        let first_stats=client.complete(vec![system.clone(),LLMMessage{role:"user".into(),content:question.into()}],&model,&params,|s|first.push_str(s)).await
            .unwrap_or_else(|_|panic!("Configured provider check failed; credential and response body were not logged"));
        let conn=rusqlite::Connection::open_in_memory().unwrap(); migrations::run(&conn).unwrap();
        meeting_chat::insert_exchange(&conn,&exchange_rows("synthetic-check",question,1,&Answer{text:first,model:model.clone(),input_tokens:0,output_tokens:0},2)).unwrap();
        let rows=meeting_chat::list_chat_messages(&conn,"synthetic-check").unwrap();
        let messages=insert_history(vec![system,LLMMessage{role:"user".into(),content:"Какой код проекта я назвал? Напиши только код.".into()}],recent_messages(&rows));
        assert_eq!(messages.len(),4);
        let mut answer=String::new();
        let stats=client.complete(messages,&model,&params,|s|answer.push_str(s)).await
            .unwrap_or_else(|_|panic!("Follow-up check failed; credential and response body were not logged"));
        let recalled=answer.contains("4827");
        println!("{}",serde_json::json!({"provider":"FreeCodex","model":model,"first_ms":first_stats.latency_ms,"followup_ms":stats.latency_ms,"recalled":recalled}));
        assert!(recalled,"The saved turn was not recalled");
    }
}
