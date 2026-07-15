use crate::config::load_config;
use crate::models::{
    CandidateKind, CleanupCandidate, CleanupOperation, CleanupPreview, RemoteFetchError,
    RepoCleanupPreview, SafetyBlock, UpstreamState,
};
use git2::{BranchType, Direction, Repository};
use std::collections::{HashMap, HashSet};

// ─── cleanup_preview ─────────────────────────────────────────────────────────

/// 登録済み全 repo を横断して Cleanup 候補を列挙する。
/// 読み取り専用: ローカル ref・remote-tracking ref を一切変更しない。
/// 全 repo × 全 remote へ順に接続するため応答が遅い remote で長時間ブロックし得る。
/// main thread を塞いで UI をフリーズさせないよう async 指定で別スレッド実行にする。
#[tauri::command(async)]
pub fn cleanup_preview() -> Result<CleanupPreview, String> {
    let config = load_config()?;
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let repos = config
        .repositories
        .iter()
        .map(|rc| {
            let params = PreviewParams {
                stale_threshold_days: config.settings.stale_threshold_days,
                protected_branches: &rc.protected_branches,
                now_ts,
            };
            preview_repo(&rc.path, &rc.name, &params)
        })
        .collect();

    Ok(CleanupPreview {
        repos,
        generated_at: now_ts,
    })
}

// ─── preview_repo ────────────────────────────────────────────────────────────

pub(crate) struct PreviewParams<'a> {
    pub stale_threshold_days: u32,
    pub protected_branches: &'a [String],
    /// 判定基準時刻 (Unix秒)。テストから注入できるよう引数化している。
    pub now_ts: i64,
}

/// 1 repo 分の候補列挙。失敗しても panic せず `error` 付きの結果を返し、
/// 他 repo の preview を継続できるようにする。
pub(crate) fn preview_repo(
    repo_path: &str,
    repo_name: &str,
    params: &PreviewParams<'_>,
) -> RepoCleanupPreview {
    match preview_repo_inner(repo_path, repo_name, params) {
        Ok(preview) => preview,
        Err(e) => RepoCleanupPreview {
            repo_path: repo_path.to_string(),
            repo_name: repo_name.to_string(),
            candidates: Vec::new(),
            remote_errors: Vec::new(),
            error: Some(e),
        },
    }
}

fn preview_repo_inner(
    repo_path: &str,
    repo_name: &str,
    params: &PreviewParams<'_>,
) -> Result<RepoCleanupPreview, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("open {repo_path}: {e}"))?;

    let remote_names = list_remote_names(&repo)?;

    // remote-tracking ref の prune 候補判定前に remote の最新状態を取得する。
    // fetch ではなく ls-remote 相当 (connect + list) を使うことで、
    // preview がローカル ref を変更しないことを保証する。
    let mut live_heads: HashMap<String, HashSet<String>> = HashMap::new();
    let mut remote_default_branches: HashMap<String, String> = HashMap::new();
    let mut remote_errors = Vec::new();
    for remote in &remote_names {
        match list_remote_heads(&repo, remote) {
            Ok((heads, default_branch)) => {
                live_heads.insert(remote.clone(), heads);
                if let Some(db) = default_branch {
                    remote_default_branches.insert(remote.clone(), db);
                }
            }
            Err(error) => remote_errors.push(RemoteFetchError {
                remote: remote.clone(),
                error,
            }),
        }
    }

    let default_branch = detect_default_branch(&repo, &remote_default_branches);
    let ctx = RepoContext {
        repo: &repo,
        repo_path,
        repo_name,
        params,
        merged_basis_oid: merged_basis_oid(&repo, default_branch.as_deref()),
        default_branch,
        worktree_branches: worktree_checked_out_branches(&repo),
    };

    let mut candidates = ctx.local_candidates()?;
    candidates.extend(ctx.remote_tracking_candidates(&remote_names, &live_heads)?);
    candidates.sort_by(|a, b| {
        (a.operation as u8)
            .cmp(&(b.operation as u8))
            .then_with(|| a.ref_name.cmp(&b.ref_name))
    });

    Ok(RepoCleanupPreview {
        repo_path: repo_path.to_string(),
        repo_name: repo_name.to_string(),
        candidates,
        remote_errors,
        error: None,
    })
}

// ─── RepoContext ─────────────────────────────────────────────────────────────

/// 候補判定に必要な repo 単位の状態をまとめたコンテキスト。
struct RepoContext<'a> {
    repo: &'a Repository,
    repo_path: &'a str,
    repo_name: &'a str,
    params: &'a PreviewParams<'a>,
    /// merged 判定の基準 commit。default branch tip、無ければ HEAD。
    merged_basis_oid: Option<git2::Oid>,
    default_branch: Option<String>,
    worktree_branches: HashSet<String>,
}

impl RepoContext<'_> {
    /// tip が merged 判定基準に取り込み済み (基準と同一 commit または祖先) かを返す。
    /// fast-forward マージ直後 (tip == 基準 commit) も merged として扱う。
    fn is_merged_into_basis(&self, tip: git2::Oid) -> bool {
        match self.merged_basis_oid {
            Some(basis) => {
                basis == tip || self.repo.graph_descendant_of(basis, tip).unwrap_or(false)
            }
            None => false,
        }
    }

    fn local_candidates(&self) -> Result<Vec<CleanupCandidate>, String> {
        let mut candidates = Vec::new();
        for item in self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| e.to_string())?
        {
            let (branch, _) = item.map_err(|e| e.to_string())?;
            let name = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };
            let commit = match branch.get().peel_to_commit() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let tip = commit.id();

            // 基準 branch (default branch) 自身と checkout 中の branch は merged 扱いにしない。
            let is_merged = !branch.is_head()
                && self.default_branch.as_deref() != Some(name.as_str())
                && self.is_merged_into_basis(tip);
            let (upstream, remote_name) = upstream_state(self.repo, &name);
            let age_secs = self.params.now_ts - commit.time().seconds();
            let stale_secs = i64::from(self.params.stale_threshold_days) * 86_400;

            let Some(kind) = classify_local(is_merged, upstream, age_secs, stale_secs) else {
                continue;
            };

            let mut blocked = Vec::new();
            if branch.is_head() {
                blocked.push(SafetyBlock::CurrentBranch);
            }
            if self.default_branch.as_deref() == Some(name.as_str()) {
                blocked.push(SafetyBlock::DefaultBranch);
            }
            if self.params.protected_branches.contains(&name) {
                blocked.push(SafetyBlock::ProtectedBranch);
            }
            if self.worktree_branches.contains(&name) {
                blocked.push(SafetyBlock::WorktreeCheckedOut);
            }

            candidates.push(CleanupCandidate {
                repo_path: self.repo_path.to_string(),
                repo_name: self.repo_name.to_string(),
                ref_name: name,
                operation: CleanupOperation::DeleteLocalBranch,
                kind,
                remote_name,
                oid: tip.to_string(),
                last_commit_ts: commit.time().seconds(),
                is_merged,
                upstream,
                stale_days: (kind == CandidateKind::Stale)
                    .then_some((age_secs / 86_400) as u32),
                blocked,
            });
        }
        Ok(candidates)
    }

    /// remote 上に存在しなくなった remote-tracking ref を prune 候補として列挙する。
    /// 接続に失敗した remote の ref は安全のため候補にしない。
    fn remote_tracking_candidates(
        &self,
        remote_names: &[String],
        live_heads: &HashMap<String, HashSet<String>>,
    ) -> Result<Vec<CleanupCandidate>, String> {
        let mut candidates = Vec::new();
        for item in self
            .repo
            .branches(Some(BranchType::Remote))
            .map_err(|e| e.to_string())?
        {
            let (branch, _) = item.map_err(|e| e.to_string())?;
            let short = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };
            let Some((remote, branch_part)) = split_remote_ref(&short, remote_names) else {
                continue;
            };
            if branch_part == "HEAD" {
                continue;
            }
            // 接続失敗した remote は live 状態が不明のため候補提示しない。
            let Some(heads) = live_heads.get(remote) else {
                continue;
            };
            // remote 上に現存する ref は stale ではない。
            if heads.contains(branch_part) {
                continue;
            }
            let commit = match branch.get().peel_to_commit() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let tip = commit.id();
            let is_merged = self.is_merged_into_basis(tip);

            let mut blocked = Vec::new();
            if self.default_branch.as_deref() == Some(branch_part) {
                blocked.push(SafetyBlock::DefaultBranch);
            }
            if self
                .params
                .protected_branches
                .iter()
                .any(|p| p == branch_part || p == &short)
            {
                blocked.push(SafetyBlock::ProtectedBranch);
            }

            candidates.push(CleanupCandidate {
                repo_path: self.repo_path.to_string(),
                repo_name: self.repo_name.to_string(),
                remote_name: Some(remote.to_string()),
                ref_name: short,
                operation: CleanupOperation::PruneRemoteTrackingRef,
                kind: CandidateKind::StaleRemoteTracking,
                oid: tip.to_string(),
                last_commit_ts: commit.time().seconds(),
                is_merged,
                upstream: UpstreamState::None,
                stale_days: None,
                blocked,
            });
        }
        Ok(candidates)
    }
}

// ─── 判定ヘルパー ─────────────────────────────────────────────────────────────

/// local branch の候補カテゴリを判定する。優先度: merged > upstream 消失 > stale。
/// いずれにも該当しなければ候補にしない (None)。
fn classify_local(
    is_merged: bool,
    upstream: UpstreamState,
    age_secs: i64,
    stale_threshold_secs: i64,
) -> Option<CandidateKind> {
    if is_merged {
        Some(CandidateKind::Merged)
    } else if upstream == UpstreamState::Gone {
        Some(CandidateKind::UpstreamGone)
    } else if age_secs > stale_threshold_secs {
        Some(CandidateKind::Stale)
    } else {
        None
    }
}

/// branch の upstream 状態と、その upstream が属する remote 名を返す。
fn upstream_state(repo: &Repository, branch_name: &str) -> (UpstreamState, Option<String>) {
    let refname = format!("refs/heads/{branch_name}");
    let Ok(upstream_buf) = repo.branch_upstream_name(&refname) else {
        return (UpstreamState::None, None);
    };
    let Ok(upstream_ref) = upstream_buf.as_str() else {
        return (UpstreamState::None, None);
    };
    let remote = repo
        .branch_remote_name(upstream_ref)
        .ok()
        .and_then(|b| b.as_str().map(str::to_string).ok());
    if repo.find_reference(upstream_ref).is_ok() {
        (UpstreamState::Tracked, remote)
    } else {
        (UpstreamState::Gone, remote)
    }
}

/// remote-tracking の short 名 (`origin/feature/x`) を remote 名と branch 名に分離する。
/// remote 名は `/` を含み得るため、実在する remote 一覧との最長一致で判定する。
fn split_remote_ref<'a>(short: &'a str, remotes: &'a [String]) -> Option<(&'a str, &'a str)> {
    remotes
        .iter()
        .filter_map(|r| {
            short
                .strip_prefix(r.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|branch| (r.as_str(), branch))
        })
        .max_by_key(|(remote, _)| remote.len())
}

fn list_remote_names(repo: &Repository) -> Result<Vec<String>, String> {
    let remotes = repo.remotes().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for name in remotes.iter() {
        let Some(name) = name.map_err(|e| e.to_string())? else {
            continue;
        };
        names.push(name.to_string());
    }
    Ok(names)
}

/// `git ls-remote` 相当。remote 上に現存する branch 名の集合と、
/// remote 側 HEAD のシンボリックターゲット (default branch 名) を返す。
/// fetch と違いローカルの remote-tracking ref を更新しないため preview に安全。
fn list_remote_heads(
    repo: &Repository,
    name: &str,
) -> Result<(HashSet<String>, Option<String>), String> {
    let mut remote = repo.find_remote(name).map_err(|e| e.to_string())?;
    remote
        .connect(Direction::Fetch)
        .map_err(|e| e.to_string())?;
    let mut heads = HashSet::new();
    let mut default_branch = None;
    for head in remote.list().map_err(|e| e.to_string())? {
        let name = head.name();
        if name == "HEAD" {
            if let Some(target) = head.symref_target() {
                if let Some(branch) = target.strip_prefix("refs/heads/") {
                    default_branch = Some(branch.to_string());
                }
            }
        } else if let Some(branch) = name.strip_prefix("refs/heads/") {
            heads.insert(branch.to_string());
        }
    }
    let _ = remote.disconnect();
    Ok((heads, default_branch))
}

/// default branch 名を解決する。直近の接続 (ls-remote) で得た remote HEAD symref を最優先し、
/// 次にローカルの refs/remotes/<remote>/HEAD を確認し、
/// 無ければローカルの main / master にフォールバックする。
fn detect_default_branch(
    repo: &Repository,
    remote_default_branches: &HashMap<String, String>,
) -> Option<String> {
    if let Ok(remotes) = repo.remotes() {
        for name in remotes.iter().flatten().flatten() {
            if let Some(db) = remote_default_branches.get(name) {
                return Some(db.clone());
            }
        }
    }
    if let Ok(remotes) = repo.remotes() {
        for name in remotes.iter().flatten().flatten() {
            let Ok(head_ref) = repo.find_reference(&format!("refs/remotes/{name}/HEAD")) else {
                continue;
            };
            if let Ok(Some(target)) = head_ref.symbolic_target() {
                if let Some(branch) = target.strip_prefix(&format!("refs/remotes/{name}/")) {
                    return Some(branch.to_string());
                }
            }
        }
    }
    ["main", "master"]
        .into_iter()
        .find(|&name| repo.find_branch(name, BranchType::Local).is_ok())
        .map(str::to_string)
}

/// merged 判定の基準 commit を返す。default branch の local tip を基準とし、
/// local に default branch が無い場合は HEAD にフォールバックする。
/// checkout 中の HEAD は repo ごとに恣意的なため、基準には使わない。
fn merged_basis_oid(repo: &Repository, default_branch: Option<&str>) -> Option<git2::Oid> {
    default_branch
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|b| b.get().peel_to_commit().ok())
        .map(|c| c.id())
        .or_else(|| {
            repo.head()
                .ok()
                .and_then(|h| h.peel_to_commit().ok())
                .map(|c| c.id())
        })
}

/// linked worktree で checkout 中の branch 名の集合を返す。
fn worktree_checked_out_branches(repo: &Repository) -> HashSet<String> {
    let mut checked_out = HashSet::new();
    let Ok(names) = repo.worktrees() else {
        return checked_out;
    };
    for name in names.iter().flatten().flatten() {
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let Ok(wt_repo) = Repository::open_from_worktree(&worktree) else {
            continue;
        };
        let Ok(head) = wt_repo.head() else {
            continue;
        };
        if !head.is_branch() {
            continue;
        }
        if let Ok(short) = head.shorthand() {
            checked_out.insert(short.to_string());
        }
    }
    checked_out
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "arbor-cleanup-{prefix}-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path_str(&self) -> &str {
            self.path.to_str().expect("temp path should be utf-8")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn init_repo_with_commit(message: &str) -> TempDir {
        let dir = TempDir::new("repo");
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = git2::Repository::init_opts(&dir.path, &opts).expect("init repo");
        std::fs::write(dir.path.join("README.md"), "hello\n").expect("write file");
        commit_all(&repo, message);
        dir
    }

    /// working tree の内容を全て add してコミットする。
    fn commit_all(repo: &git2::Repository, message: &str) -> git2::Oid {
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .expect("add all");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let signature =
            git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("signature");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)
            .expect("commit")
    }

    fn params(now_ts: i64) -> PreviewParams<'static> {
        PreviewParams {
            stale_threshold_days: 14,
            protected_branches: &[],
            now_ts,
        }
    }

    fn now_ts() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs() as i64
    }

    fn find<'a>(
        preview: &'a RepoCleanupPreview,
        ref_name: &str,
    ) -> Option<&'a CleanupCandidate> {
        preview.candidates.iter().find(|c| c.ref_name == ref_name)
    }

    // ── classify_local (パラメータ化) ─────────────────────────────────────────

    #[test]
    fn classify_local_cases() {
        let cases: &[(bool, UpstreamState, i64, Option<CandidateKind>)] = &[
            // merged は他の条件より優先される
            (true, UpstreamState::Tracked, 0, Some(CandidateKind::Merged)),
            (true, UpstreamState::Gone, 200, Some(CandidateKind::Merged)),
            // upstream 消失は stale より優先される
            (false, UpstreamState::Gone, 0, Some(CandidateKind::UpstreamGone)),
            (false, UpstreamState::Gone, 200, Some(CandidateKind::UpstreamGone)),
            // stale は閾値超過のみ
            (false, UpstreamState::Tracked, 200, Some(CandidateKind::Stale)),
            (false, UpstreamState::None, 200, Some(CandidateKind::Stale)),
            // どれにも該当しなければ候補にしない (閾値ちょうどは stale ではない)
            (false, UpstreamState::Tracked, 100, None),
            (false, UpstreamState::None, 0, None),
        ];
        for &(is_merged, upstream, age, expected) in cases {
            assert_eq!(
                classify_local(is_merged, upstream, age, 100),
                expected,
                "is_merged={is_merged} upstream={upstream:?} age={age}"
            );
        }
    }

    // ── split_remote_ref ──────────────────────────────────────────────────────

    #[test]
    fn split_remote_ref_cases() {
        let remotes: Vec<String> = vec!["origin".into(), "org/fork".into()];
        let cases: &[(&str, Option<(&str, &str)>)] = &[
            ("origin/feature/x", Some(("origin", "feature/x"))),
            ("origin/HEAD", Some(("origin", "HEAD"))),
            // '/' を含む remote 名は最長一致で分離する
            ("org/fork/main", Some(("org/fork", "main"))),
            ("unknown/main", None),
        ];
        for &(short, expected) in cases {
            assert_eq!(split_remote_ref(short, &remotes), expected, "short={short}");
        }
    }

    // ── local branch 候補 ─────────────────────────────────────────────────────

    #[test]
    fn merged_branch_is_candidate() {
        let dir = init_repo_with_commit("base");
        let repo = git2::Repository::open(dir.path_str()).expect("open");
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &base, false).expect("branch");
        // main を先に進めて feature をマージ済み状態にする
        std::fs::write(dir.path.join("next.txt"), "next\n").expect("write");
        commit_all(&repo, "advance main");

        let preview = preview_repo(dir.path_str(), "repo", &params(now_ts()));

        assert!(preview.error.is_none());
        let c = find(&preview, "feature").expect("feature candidate");
        assert_eq!(c.kind, CandidateKind::Merged);
        assert_eq!(c.operation, CleanupOperation::DeleteLocalBranch);
        assert!(c.is_merged);
        assert!(c.blocked.is_empty());
        assert!(find(&preview, "main").is_none(), "HEAD branch は merged 扱いにしない");
    }

    #[test]
    fn current_and_default_branch_are_blocked() {
        let dir = init_repo_with_commit("base");
        // 90日後を基準時刻にして main (HEAD かつ default) を stale にする
        let future = now_ts() + 90 * 86_400;

        let preview = preview_repo(dir.path_str(), "repo", &params(future));

        let c = find(&preview, "main").expect("main candidate");
        assert_eq!(c.kind, CandidateKind::Stale);
        assert!(c.blocked.contains(&SafetyBlock::CurrentBranch));
        assert!(c.blocked.contains(&SafetyBlock::DefaultBranch));
        assert!(c.stale_days.is_some_and(|d| d >= 89));
    }

    #[test]
    fn protected_branch_is_blocked() {
        let dir = init_repo_with_commit("base");
        let repo = git2::Repository::open(dir.path_str()).expect("open");
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("release", &base, false).expect("branch");
        std::fs::write(dir.path.join("next.txt"), "next\n").expect("write");
        commit_all(&repo, "advance main");

        let protected = vec!["release".to_string()];
        let preview = preview_repo(
            dir.path_str(),
            "repo",
            &PreviewParams {
                stale_threshold_days: 14,
                protected_branches: &protected,
                now_ts: now_ts(),
            },
        );

        let c = find(&preview, "release").expect("release candidate");
        assert_eq!(c.blocked, vec![SafetyBlock::ProtectedBranch]);
    }

    #[test]
    fn worktree_checked_out_branch_is_blocked() {
        let dir = init_repo_with_commit("base");
        let wt_dir = TempDir::new("worktree");
        let repo = git2::Repository::open(dir.path_str()).expect("open");
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &base, false).expect("branch");
        std::fs::write(dir.path.join("next.txt"), "next\n").expect("write");
        commit_all(&repo, "advance main");
        {
            let branch_ref = repo
                .find_branch("feature", git2::BranchType::Local)
                .expect("find branch")
                .into_reference();
            let mut opts = git2::WorktreeAddOptions::new();
            opts.reference(Some(&branch_ref));
            // TempDir が作成済みのディレクトリだと worktree add が失敗するため sub path を使う
            repo.worktree("feature-wt", &wt_dir.path.join("wt"), Some(&opts))
                .expect("add worktree");
        }

        let preview = preview_repo(dir.path_str(), "repo", &params(now_ts()));

        let c = find(&preview, "feature").expect("feature candidate");
        assert!(
            c.blocked.contains(&SafetyBlock::WorktreeCheckedOut),
            "blocked={:?}",
            c.blocked
        );
    }

    #[test]
    fn upstream_gone_branch_is_candidate() {
        let source = init_repo_with_commit("origin commit");
        let clone_dir = TempDir::new("clone-gone");
        let clone =
            git2::Repository::clone(source.path_str(), &clone_dir.path).expect("clone");
        let head = clone.head().unwrap().peel_to_commit().unwrap();
        let _branch = clone.branch("feature", &head, false).expect("branch");
        // upstream 設定だけ残して remote-tracking ref が存在しない状態を作る
        let mut cfg = clone.config().expect("config");
        cfg.set_str("branch.feature.remote", "origin").unwrap();
        cfg.set_str("branch.feature.merge", "refs/heads/feature").unwrap();

        // feature ブランチに main 未マージの独自コミットを追加する
        clone.set_head("refs/heads/feature").expect("set head");
        std::fs::write(clone_dir.path.join("feature.txt"), "feature\n").expect("write");
        commit_all(&clone, "feature commit");

        // HEAD を main に戻す
        clone.set_head("refs/heads/main").expect("set head main");
        let mut checkout_opts = git2::build::CheckoutBuilder::new();
        checkout_opts.force();
        clone.checkout_head(Some(&mut checkout_opts)).expect("checkout");

        let preview = preview_repo(clone_dir.path_str(), "clone", &params(now_ts()));

        let c = find(&preview, "feature").expect("feature candidate");
        assert_eq!(c.kind, CandidateKind::UpstreamGone);
        assert_eq!(c.upstream, UpstreamState::Gone);
        assert_eq!(c.remote_name.as_deref(), Some("origin"));
        assert!(c.blocked.is_empty());
    }

    // ── remote-tracking ref 候補 ──────────────────────────────────────────────

    #[test]
    fn stale_remote_tracking_ref_is_prune_candidate() {
        let source = init_repo_with_commit("origin commit");
        {
            let src = git2::Repository::open(source.path_str()).expect("open source");
            let head = src.head().unwrap().peel_to_commit().unwrap();
            src.branch("feature", &head, false).expect("branch");
        }
        let clone_dir = TempDir::new("clone-prune");
        git2::Repository::clone(source.path_str(), &clone_dir.path).expect("clone");
        // remote 側で feature を削除 → clone の origin/feature が prune 対象になる
        {
            let src = git2::Repository::open(source.path_str()).expect("open source");
            src.find_branch("feature", git2::BranchType::Local)
                .expect("find branch")
                .delete()
                .expect("delete");
        }

        let preview = preview_repo(clone_dir.path_str(), "clone", &params(now_ts()));

        assert!(preview.remote_errors.is_empty());
        let c = find(&preview, "origin/feature").expect("prune candidate");
        assert_eq!(c.operation, CleanupOperation::PruneRemoteTrackingRef);
        assert_eq!(c.kind, CandidateKind::StaleRemoteTracking);
        assert_eq!(c.remote_name.as_deref(), Some("origin"));
        assert!(c.blocked.is_empty());
        // remote 上に現存する origin/main は候補にしない
        assert!(find(&preview, "origin/main").is_none());
    }

    #[test]
    fn remote_connect_failure_is_reported_and_suppresses_prune() {
        let dir = init_repo_with_commit("base");
        let repo = git2::Repository::open(dir.path_str()).expect("open");
        let missing = dir.path.join("no-such-remote");
        repo.remote("origin", missing.to_str().unwrap()).expect("add remote");
        // 接続不能 remote の remote-tracking ref を手動で作る
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            head.id(),
            false,
            "test setup",
        )
        .expect("create tracking ref");

        let preview = preview_repo(dir.path_str(), "repo", &params(now_ts()));

        assert!(preview.error.is_none());
        assert_eq!(preview.remote_errors.len(), 1);
        assert_eq!(preview.remote_errors[0].remote, "origin");
        assert!(!preview.remote_errors[0].error.is_empty());
        assert!(
            find(&preview, "origin/feature").is_none(),
            "接続失敗 remote の ref は prune 候補にしない"
        );
    }

    #[test]
    fn unreadable_repo_returns_error_entry() {
        let dir = TempDir::new("not-a-repo");
        let preview = preview_repo(dir.path_str(), "broken", &params(now_ts()));

        assert!(preview.error.is_some());
        assert!(preview.candidates.is_empty());
        assert_eq!(preview.repo_path, dir.path_str());
    }

    #[test]
    fn same_branch_name_in_two_repos_is_identified_by_repo_path() {
        let make_repo_with_merged_feature = || {
            let dir = init_repo_with_commit("base");
            let repo = git2::Repository::open(dir.path_str()).expect("open");
            let base = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature", &base, false).expect("branch");
            std::fs::write(dir.path.join("next.txt"), "next\n").expect("write");
            commit_all(&repo, "advance main");
            dir
        };
        let repo_a = make_repo_with_merged_feature();
        let repo_b = make_repo_with_merged_feature();

        let p = params(now_ts());
        let preview_a = preview_repo(repo_a.path_str(), "repo-a", &p);
        let preview_b = preview_repo(repo_b.path_str(), "repo-b", &p);

        let a = find(&preview_a, "feature").expect("candidate in repo-a");
        let b = find(&preview_b, "feature").expect("candidate in repo-b");
        assert_eq!(a.repo_path, repo_a.path_str());
        assert_eq!(b.repo_path, repo_b.path_str());
        assert_ne!(a.repo_path, b.repo_path);
    }

    #[test]
    fn detect_default_branch_without_local_origin_head() {
        let dir = TempDir::new("remote-source");
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("trunk");
        let remote_repo = git2::Repository::init_opts(&dir.path, &opts).expect("init repo");
        std::fs::write(dir.path.join("README.md"), "hello\n").expect("write file");
        commit_all(&remote_repo, "initial");

        let clone_dir = TempDir::new("clone-test");
        let clone_repo = git2::Repository::clone(dir.path_str(), &clone_dir.path).expect("clone");

        if let Ok(mut head_ref) = clone_repo.find_reference("refs/remotes/origin/HEAD") {
            head_ref.delete().expect("delete origin/HEAD");
        }

        let (_, default_branch) = list_remote_heads(&clone_repo, "origin").expect("list remote heads");
        assert_eq!(default_branch, Some("trunk".to_string()));

        let mut remote_default_branches = HashMap::new();
        if let Some(db) = default_branch {
            remote_default_branches.insert("origin".to_string(), db);
        }

        let db = detect_default_branch(&clone_repo, &remote_default_branches);
        assert_eq!(db, Some("trunk".to_string()));
    }
}
