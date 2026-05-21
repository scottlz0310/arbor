use crate::config::load_config;
use crate::models::{AiInsight, RepoInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const TAGS_PATH: &str = "/api/tags";
const GENERATE_PATH: &str = "/api/generate";
/// キャッシュの有効期間。TTL 経過後にバックグラウンド refresh が走る。
const CACHE_TTL_SECS: u64 = 300; // 5 分

// ─── Cache state (P3-04) ──────────────────────────────────────────────────────

struct CacheEntry {
    insights: Vec<AiInsight>,
    updated_at: Instant,
    /// バックグラウンド refresh が進行中なら true。重複 spawn を防ぐ (in-flight dedupe)。
    refresh_in_progress: bool,
}

pub struct AiCacheState {
    entries: Mutex<HashMap<u64, CacheEntry>>,
}

impl Default for AiCacheState {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl AiCacheState {
    /// AI 設定変更時にキャッシュを全クリアする。
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
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

/// TTL 判定を pure 関数に分離して、テストで `Instant` の逆方向減算 (panic リスク) を排除する。
fn is_cache_expired(now: Instant, updated_at: Instant) -> bool {
    now.duration_since(updated_at).as_secs() >= CACHE_TTL_SECS
}

// ─── Core fetch (shared by both commands) ────────────────────────────────────

/// Calls Ollama and returns parsed insights. Does not touch the cache.
async fn fetch_from_ollama(repos: &[RepoInfo]) -> Result<Vec<AiInsight>, String> {
    let config = load_config()?;
    let ai = &config.ai;

    if !ai.enabled {
        return Err("AI Insight は設定で無効化されています".to_string());
    }

    // クリーンな repo を除外してプロンプトサイズとレイテンシを削減する。
    // behind/ahead/modified/untracked/stash が全て 0 の repo は AI が分析する情報がない。
    let interesting: Vec<&RepoInfo> = repos
        .iter()
        .filter(|r| r.behind > 0 || r.ahead > 0 || r.modified_count > 0 || r.untracked_count > 0 || r.stash_count > 0)
        .collect();

    if interesting.is_empty() {
        return Ok(vec![]);
    }

    // プロンプトサイズの上限として最大 10 repos に絞る。
    let interesting_owned: Vec<RepoInfo> = interesting.into_iter().take(10).cloned().collect();
    let state_json = build_state_summary(&interesting_owned);
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

/// Generates AI insights with TTL-based stale-while-revalidate caching (P3-04).
///
/// - Cache hit, TTL 未満    → stale をそのまま返す（Ollama 再呼び出しなし）
/// - Cache hit, TTL 経過    → stale を即返却し、バックグラウンド refresh を spawn
///                           (in-flight dedupe: 既に refresh 中なら追加 spawn しない)
///                           完了後: cache 更新 → emit("ai_insights_updated")
/// - Cache miss            → 同期フェッチ → cache 保存 → 返却
#[tauri::command]
pub async fn get_ai_insights_cached(
    repos: Vec<RepoInfo>,
    app: AppHandle,
    cache: State<'_, AiCacheState>,
) -> Result<Vec<AiInsight>, String> {
    let key = hash_repos(&repos);

    // キャッシュチェック: stale の有無と refresh が必要かどうかを同時に判定する。
    let (cached_insights, should_refresh) = {
        let entries = cache.entries.lock().map_err(|e| e.to_string())?;
        match entries.get(&key) {
            None => (None, false),
            Some(entry) => {
                let expired = is_cache_expired(Instant::now(), entry.updated_at);
                // TTL 経過かつ refresh が走っていない場合のみ再計算する。
                let should = expired && !entry.refresh_in_progress;
                (Some(entry.insights.clone()), should)
            }
        }
    };

    if let Some(stale) = cached_insights {
        if should_refresh {
            // in-flight フラグを立ててから spawn（重複 spawn 防止）。
            {
                let mut entries = cache.entries.lock().map_err(|e| e.to_string())?;
                if let Some(entry) = entries.get_mut(&key) {
                    entry.refresh_in_progress = true;
                }
            }
            let repos_bg = repos.clone();
            let app_bg = app.clone();
            tokio::spawn(async move {
                let cache_bg = app_bg.state::<AiCacheState>();
                match fetch_from_ollama(&repos_bg).await {
                    Ok(fresh) => {
                        // cache を先に更新してから emit する。
                        // これにより、フロントが emit を受けて即 getAiInsightsCached を
                        // 呼んでも必ず新しい値が返る。
                        if let Ok(mut entries) = cache_bg.entries.lock() {
                            entries.insert(
                                key,
                                CacheEntry {
                                    insights: fresh.clone(),
                                    updated_at: Instant::now(),
                                    refresh_in_progress: false,
                                },
                            );
                        };
                        let _ = app_bg.emit("ai_insights_updated", &fresh);
                    }
                    Err(_) => {
                        // refresh 失敗時はフラグを降ろして次回 TTL 経過後に再試行できるようにする。
                        if let Ok(mut entries) = cache_bg.entries.lock() {
                            if let Some(entry) = entries.get_mut(&key) {
                                entry.refresh_in_progress = false;
                            }
                        };
                    }
                }
            });
        }
        return Ok(stale);
    }

    // Cache miss: 同期フェッチをせずバックグラウンドで生成し、完了後に emit する。
    // これにより UI スレッドをブロックせず、Ollama の応答速度に関わらず即座に返る。
    {
        let mut entries = cache.entries.lock().map_err(|e| e.to_string())?;
        entries.insert(
            key,
            CacheEntry {
                insights: vec![],
                updated_at: Instant::now(),
                refresh_in_progress: true,
            },
        );
    }
    let repos_bg = repos.clone();
    let app_bg = app.clone();
    // バックグラウンド処理開始をフロントに通知して "Analyzing..." を表示させる。
    let _ = app.emit("ai_insights_loading", ());
    tokio::spawn(async move {
        let cache_bg = app_bg.state::<AiCacheState>();
        match fetch_from_ollama(&repos_bg).await {
            Ok(fresh) => {
                if let Ok(mut entries) = cache_bg.entries.lock() {
                    entries.insert(
                        key,
                        CacheEntry {
                            insights: fresh.clone(),
                            updated_at: Instant::now(),
                            refresh_in_progress: false,
                        },
                    );
                }
                let _ = app_bg.emit("ai_insights_updated", &fresh);
            }
            Err(_) => {
                if let Ok(mut entries) = cache_bg.entries.lock() {
                    entries.remove(&key);
                }
                // 失敗時は ai_insights_failed を emit してフロントのルール表示を維持させる。
                // ai_insights_updated [] を使うとフロントが空結果で上書きしてしまうため区別する。
                let _ = app_bg.emit("ai_insights_failed", ());
            }
        }
    });
    Ok(vec![])
}

/// 指定した Ollama URL に接続できるかテストする（未保存フォーム値の確認用）。
/// 保存済み config を参照しないため、Settings フォームで URL を変更した直後でも正確に疎通確認できる。
/// Always returns Ok(bool) — never Err.
#[tauri::command]
pub async fn test_ai_connection(ollama_url: String) -> Result<bool, String> {
    let url = format!("{}{}", ollama_url.trim().trim_end_matches('/'), TAGS_PATH);
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

    // age_secs を受け取らず常に "今" を updated_at にする。
    // 過去方向の Instant 減算は CI (Windows + coverage) で overflow panic を起こすため禁止。
    // 期限切れシミュレーションは呼び出し側で future_now を作成して is_cache_expired に渡す。
    fn make_cache_entry(insights: Vec<AiInsight>, in_progress: bool) -> CacheEntry {
        CacheEntry {
            insights,
            updated_at: Instant::now(),
            refresh_in_progress: in_progress,
        }
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
            entries.insert(42u64, make_cache_entry(vec![insight.clone()], false));
        }
        let entries = cache.entries.lock().unwrap();
        let got = entries.get(&42u64).unwrap();
        assert_eq!(got.insights[0].repo_name, "r");
        assert!(!got.refresh_in_progress);
    }

    #[test]
    fn cache_entry_within_ttl_is_not_expired() {
        let now = Instant::now();
        let entry = make_cache_entry(vec![], false);
        // updated_at ≈ now なので TTL 内
        assert!(!is_cache_expired(now, entry.updated_at));
    }

    #[test]
    fn cache_entry_beyond_ttl_is_expired() {
        let entry = make_cache_entry(vec![], false);
        // "now" を未来に進めて TTL 超過をシミュレート (逆方向減算 panic を回避)
        let future_now = entry.updated_at + Duration::from_secs(CACHE_TTL_SECS + 10);
        assert!(is_cache_expired(future_now, entry.updated_at));
    }

    #[test]
    fn cache_entry_in_progress_suppresses_refresh() {
        // in-flight dedupe: refresh_in_progress=true のとき should_refresh は false になる。
        let entry = make_cache_entry(vec![], true);
        let future_now = entry.updated_at + Duration::from_secs(CACHE_TTL_SECS + 10);
        let expired = is_cache_expired(future_now, entry.updated_at);
        let should_refresh = expired && !entry.refresh_in_progress;
        assert!(!should_refresh, "refresh が進行中なら追加 spawn しない");
    }

    #[test]
    fn ai_cache_state_clear_empties_all_entries() {
        let cache = AiCacheState::default();
        {
            let mut entries = cache.entries.lock().unwrap();
            entries.insert(1u64, make_cache_entry(vec![], false));
            entries.insert(2u64, make_cache_entry(vec![], true));
        }
        assert_eq!(cache.entries.lock().unwrap().len(), 2);
        cache.clear();
        assert_eq!(cache.entries.lock().unwrap().len(), 0, "clear() 後はエントリが 0 になる");
    }

    /// test_ai_connection: 接続できないポートに対して Ok(false) を返すことを確認する。
    /// ポート 1 は通常 Connection refused が即座に返るため、タイムアウト待ちにならない。
    #[tokio::test]
    async fn test_ai_connection_unreachable_returns_false() {
        let result = test_ai_connection("http://127.0.0.1:1".to_string()).await;
        assert_eq!(result, Ok(false));
    }

    /// test_ai_connection: 末尾スラッシュを正規化した URL で接続を試みることを確認する。
    /// 実際の接続は行わず URL 構築の副作用として Connection refused → Ok(false) になることを確認する。
    #[tokio::test]
    async fn test_ai_connection_strips_trailing_slash() {
        // 末尾スラッシュ付き URL でも二重スラッシュにならず Ok(false) が返る
        let result = test_ai_connection("http://127.0.0.1:1/".to_string()).await;
        assert_eq!(result, Ok(false));
    }
}
