use std::time::Instant;

/// Format time as "MM:SS" or "H:MM:SS".
pub fn format_elapsed(start: Instant) -> String {
    let secs = start.elapsed().as_secs();
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// Build tooltip text based on current state.
pub fn build_tooltip(
    state: super::TrayState,
    meeting_start: Option<Instant>,
    is_muted: bool,
    custom_text: Option<&str>,
) -> String {
    use super::TrayState;

    match state {
        TrayState::Idle => {
            if let Some(text) = custom_text {
                format!("NexQ — Ожидание · {}", text)
            } else {
                "NexQ — Ожидание".to_string()
            }
        }
        TrayState::Recording => {
            let elapsed = meeting_start
                .map(|s| format_elapsed(s))
                .unwrap_or_else(|| "00:00".to_string());
            if is_muted {
                format!("NexQ — Встреча (микрофон выключен) · {}", elapsed)
            } else {
                format!("NexQ — Встреча · {}", elapsed)
            }
        }
        TrayState::Muted => {
            let elapsed = meeting_start
                .map(|s| format_elapsed(s))
                .unwrap_or_else(|| "00:00".to_string());
            format!("NexQ — Встреча (микрофон выключен) · {}", elapsed)
        }
        TrayState::Stealth => {
            let elapsed = meeting_start
                .map(|s| format_elapsed(s))
                .unwrap_or_else(|| "00:00".to_string());
            format!("NexQ — Встреча (окно скрыто) · {}", elapsed)
        }
        TrayState::AiProcessing => "NexQ — ИИ обрабатывает запрос…".to_string(),
        TrayState::Indexing => {
            if let Some(text) = custom_text {
                format!("NexQ — {}", text)
            } else {
                "NexQ — Индексация файлов…".to_string()
            }
        }
    }
}
