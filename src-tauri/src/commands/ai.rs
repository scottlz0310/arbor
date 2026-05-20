use crate::config::load_config;
use crate::models::{AiInsight, RepoInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const TAGS_PATH: &str = "/api/tags";
const GENERATE_PATH: &str = "/api/generate";

// ─── Cache state (P3-04) ──────────────────────────────────────────────────────

pub struct AiCacheState {
    entries: Mutex<HashMap<u64, Vec<AiInsight>>>,
}

impl Default for AiCacheState {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

fn hash_repos(repos: &[RepoInfo]) -> u64 {
    let summary = build_state_summary(repos);
    let mut hasher = DefaultHasher::new();
    summary.hash(&mut hasher);
    hasher.finish()
}

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
    let insights: Vec<AiInsight> = serde_json::from_str(json_str)
        .map_err(|e| format!("AI レスポンスの JSON パースに失敗しました: {e}\nRaw: {raw}"))?;
    for insight in &insights {
        if insight.priority > 3 {
            return Err(format!(
                "AI レスポンスに無効な priority {} が含まれています (許容範囲: 0–3)",
                insight.priority
            ));
        }
    }
    Ok(insights)
}

fn ollama_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

// ─── Core fetch (shared by both commands) ────────────────────────────────────

/// Calls Ollama and returns parsed insights. Does not touch the cache.
async fn fetch_from_ollama(repos: &[RepoInfo]) -> Result<Vec<AiInsight>, String> {
    let config = load_config()?;
    let ai = &config.ai;

    if !ai.enabled {
        return Err("AI Insight は設定で無効化されています".to_string());
    }

    let state_json = build_state_summary(repos);
    let prompt = build_prompt(&state_json);
    let url = ollama_url(&ai.ollama_url, GENERATE_PATH);

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

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Returns true if Ollama is running and reachable (P3-01).
/// Always returns Ok(false) — never Err — so callers can use this as a
/// pure availability probe without error handling before the fallback path.
#[tauri::command]
pub async fn ollama_available() -> Result<bool, String> {
    let config = match load_config() {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    if !config.ai.enabled {
        return Ok(false);
    }
    let url = ollama_url(&config.ai.ollama_url, TAGS_PATH);
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

/// Generates AI insights via Ollama without caching (P3-02).
/// Errors propagate to the frontend; caller should fall back to the rule-based engine.
#[tauri::command]
pub async fn get_ai_insights(repos: Vec<RepoInfo>) -> Result<Vec<AiInsight>, String> {
    fetch_from_ollama(&repos).await
}

/// Generates AI insights with stale-while-revalidate caching (P3-04).
///
/// - Cache hit  → returns the cached value immediately, then spawns a background
///               refresh that emits `"ai_insights_updated"` when done.
/// - Cache miss → fetches synchronously, stores the result, and returns it.
#[tauri::command]
pub async fn get_ai_insights_cached(
    repos: Vec<RepoInfo>,
    app: AppHandle,
    cache: State<'_, AiCacheState>,
) -> Result<Vec<AiInsight>, String> {
    let key = hash_repos(&repos);

    let cached = {
        let entries = cache.entries.lock().map_err(|e| e.to_string())?;
        entries.get(&key).cloned()
    };

    if let Some(stale) = cached {
        // Return stale immediately, refresh in background.
        let repos_bg = repos.clone();
        let app_bg = app.clone();
        tokio::spawn(async move {
            if let Ok(fresh) = fetch_from_ollama(&repos_bg).await {
                let _ = app_bg.emit("ai_insights_updated", &fresh);
                let cache_bg = app_bg.state::<AiCacheState>();
                if let Ok(mut entries) = cache_bg.entries.lock() {
                    entries.insert(key, fresh);
                };
            }
        });
        return Ok(stale);
    }

    // Cache miss: fetch synchronously.
    let insights = fetch_from_ollama(&repos).await?;
    {
        let mut entries = cache.entries.lock().map_err(|e| e.to_string())?;
        entries.insert(key, insights.clone());
    }
    Ok(insights)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{InsightKind, RepoInfo};

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
        assert_eq!(insights[0].kind, InsightKind::Risk);
        assert_eq!(insights[0].priority, 3);
    }

    #[test]
    fn parse_insights_with_fence() {
        let raw = "```json\n[{\"repo_name\":\"r\",\"kind\":\"explain\",\"message\":\"ok\",\"priority\":0}]\n```";
        let insights = parse_insights(raw).unwrap();
        assert_eq!(insights.len(), 1);
        assert_eq!(insights[0].repo_name, "r");
        assert_eq!(insights[0].kind, InsightKind::Explain);
    }

    #[test]
    fn parse_insights_invalid_json_returns_err() {
        let err = parse_insights("not json at all").unwrap_err();
        assert!(err.contains("JSON パース"), "{err}");
    }

    #[test]
    fn parse_insights_invalid_kind_returns_err() {
        let raw = r#"[{"repo_name":"r","kind":"warning","message":"x","priority":1}]"#;
        let err = parse_insights(raw).unwrap_err();
        assert!(err.contains("JSON パース"), "{err}");
    }

    #[test]
    fn parse_insights_priority_out_of_range_returns_err() {
        let raw = r#"[{"repo_name":"r","kind":"risk","message":"x","priority":99}]"#;
        let err = parse_insights(raw).unwrap_err();
        assert!(err.contains("priority"), "{err}");
    }

    #[test]
    fn ollama_url_trims_trailing_slash() {
        assert_eq!(
            ollama_url("http://localhost:11434/", TAGS_PATH),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            ollama_url("http://localhost:11434", GENERATE_PATH),
            "http://localhost:11434/api/generate"
        );
    }

    #[test]
    fn hash_repos_same_input_gives_same_hash() {
        let repos = vec![make_repo("a", 1, 2, 3), make_repo("b", 0, 0, 0)];
        assert_eq!(hash_repos(&repos), hash_repos(&repos));
    }

    #[test]
    fn hash_repos_different_input_gives_different_hash() {
        let r1 = vec![make_repo("a", 1, 0, 0)];
        let r2 = vec![make_repo("a", 2, 0, 0)]; // ahead changed
        assert_ne!(hash_repos(&r1), hash_repos(&r2));
    }

    #[test]
    fn ai_cache_state_stores_and_retrieves() {
        let cache = AiCacheState::default();
        let insight = AiInsight {
            repo_name: "r".to_string(),
            kind: InsightKind::Explain,
            message: "ok".to_string(),
            priority: 1,
        };
        {
            let mut entries = cache.entries.lock().unwrap();
            entries.insert(42u64, vec![insight.clone()]);
        }
        let entries = cache.entries.lock().unwrap();
        let got = entries.get(&42u64).unwrap();
        assert_eq!(got[0].repo_name, "r");
    }
}
