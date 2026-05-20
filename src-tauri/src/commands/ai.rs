use crate::config::load_config;
use crate::models::{AiInsight, RepoInfo};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TAGS_PATH: &str = "/api/tags";
const GENERATE_PATH: &str = "/api/generate";

// ─── Ollama API request / response types ─────────────────────────────────────

#[derive(Serialize)]
struct GenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Deserialize)]
struct GenerateResponse {
    response: String,
}

// ─── State Aggregator (P3-03) ─────────────────────────────────────────────────

/// Converts repository states into a compact JSON string for the prompt.
fn build_state_summary(repos: &[RepoInfo]) -> String {
    #[derive(Serialize)]
    struct RepoSummary<'a> {
        name: &'a str,
        branch: &'a str,
        ahead: u32,
        behind: u32,
        modified: u32,
        untracked: u32,
        stash_count: u32,
    }

    let summaries: Vec<RepoSummary> = repos
        .iter()
        .map(|r| RepoSummary {
            name: &r.name,
            branch: &r.current_branch,
            ahead: r.ahead,
            behind: r.behind,
            modified: r.modified_count,
            untracked: r.untracked_count,
            stash_count: r.stash_count,
        })
        .collect();

    serde_json::to_string(&summaries).unwrap_or_default()
}

// ─── Prompt builder (P3-06) ───────────────────────────────────────────────────

/// Builds the /no_think JSON-only prompt for Ollama.
fn build_prompt(state_json: &str) -> String {
    format!(
        "/no_think\n\
         You are a git repository health advisor. \
         Analyze the following repository states and return ONLY a JSON array — \
         no explanation, no markdown, no code fences. \
         Each element must have exactly these fields: \
         {{\"repo_name\": string, \"kind\": \"explain\"|\"prioritize\"|\"risk\", \
         \"message\": string, \"priority\": 0-3}}. \
         Repository states:\n{state_json}"
    )
}

// ─── Response parser ──────────────────────────────────────────────────────────

/// Strips optional code fences that some models add despite the prompt.
fn strip_code_fences(s: &str) -> &str {
    let s = s.trim();
    let stripped = s
        .strip_prefix("```json")
        .or_else(|| s.strip_prefix("```"))
        .and_then(|inner| inner.trim_start().strip_suffix("```"))
        .map(str::trim);
    stripped.unwrap_or(s)
}

fn parse_insights(raw: &str) -> Result<Vec<AiInsight>, String> {
    let json_str = strip_code_fences(raw);
    serde_json::from_str::<Vec<AiInsight>>(json_str)
        .map_err(|e| format!("AI レスポンスの JSON パースに失敗しました: {e}\nRaw: {raw}"))
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Returns true if Ollama is running and reachable (P3-01).
/// Always returns false (not an error) when Ollama is unreachable so the UI
/// can gracefully fall back to the rule-based engine.
#[tauri::command]
pub async fn ollama_available() -> Result<bool, String> {
    let config = load_config()?;
    if !config.ai.enabled {
        return Ok(false);
    }
    let url = format!("{}{}", config.ai.ollama_url, TAGS_PATH);
    let client = reqwest::Client::new();
    let reachable = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    Ok(reachable)
}

/// Generates AI insights for the given repositories via Ollama (P3-02).
/// Errors propagate to the frontend; the caller should fall back to the
/// rule-based engine on failure.
#[tauri::command]
pub async fn get_ai_insights(repos: Vec<RepoInfo>) -> Result<Vec<AiInsight>, String> {
    let config = load_config()?;
    let ai = &config.ai;

    if !ai.enabled {
        return Err("AI Insight は設定で無効化されています".to_string());
    }

    let state_json = build_state_summary(&repos);
    let prompt = build_prompt(&state_json);

    let url = format!("{}{}", ai.ollama_url, GENERATE_PATH);
    let client = reqwest::Client::new();
    let req_body = GenerateRequest {
        model: ai.model.clone(),
        prompt,
        stream: false,
    };

    let resp = client
        .post(&url)
        .json(&req_body)
        .timeout(Duration::from_secs(ai.timeout_secs))
        .send()
        .await
        .map_err(|e| format!("Ollama リクエストに失敗しました: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama エラー: HTTP {}", resp.status()));
    }

    let gen: GenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Ollama レスポンスのパースに失敗しました: {e}"))?;

    parse_insights(&gen.response)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RepoInfo;

    fn make_repo(name: &str, ahead: u32, behind: u32, modified: u32) -> RepoInfo {
        RepoInfo {
            path: format!("/repos/{name}"),
            name: name.to_string(),
            current_branch: "main".to_string(),
            ahead,
            behind,
            modified_count: modified,
            untracked_count: 0,
            stash_count: 0,
            github_owner: None,
            github_repo: None,
            last_fetched_at: None,
        }
    }

    #[test]
    fn build_state_summary_includes_repo_name() {
        let repos = vec![make_repo("myrepo", 2, 5, 3)];
        let s = build_state_summary(&repos);
        assert!(s.contains("myrepo"), "state summary should contain repo name: {s}");
        assert!(s.contains("\"ahead\":2"), "{s}");
        assert!(s.contains("\"behind\":5"), "{s}");
    }

    #[test]
    fn build_prompt_contains_no_think_prefix() {
        let prompt = build_prompt(r#"[{"name":"x"}]"#);
        assert!(prompt.starts_with("/no_think"), "prompt must start with /no_think");
        assert!(prompt.contains("JSON array"), "{prompt}");
    }

    #[test]
    fn strip_code_fences_removes_json_fence() {
        let raw = "```json\n[{\"a\":1}]\n```";
        assert_eq!(strip_code_fences(raw), "[{\"a\":1}]");
    }

    #[test]
    fn strip_code_fences_removes_generic_fence() {
        let raw = "```\n[]\n```";
        assert_eq!(strip_code_fences(raw), "[]");
    }

    #[test]
    fn strip_code_fences_no_fence_unchanged() {
        let raw = "[{\"repo_name\":\"x\",\"kind\":\"explain\",\"message\":\"ok\",\"priority\":1}]";
        assert_eq!(strip_code_fences(raw), raw);
    }

    #[test]
    fn parse_insights_valid_json() {
        let raw = r#"[{"repo_name":"repo1","kind":"risk","message":"diverged","priority":3}]"#;
        let insights = parse_insights(raw).unwrap();
        assert_eq!(insights.len(), 1);
        assert_eq!(insights[0].repo_name, "repo1");
        assert_eq!(insights[0].kind, "risk");
        assert_eq!(insights[0].priority, 3);
    }

    #[test]
    fn parse_insights_with_fence() {
        let raw = "```json\n[{\"repo_name\":\"r\",\"kind\":\"explain\",\"message\":\"ok\",\"priority\":0}]\n```";
        let insights = parse_insights(raw).unwrap();
        assert_eq!(insights.len(), 1);
        assert_eq!(insights[0].repo_name, "r");
    }

    #[test]
    fn parse_insights_invalid_json_returns_err() {
        let err = parse_insights("not json at all").unwrap_err();
        assert!(err.contains("JSON パース"), "{err}");
    }
}
