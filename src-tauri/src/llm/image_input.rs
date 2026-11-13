use base64::Engine;
use serde_json::{json, Value};
use super::provider::LLMMessage;

/// Private request attachment. Debug/logging must never dump a captured screen.
#[derive(Clone)]
pub struct ImageInput {
    data: String,
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for ImageInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageInput").field("width", &self.width).field("height", &self.height).finish_non_exhaustive()
    }
}

impl ImageInput {
    pub fn png(bytes: &[u8], width: u32, height: u32) -> Result<Self, String> {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len()>8*1024*1024 || width==0 || height==0 {
            return Err("Не удалось подготовить снимок экрана допустимого размера".into());
        }
        Ok(Self { data:base64::engine::general_purpose::STANDARD.encode(bytes),width,height })
    }
}

fn text_messages(messages: &[LLMMessage]) -> Vec<Value> {
    messages.iter().map(|m| json!({"role":m.role,"content":m.content})).collect()
}

pub fn rejection(status: u16) -> String {
    match status {
        401 | 403 => format!("Провайдер не разрешил запрос со снимком ({status}). Проверьте ключ и доступ к модели."),
        429 => "Провайдер ограничил частоту запросов со снимками. Повторите чуть позже.".into(),
        _ => format!("Провайдер отклонил снимок ({status}). Выберите модель с поддержкой изображений или повторите запрос."),
    }
}

pub fn openai_messages(messages: &[LLMMessage], image: Option<&ImageInput>) -> Vec<Value> {
    let mut output=text_messages(messages);
    if let (Some(image),Some(index))=(image,output.iter().rposition(|m|m["role"]=="user")) {
        let text=output[index]["content"].clone();
        output[index]["content"]=json!([
            {"type":"text","text":text},
            {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",image.data),"detail":"high"}}
        ]);
    }
    output
}

pub fn ollama_messages(messages: &[LLMMessage], image: Option<&ImageInput>) -> Vec<Value> {
    let mut output=text_messages(messages);
    if let (Some(image),Some(index))=(image,output.iter().rposition(|m|m["role"]=="user")) {
        output[index]["images"]=json!([image.data]);
    }
    output
}

pub fn attach_anthropic(messages: &mut [Value], image: Option<&ImageInput>) {
    if let (Some(image),Some(index))=(image,messages.iter().rposition(|m|m["role"]=="user")) {
        let text=messages[index]["content"].clone();
        messages[index]["content"]=json!([
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":image.data}},
            {"type":"text","text":text}
        ]);
    }
}

pub fn attach_gemini(contents: &mut [Value], image: Option<&ImageInput>) {
    if let (Some(image),Some(index))=(image,contents.iter().rposition(|m|m["role"]=="user")) {
        if let Some(parts)=contents[index]["parts"].as_array_mut() {
            parts.push(json!({"inlineData":{"mimeType":"image/png","data":image.data}}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->ImageInput { ImageInput::png(b"\x89PNG\r\n\x1a\nfixture",1,1).unwrap() }
    fn messages()->Vec<LLMMessage> { vec![LLMMessage{role:"user".into(),content:"Old question".into()},LLMMessage{role:"assistant".into(),content:"Old answer".into()},LLMMessage{role:"user".into(),content:"Look at the screen".into()}] }
    #[test]
    fn only_latest_user_message_gets_the_image_and_plain_requests_are_unchanged() {
        let input=messages(); let image=fixture();
        assert_eq!(openai_messages(&input,None),text_messages(&input));
        let result=openai_messages(&input,Some(&image));
        assert!(result[0]["content"].is_string()); assert!(result[1]["content"].is_string());
        assert_eq!(result[2]["content"][0]["text"],"Look at the screen");
        assert!(result[2]["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(!format!("{image:?}").contains(&image.data));
    }
    #[test]
    fn provider_formats_keep_the_same_image_and_original_text() {
        let image=fixture(); let input=messages();
        let ollama=ollama_messages(&input,Some(&image));
        assert_eq!(ollama[2]["content"],"Look at the screen"); assert_eq!(ollama[2]["images"][0],image.data);
        let mut anthropic=text_messages(&input); attach_anthropic(&mut anthropic,Some(&image));
        assert_eq!(anthropic[2]["content"][0]["source"]["media_type"],"image/png");
        let mut gemini=vec![json!({"role":"user","parts":[{"text":"Question"}]})]; attach_gemini(&mut gemini,Some(&image));
        assert_eq!(gemini[0]["parts"][1]["inlineData"]["data"],image.data);
    }
}
