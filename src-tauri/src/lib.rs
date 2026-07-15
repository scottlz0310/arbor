mod commands;
mod config;
mod models;

use commands::{
    ai::{get_ai_insights, get_ai_insights_cached, ollama_available, test_ai_connection, AiCacheState},
    cleanup::cleanup_preview,
    config_cmd::{
        add_repository, delete_github_pat, detect_github_remote, get_config, has_github_pat,
        remove_repository, scan_directory, scan_missing_repositories, set_github_pat,
        update_ai_config, update_repository_github, update_settings,
    },
    dsx::{dsx_check, dsx_latest_version, dsx_self_update, env_inject, repo_cleanup, repo_cleanup_preview, repo_update, sys_update},
    github::{get_check_runs, get_issues, get_pull_requests},
    repo::{
        apply_stash, delete_branches, drop_stash, fetch_all, get_branches, get_commit_graph,
        get_repo_status, list_repositories, list_stashes,
    },
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AiCacheState::default())
        .invoke_handler(tauri::generate_handler![
            // Config
            get_config,
            add_repository,
            remove_repository,
            update_repository_github,
            detect_github_remote,
            scan_directory,
            scan_missing_repositories,
            update_settings,
            update_ai_config,
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
            list_stashes,
            apply_stash,
            drop_stash,
            // Cleanup Wizard (Issue #186)
            cleanup_preview,
            // AI / Ollama
            ollama_available,
            test_ai_connection,
            get_ai_insights,
            get_ai_insights_cached,
            // dsx
            dsx_check,
            dsx_latest_version,
            repo_update,
            repo_cleanup_preview,
            repo_cleanup,
            env_inject,
            sys_update,
            dsx_self_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Arbor");
}
