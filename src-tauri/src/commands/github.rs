use crate::commands::config_cmd::load_github_pat;
use crate::models::{CheckRun, Issue, PullRequest};
use serde::Deserialize;

const GITHUB_API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async fn get<T: for<'de> Deserialize<'de>>(url: &str, pat: &str) -> Result<T, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Arbor/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("HTTP クライアントの初期化に失敗しました: {e}"))?;

    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("GitHub API リクエストに失敗しました: {e}"))?;

    let status = resp.status();
    if status == 401 {
        return Err(
            "GitHub PAT が無効です。Settings から PAT を更新してください。".to_string(),
        );
    }
    if status == 404 {
        return Err(
            "リポジトリが見つかりません。owner / repo 名を確認してください。".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("GitHub API エラー: HTTP {status}"));
    }

    resp.json::<T>()
        .await
        .map_err(|e| format!("GitHub API レスポンスのパースに失敗しました: {e}"))
}

// ─── get_pull_requests (P2-02) ────────────────────────────────────────────────

#[derive(Deserialize)]
struct RawPullRequest {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    user: RawUser,
    created_at: String,
    updated_at: String,
    draft: bool,
    merged_at: Option<String>,
    head: RawRef,
    base: RawRef,
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
}

#[derive(Deserialize)]
struct RawRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

/// Returns pull requests for the given repository.
/// `state`: "open" | "closed" | "all"  (defaults to "open")
#[tauri::command]
pub async fn get_pull_requests(
    owner: String,
    repo: String,
    state: Option<String>,
) -> Result<Vec<PullRequest>, String> {
    let pat = load_github_pat()?;
    let state = state.as_deref().unwrap_or("open");
    let url = format!(
        "{GITHUB_API}/repos/{owner}/{repo}/pulls?state={state}&per_page=100"
    );
    let raw: Vec<RawPullRequest> = get(&url, &pat).await?;
    Ok(raw
        .into_iter()
        .map(|r| PullRequest {
            number: r.number,
            title: r.title,
            state: r.state,
            html_url: r.html_url,
            user_login: r.user.login,
            created_at: r.created_at,
            updated_at: r.updated_at,
            draft: r.draft,
            merged_at: r.merged_at,
            head_ref: r.head.ref_name,
            base_ref: r.base.ref_name,
        })
        .collect())
}

// ─── get_issues (P2-03) ──────────────────────────────────────────────────────

/// The `/issues` endpoint also returns PRs; filter them out via `pull_request`.
#[derive(Deserialize)]
struct RawIssue {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    user: RawUser,
    created_at: String,
    updated_at: String,
    body: Option<String>,
    labels: Vec<RawLabel>,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawLabel {
    name: String,
}

/// Returns issues for the given repository (pull requests are excluded).
/// `state`: "open" | "closed" | "all"  (defaults to "open")
#[tauri::command]
pub async fn get_issues(
    owner: String,
    repo: String,
    state: Option<String>,
) -> Result<Vec<Issue>, String> {
    let pat = load_github_pat()?;
    let state = state.as_deref().unwrap_or("open");
    let url = format!(
        "{GITHUB_API}/repos/{owner}/{repo}/issues?state={state}&per_page=100"
    );
    let raw: Vec<RawIssue> = get(&url, &pat).await?;
    Ok(raw
        .into_iter()
        .filter(|r| r.pull_request.is_none())
        .map(|r| Issue {
            number: r.number,
            title: r.title,
            state: r.state,
            html_url: r.html_url,
            user_login: r.user.login,
            created_at: r.created_at,
            updated_at: r.updated_at,
            body: r.body,
            labels: r.labels.into_iter().map(|l| l.name).collect(),
        })
        .collect())
}

// ─── get_check_runs (P2-04) ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckRunsResponse {
    check_runs: Vec<RawCheckRun>,
}

#[derive(Deserialize)]
struct RawCheckRun {
    id: u64,
    name: String,
    status: String,
    conclusion: Option<String>,
    html_url: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

/// Returns check runs for the given commit ref (branch name or SHA).
#[tauri::command]
pub async fn get_check_runs(
    owner: String,
    repo: String,
    git_ref: String,
) -> Result<Vec<CheckRun>, String> {
    let pat = load_github_pat()?;
    let url = format!(
        "{GITHUB_API}/repos/{owner}/{repo}/commits/{git_ref}/check-runs?per_page=100"
    );
    let raw: CheckRunsResponse = get(&url, &pat).await?;
    Ok(raw
        .check_runs
        .into_iter()
        .map(|r| CheckRun {
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            html_url: r.html_url,
            started_at: r.started_at,
            completed_at: r.completed_at,
        })
        .collect())
}
