//! 管理対象リポジトリの決定。
//!
//! 一覧に出すリポジトリは、workspace root 配下の自動検出と、手動登録の和集合。
//! 検出規則は dsx の `repo.root`（`dsx repo list` / `dsx repo update`）と同じで、
//! root 自身（git リポジトリなら）と、root 直下のディレクトリだけを見る（深さ 1）。

use crate::config::{AppConfig, RepoConfig};
use crate::models::RepoSource;
use std::io;
use std::path::{Path, PathBuf};

/// 名前・protected branches を解決済みの、一覧に出すリポジトリ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveRepo {
    pub path: String,
    pub name: String,
    /// 全体の既定（`Settings.protected_branches`）と、手動登録の設定を合わせたもの。
    pub protected_branches: Vec<String>,
    pub source: RepoSource,
}

/// `.git` があるディレクトリを git リポジトリとみなす（worktree・submodule の `.git` ファイルも含む）。
fn has_git_metadata(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// root 自身と、root 直下の git リポジトリを、名前の昇順で返す。
pub fn discover_repos(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    if has_git_metadata(root) {
        found.push(root.to_path_buf());
    }
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() && has_git_metadata(&path) {
            found.push(path);
        }
    }
    found.sort_by_key(|path| display_name(path).to_lowercase());
    Ok(found)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.to_string_lossy(), |name| name.to_string_lossy())
        .into_owned()
}

/// 同じディレクトリを、区切り文字・末尾の区切り・（Windows では）大文字小文字の違いを越えて同一視するための鍵。
fn path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn merge_protected(global: &[String], extra: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = Vec::new();
    for branch in global.iter().chain(extra) {
        if !merged.contains(branch) {
            merged.push(branch.clone());
        }
    }
    merged
}

/// 管理対象から、同じディレクトリを指すリポジトリを探す（区切り文字・末尾の区切り・Windows の大文字小文字を無視）。
pub fn find_managed<'a>(repos: &'a [EffectiveRepo], path: &str) -> Option<&'a EffectiveRepo> {
    let key = path_key(path);
    repos.iter().find(|r| path_key(&r.path) == key)
}

/// 一覧に出すリポジトリ。root 配下を自動検出し、root の外の手動登録を後ろに足す（ディスク上に無いものは除く）。
/// root 配下のリポジトリを手動登録していれば、その名前を使い、protected branches を追加する。
///
/// 戻り値の 2 つ目は、root を読めなかったときのエラー（手動登録だけは返す）。
pub fn effective_repos(config: &AppConfig) -> (Vec<EffectiveRepo>, Option<String>) {
    let manual_for = |path: &str| -> Option<&RepoConfig> {
        let key = path_key(path);
        config
            .repositories
            .iter()
            .find(|r| path_key(&r.path) == key)
    };
    let global = &config.settings.protected_branches;

    let mut repos: Vec<EffectiveRepo> = Vec::new();
    let mut root_error = None;

    if let Some(root) = config.workspace.root.as_deref().filter(|r| !r.is_empty()) {
        match discover_repos(Path::new(root)) {
            Ok(paths) => {
                for path in paths {
                    let path = path.to_string_lossy().into_owned();
                    let manual = manual_for(&path);
                    repos.push(EffectiveRepo {
                        name: manual
                            .map_or_else(|| display_name(Path::new(&path)), |m| m.name.clone()),
                        protected_branches: merge_protected(
                            global,
                            manual.map_or(&[][..], |m| &m.protected_branches),
                        ),
                        source: RepoSource::Workspace,
                        path,
                    });
                }
            }
            Err(e) => root_error = Some(format!("workspace root を読み取れません ({root}): {e}")),
        }
    }

    let discovered: Vec<String> = repos.iter().map(|r| path_key(&r.path)).collect();
    for manual in &config.repositories {
        // ディスク上に無い手動登録（削除済みのクローンなど）は、一覧・fetch・cleanup の対象にしない。
        // Settings の「無効なリポジトリを検出」から、登録を外せる。
        if discovered.contains(&path_key(&manual.path)) || !Path::new(&manual.path).exists() {
            continue;
        }
        repos.push(EffectiveRepo {
            path: manual.path.clone(),
            name: manual.name.clone(),
            protected_branches: merge_protected(global, &manual.protected_branches),
            source: RepoSource::Manual,
        });
    }

    (repos, root_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "arbor-{prefix}-{}",
                crate::test_util::unique_suffix()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path_str(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        /// `.git` ディレクトリを持つだけの、軽量なリポジトリのひな形。
        fn make_repo(&self, name: &str) -> PathBuf {
            let dir = self.path.join(name);
            std::fs::create_dir_all(dir.join(".git")).expect("create repo dir");
            dir
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn config_with_root(root: &TempDir) -> AppConfig {
        let mut config = AppConfig::default();
        config.workspace.root = Some(root.path_str());
        config
    }

    fn manual(path: &str, name: &str, protected: &[&str]) -> RepoConfig {
        RepoConfig {
            path: path.to_string(),
            name: name.to_string(),
            protected_branches: protected.iter().map(|b| (*b).to_string()).collect(),
        }
    }

    fn names(repos: &[EffectiveRepo]) -> Vec<&str> {
        repos.iter().map(|r| r.name.as_str()).collect()
    }

    // ── discover_repos ────────────────────────────────────────────────────────

    #[test]
    fn discover_finds_direct_children_only_in_name_order() {
        let root = TempDir::new("discover");
        root.make_repo("zeta");
        root.make_repo("Alpha");
        root.make_repo("beta");
        // リポジトリの子のリポジトリ（深さ 2）・.git の無いディレクトリ・ファイルは対象外
        std::fs::create_dir_all(root.path.join("Alpha").join("nested").join(".git")).unwrap();
        std::fs::create_dir_all(root.path.join("not-a-repo")).unwrap();
        std::fs::write(root.path.join("file.txt"), "x").unwrap();

        let found = discover_repos(&root.path).expect("discover");

        let names: Vec<_> = found.iter().map(|p| display_name(p)).collect();
        assert_eq!(names, ["Alpha", "beta", "zeta"]);
    }

    #[test]
    fn discover_includes_the_root_itself_when_it_is_a_repository() {
        let root = TempDir::new("discover-self");
        std::fs::create_dir_all(root.path.join(".git")).unwrap();
        root.make_repo("child");

        let found = discover_repos(&root.path).expect("discover");

        assert_eq!(found.len(), 2);
        assert!(found.contains(&root.path));
    }

    #[test]
    fn discover_treats_a_git_file_as_metadata() {
        // worktree・submodule の .git はファイル
        let root = TempDir::new("discover-gitfile");
        let dir = root.path.join("worktree");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".git"), "gitdir: ../elsewhere").unwrap();

        assert_eq!(discover_repos(&root.path).expect("discover"), [dir]);
    }

    #[test]
    fn discover_reports_a_missing_root() {
        let root = TempDir::new("discover-missing");
        assert!(discover_repos(&root.path.join("does-not-exist")).is_err());
    }

    // ── effective_repos ───────────────────────────────────────────────────────

    #[test]
    fn effective_repos_lists_workspace_repositories_with_global_protected_branches() {
        let root = TempDir::new("effective");
        root.make_repo("arbor");
        root.make_repo("dsx");
        let config = config_with_root(&root);

        let (repos, error) = effective_repos(&config);

        assert!(error.is_none());
        assert_eq!(names(&repos), ["arbor", "dsx"]);
        assert!(repos.iter().all(|r| r.source == RepoSource::Workspace));
        assert_eq!(
            repos[0].protected_branches,
            ["main", "master", "develop", "dev"]
        );
    }

    #[test]
    fn effective_repos_applies_manual_override_to_a_workspace_repository() {
        let root = TempDir::new("override");
        let arbor = root.make_repo("arbor");
        let mut config = config_with_root(&root);
        config.repositories = vec![manual(
            &arbor.to_string_lossy(),
            "Arbor (app)",
            &["release", "main"],
        )];

        let (repos, _) = effective_repos(&config);

        assert_eq!(repos.len(), 1, "手動登録と自動検出は 1 件にまとまる");
        assert_eq!(repos[0].name, "Arbor (app)");
        assert_eq!(repos[0].source, RepoSource::Workspace);
        // 全体の既定に追加される（重複は 1 つ）
        assert_eq!(
            repos[0].protected_branches,
            ["main", "master", "develop", "dev", "release"]
        );
    }

    #[test]
    fn effective_repos_appends_manual_repositories_outside_the_root() {
        let root = TempDir::new("outside-root");
        root.make_repo("inside");
        let elsewhere = TempDir::new("elsewhere");
        let outside = elsewhere.make_repo("outside");
        let outside = outside.to_string_lossy();
        let mut config = config_with_root(&root);
        config.repositories = vec![manual(&outside, "outside", &["keep"])];

        let (repos, _) = effective_repos(&config);

        assert_eq!(names(&repos), ["inside", "outside"]);
        assert_eq!(repos[1].source, RepoSource::Manual);
        assert_eq!(repos[1].path, outside);
        assert!(repos[1].protected_branches.contains(&"keep".to_string()));
        assert!(repos[1].protected_branches.contains(&"main".to_string()));
    }

    #[test]
    fn effective_repos_skips_manual_repositories_missing_from_disk() {
        let root = TempDir::new("missing-manual");
        root.make_repo("inside");
        let elsewhere = TempDir::new("missing-manual-else");
        let kept = elsewhere.make_repo("kept");
        let gone = elsewhere.path.join("gone");
        let mut config = config_with_root(&root);
        config.repositories = vec![
            manual(&gone.to_string_lossy(), "gone", &[]),
            manual(&kept.to_string_lossy(), "kept", &[]),
        ];

        let (repos, error) = effective_repos(&config);

        assert!(error.is_none());
        assert_eq!(names(&repos), ["inside", "kept"], "存在しない登録は対象外");
    }

    #[test]
    fn effective_repos_cases_without_a_usable_root() {
        let missing = TempDir::new("no-root").path.join("gone");
        let manual_dir = TempDir::new("no-root-manual");
        let manual_repo = manual_dir.make_repo("one");
        let cases = [
            ("root 未設定", None),
            ("自動検出を無効化（空文字列）", Some(String::new())),
            (
                "root が存在しない",
                Some(missing.to_string_lossy().into_owned()),
            ),
        ];

        for (name, root) in cases {
            let mut config = AppConfig::default();
            config.workspace.root = root.clone();
            config.repositories = vec![manual(&manual_repo.to_string_lossy(), "one", &[])];

            let (repos, error) = effective_repos(&config);

            assert_eq!(names(&repos), ["one"], "{name}: 手動登録は残る");
            assert_eq!(
                error.is_some(),
                name == "root が存在しない",
                "{name}: {error:?}"
            );
        }
    }

    #[test]
    fn path_key_ignores_separators_and_trailing_slash() {
        assert_eq!(path_key("C:\\src\\arbor\\"), path_key("C:/src/arbor"));
        if cfg!(windows) {
            assert_eq!(path_key("C:\\Src\\Arbor"), path_key("c:/src/arbor"));
        } else {
            assert_ne!(path_key("/src/Arbor"), path_key("/src/arbor"));
        }
    }

    #[test]
    fn find_managed_matches_across_path_spellings() {
        let repos = vec![
            EffectiveRepo {
                path: "C:/src/arbor".to_string(),
                name: "arbor".to_string(),
                protected_branches: Vec::new(),
                source: RepoSource::Workspace,
            },
            EffectiveRepo {
                path: "/m/one".to_string(),
                name: "one".to_string(),
                protected_branches: Vec::new(),
                source: RepoSource::Manual,
            },
        ];

        assert_eq!(
            find_managed(&repos, r"C:\src\arbor\").map(|r| r.name.as_str()),
            Some("arbor")
        );
        assert_eq!(
            find_managed(&repos, "/m/one").map(|r| r.name.as_str()),
            Some("one")
        );
        assert!(find_managed(&repos, "C:/src/other").is_none());
        assert!(find_managed(&repos, "").is_none());
    }
}
