use crate::commands::config_cmd::{
    apply_settings, filter_missing_repos, register_repository, unregister_repository,
    workspace_status, WorkspaceStatus,
};
use crate::config::{load_config, modify_config, AppConfig, RepoConfig};

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> {
    load_config()
}

#[tauri::command]
pub fn add_repository(path: String, name: String) -> Result<AppConfig, String> {
    modify_config(|config| register_repository(config, path, name))
}

#[tauri::command]
pub fn remove_repository(path: String) -> Result<AppConfig, String> {
    modify_config(|config| Ok(unregister_repository(config, &path)))
}

/// workspace root と、検出したリポジトリ数を返す。
#[tauri::command(async)]
pub fn get_workspace_status() -> Result<WorkspaceStatus, String> {
    Ok(workspace_status(&load_config()?))
}

/// 手動登録のうち、パスが存在しなくなったものを返す。
#[tauri::command]
pub fn scan_missing_repositories() -> Result<Vec<RepoConfig>, String> {
    Ok(filter_missing_repos(load_config()?.repositories))
}

#[tauri::command]
pub fn update_settings(
    stale_threshold_days: Option<u32>,
    fetch_on_startup: Option<bool>,
    workspace_root: Option<String>,
) -> Result<AppConfig, String> {
    modify_config(|config| {
        apply_settings(
            config,
            stale_threshold_days,
            fetch_on_startup,
            workspace_root,
        )
    })
}
