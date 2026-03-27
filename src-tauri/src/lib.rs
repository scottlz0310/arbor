mod commands;
mod config;
mod models;

use commands::{
    config_cmd::{
        add_repository, delete_github_pat, get_config, has_github_pat, remove_repository,
        scan_directory, set_github_pat, update_repository_github, update_settings,
    },
    dsx::{dsx_check, env_inject, repo_cleanup, repo_cleanup_preview, repo_update, sys_update},
    github::{get_check_runs, get_issues, get_pull_requests},
    repo::{
        delete_branches, fetch_all, get_branches, get_commit_graph, get_repo_status,
        list_repositories,
    },
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
            update_repository_github,
            scan_directory,
            update_settings,
            // GitHub PAT
            set_github_pat,
            has_github_pat,
            delete_github_pat,
            // GitHub API
            get_pull_requests,
            get_issues,
            get_check_runs,
            // Repo / git2
            list_repositories,
            get_repo_status,
            get_branches,
            delete_branches,
            fetch_all,
            get_commit_graph,
            // dsx
            dsx_check,
            repo_update,
            repo_cleanup_preview,
            repo_cleanup,
            env_inject,
            sys_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arbor");
}
