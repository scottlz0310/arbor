mod commands;
mod config;
mod models;

use commands::{
    config_cmd::{add_repository, get_config, remove_repository, scan_directory, update_settings},
    dsx::{dsx_check, repo_cleanup, repo_cleanup_preview, repo_update},
    repo::{delete_branches, fetch_all, get_branches, get_repo_status, list_repositories},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // Config
            get_config,
            add_repository,
            remove_repository,
            scan_directory,
            update_settings,
            // Repo / git2
            list_repositories,
            get_repo_status,
            get_branches,
            delete_branches,
            fetch_all,
            // dsx
            dsx_check,
            repo_update,
            repo_cleanup_preview,
            repo_cleanup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arbor");
}
