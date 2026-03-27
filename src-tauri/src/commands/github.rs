use crate::commands::config_cmd::load_github_pat;
use crate::models::{CheckRun, Issue, PullRequest};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::sync::OnceLock;

const GITHUB_API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";

// ─── Shared HTTP client ───────────────────────────────────────────────────────

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn get_client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Arbor/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client build should never fail")
    })
}

// ─── URL builder ─────────────────────────────────────────────────────────────

/// Builds a GitHub API URL with properly percent-encoded path segments.
fn api_url(path_parts: &[&str], params: &[(&str, &str)]) -> Result<Url, String> {
    let mut url = Url::parse(GITHUB_API).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "URL path build error".to_string())?
        .extend(path_parts);
    if !params.is_empty() {
        url.query_pairs_mut().extend_pairs(params.iter().copied());
    }
    Ok(url)
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

fn check_status(status: StatusCode) -> Result<(), String> {
    if status == StatusCode::UNAUTHORIZED {
        return Err(
            "GitHub PAT が無効です。Settings から PAT を更新してください。".to_string(),
        );
    }
    if status == StatusCode::NOT_FOUND {
        return Err(
            "リポジトリが見つかりません。owner / repo 名を確認してください。".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!("GitHub API エラー: HTTP {status}"));
    }
    Ok(())
}

/// Fetches all pages from an endpoint that returns a JSON array.
/// Follows `Link: rel="next"` headers until exhausted.
async fn get_all_pages<T: for<'de> Deserialize<'de>>(
    first_url: Url,
    pat: &str,
) -> Result<Vec<T>, String> {
    let mut results: Vec<T> = Vec::new();
    let mut next: Option<String> = Some(first_url.to_string());

    while let Some(url) = next {
        let resp = get_client()
            .get(&url)
            .header("Authorization", format!("Bearer {pat}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION)
            .send()
            .await
            .map_err(|e| format!("GitHub API リクエストに失敗しました: {e}"))?;

        check_status(resp.status())?;

        next = parse_next_link(resp.headers());

        let mut page: Vec<T> = resp
            .json()
            .await
            .map_err(|e| format!("GitHub API レスポンスのパースに失敗しました: {e}"))?;
        results.append(&mut page);
    }

    Ok(results)
}

/// Fetches a single response (non-array wrapper objects like CheckRunsResponse).
async fn get_once<T: for<'de> Deserialize<'de>>(url: Url, pat: &str) -> Result<T, String> {
    let resp = get_client()
        .get(url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("GitHub API リクエストに失敗しました: {e}"))?;

    check_status(resp.status())?;

    resp.json::<T>()
        .await
        .map_err(|e| format!("GitHub API レスポンスのパースに失敗しました: {e}"))
}

/// Parses the URL of the next page from a `Link` response header.
pub(crate) fn parse_next_link(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get("link")?.to_str().ok()?;
    // Format: <https://...?page=2>; rel="next", <...>; rel="last"
    for part in link.split(',') {
        let part = part.trim();
        if part.contains(r#"rel="next""#) {
            if let Some(url_part) = part.split(';').next() {
                let url = url_part.trim().trim_start_matches('<').trim_end_matches('>');
                return Some(url.to_string());
            }
        }
    }
    None
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

/// Returns pull requests for the given repository (all pages).
/// `state`: "open" | "closed" | "all"  (defaults to "open")
#[tauri::command]
pub async fn get_pull_requests(
    owner: String,
    repo: String,
    state: Option<String>,
) -> Result<Vec<PullRequest>, String> {
    let pat = load_github_pat()?;
    let state = state.as_deref().unwrap_or("open");
    let url = api_url(
        &["repos", &owner, &repo, "pulls"],
        &[("state", state), ("per_page", "100")],
    )?;
    let raw: Vec<RawPullRequest> = get_all_pages(url, &pat).await?;
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

/// Returns issues for the given repository (all pages; pull requests are excluded).
/// `state`: "open" | "closed" | "all"  (defaults to "open")
#[tauri::command]
pub async fn get_issues(
    owner: String,
    repo: String,
    state: Option<String>,
) -> Result<Vec<Issue>, String> {
    let pat = load_github_pat()?;
    let state = state.as_deref().unwrap_or("open");
    let url = api_url(
        &["repos", &owner, &repo, "issues"],
        &[("state", state), ("per_page", "100")],
    )?;
    let raw: Vec<RawIssue> = get_all_pages(url, &pat).await?;
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
/// Branch names containing `/` are correctly percent-encoded in the URL path.
#[tauri::command]
pub async fn get_check_runs(
    owner: String,
    repo: String,
    git_ref: String,
) -> Result<Vec<CheckRun>, String> {
    let pat = load_github_pat()?;
    let url = api_url(
        &["repos", &owner, &repo, "commits", &git_ref, "check-runs"],
        &[("per_page", "100")],
    )?;
    let raw: CheckRunsResponse = get_once(url, &pat).await?;
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

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue, LINK};

    // ── api_url ──────────────────────────────────────────────────────────────

    #[test]
    fn api_url_simple_path() {
        let url = api_url(&["repos", "owner", "repo", "pulls"], &[("state", "open")])
            .expect("should build");
        assert_eq!(
            url.as_str(),
            "https://api.github.com/repos/owner/repo/pulls?state=open"
        );
    }

    #[test]
    fn api_url_encodes_slash_in_git_ref() {
        // Branch names like "feature/foo" must be percent-encoded as path segments.
        let url = api_url(
            &["repos", "owner", "repo", "commits", "feature/foo", "check-runs"],
            &[("per_page", "100")],
        )
        .expect("should build");
        assert!(
            url.as_str().contains("feature%2Ffoo"),
            "slash in branch name should be encoded: {url}"
        );
    }

    #[test]
    fn api_url_no_query_params() {
        let url = api_url(&["repos", "owner", "repo", "pulls"], &[]).expect("should build");
        assert_eq!(url.as_str(), "https://api.github.com/repos/owner/repo/pulls");
    }

    #[test]
    fn api_url_multiple_params() {
        let url = api_url(
            &["repos", "o", "r", "issues"],
            &[("state", "all"), ("per_page", "100")],
        )
        .expect("should build");
        let s = url.as_str();
        assert!(s.contains("state=all"), "{s}");
        assert!(s.contains("per_page=100"), "{s}");
    }

    // ── check_status ─────────────────────────────────────────────────────────

    #[test]
    fn check_status_ok() {
        assert!(check_status(StatusCode::OK).is_ok());
        assert!(check_status(StatusCode::CREATED).is_ok());
    }

    #[test]
    fn check_status_unauthorized() {
        let err = check_status(StatusCode::UNAUTHORIZED).unwrap_err();
        assert!(err.contains("PAT"), "expected PAT mention: {err}");
    }

    #[test]
    fn check_status_not_found() {
        let err = check_status(StatusCode::NOT_FOUND).unwrap_err();
        assert!(err.contains("リポジトリ"), "expected repo mention: {err}");
    }

    #[test]
    fn check_status_other_error() {
        let err = check_status(StatusCode::INTERNAL_SERVER_ERROR).unwrap_err();
        assert!(err.contains("500"), "expected HTTP status code: {err}");
    }

    // ── parse_next_link ───────────────────────────────────────────────────────

    fn make_link_header(value: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(LINK, HeaderValue::from_str(value).unwrap());
        map
    }

    #[test]
    fn parse_next_link_returns_next_url() {
        let headers = make_link_header(
            r#"<https://api.github.com/repos/o/r/pulls?page=2>; rel="next", <https://api.github.com/repos/o/r/pulls?page=5>; rel="last""#,
        );
        let next = parse_next_link(&headers);
        assert_eq!(
            next.as_deref(),
            Some("https://api.github.com/repos/o/r/pulls?page=2")
        );
    }

    #[test]
    fn parse_next_link_no_next_returns_none() {
        let headers = make_link_header(
            r#"<https://api.github.com/repos/o/r/pulls?page=1>; rel="prev""#,
        );
        assert!(parse_next_link(&headers).is_none());
    }

    #[test]
    fn parse_next_link_absent_header_returns_none() {
        assert!(parse_next_link(&HeaderMap::new()).is_none());
    }

    #[test]
    fn parse_next_link_last_page_only() {
        // Only "last" present (single-page response has no "next").
        let headers = make_link_header(
            r#"<https://api.github.com/repos/o/r/pulls?page=1>; rel="last""#,
        );
        assert!(parse_next_link(&headers).is_none());
    }
}
