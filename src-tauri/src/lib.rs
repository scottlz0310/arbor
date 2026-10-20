mod commands;
mod config;
mod ipc;
mod models;
#[cfg(test)]
mod test_util;
mod workspace;

use commands::runner::{RunnerState, TauriSink};
use ipc::{cleanup, config as settings, dsx, fetch, remote_status, repo, runner, updater};
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let sink = Arc::new(TauriSink::new(app.handle().clone()));
            app.manage(RunnerState::new(sink));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Config
            settings::get_config,
            settings::add_repository,
            settings::remove_repository,
            settings::scan_missing_repositories,
            settings::update_settings,
            settings::get_workspace_status,
            // Repo / git2
            repo::list_repositories,
            repo::get_repo_status,
            repo::fetch_all,
            repo::open_repo_folder,
            fetch::fetch_repositories,
            remote_status::check_remotes,
            // Cleanup Wizard (Issue #186)
            cleanup::cleanup_preview,
            cleanup::cleanup_execute,
            // dsx
            dsx::dsx_check,
            dsx::dsx_latest_version,
            dsx::repo_update,
            dsx::daily_refresh,
            dsx::env_inject,
            dsx::sys_update,
            dsx::sys_update_dry_run,
            dsx::dsx_doctor,
            dsx::dsx_self_update,
            // Arbor 自身の更新
            updater::updater_check,
            updater::updater_install,
            runner::cancel_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arbor");
}
