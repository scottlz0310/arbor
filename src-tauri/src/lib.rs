mod commands;
mod config;
mod models;

use commands::{
    cleanup::{cleanup_execute, cleanup_preview},
    config_cmd::{
        add_repository, get_config, remove_repository, scan_directory, scan_missing_repositories,
        update_settings,
    },
    dsx::{dsx_check, dsx_latest_version, dsx_self_update, env_inject, repo_update, sys_update},
    repo::{fetch_all, get_repo_status, list_repositories},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // Config
            get_config,
            add_repository,
            remove_repository,
            scan_directory,
            scan_missing_repositories,
            update_settings,
            // Repo / git2
            list_repositories,
            get_repo_status,
            fetch_all,
            // Cleanup Wizard (Issue #186)
            cleanup_preview,
            cleanup_execute,
            // dsx
            dsx_check,
            dsx_latest_version,
            repo_update,
            env_inject,
            sys_update,
            dsx_self_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arbor");
}
