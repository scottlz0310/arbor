use crate::commands::repo::{fetch_repo, list_repos, open_managed_folder, repo_status};
use crate::config::load_config;
use crate::models::{FetchResult, RepoInfo};

/// 管理対象のリポジトリを、ローカルの状態つきで一覧にする（ネットワークには接続しない）。
/// 大きな workspace で UI を止めないよう、別スレッドで実行する。
#[tauri::command(async)]
pub fn list_repositories() -> Result<Vec<RepoInfo>, String> {
    Ok(list_repos(&load_config()?))
}

#[tauri::command(async)]
pub fn get_repo_status(repo_path: String) -> Result<RepoInfo, String> {
    repo_status(&load_config()?, &repo_path)
}

/// 1 つのリポジトリの全 remote を fetch する。
#[tauri::command]
pub fn fetch_all(repo_path: String) -> Result<FetchResult, String> {
    fetch_repo(&repo_path)
}

/// 管理対象のリポジトリのフォルダを、OS のファイルマネージャで開く。
#[tauri::command(async)]
pub fn open_repo_folder(repo_path: String) -> Result<(), String> {
    open_managed_folder(&load_config()?, &repo_path)
}
