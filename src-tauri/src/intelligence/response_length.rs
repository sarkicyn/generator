pub const BRIEF_RESPONSE: &str = include_str!("../../../src/lib/briefResponse.txt");

/// Interactive answers obey length even when custom instructions are disabled.
/// Structured extraction and full saved-meeting reports keep their own formats.
pub fn uses_brief_response(mode: &str, length: Option<&str>) -> bool {
    length == Some("brief") && !matches!(mode, "MeetingSummary" | "ActionItemsExtraction" | "BookmarkSuggestions")
}

pub fn with_brief_response(prompt: String, brief: bool) -> String {
    if brief { format!("{prompt}\n\n{}", BRIEF_RESPONSE.trim()) } else { prompt }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_interactive_entry_points_get_brief_but_structured_reports_do_not() {
        for mode in ["Assist", "AskQuestion", "WhatToSay", "Shorten", "Recap", "FollowUp", "MeetingAsk", "custom_1"] {
            assert!(uses_brief_response(mode, Some("brief")));
            assert!(!uses_brief_response(mode, Some("detailed")));
            assert!(!uses_brief_response(mode, None));
        }
        for mode in ["MeetingSummary", "ActionItemsExtraction", "BookmarkSuggestions"] {
            assert!(!uses_brief_response(mode, Some("brief")));
        }
    }
    #[test]
    fn brief_takes_precedence_without_cutting_context_or_questions() {
        let base = "Be thorough. Topic: GC. Current request: stack and heap?";
        let result = with_brief_response(base.into(), true);
        assert!(result.starts_with(base));
        assert!(result.ends_with(BRIEF_RESPONSE.trim()));
        assert_eq!(with_brief_response(base.into(), false), base);
    }
}
