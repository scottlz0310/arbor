use crate::commands::dsx::{
    check_dsx, latest_dsx_version, run_task, update_root, DsxStatus, DsxTask,
};
use crate::commands::runner::RunnerState;
use crate::config::load_config;
use crate::models::DsxOutput;
use tauri::State;

#[tauri::command]
pub fn dsx_check() -> DsxStatus {
    check_dsx()
}

/// dsx の最新版のタグを返す。取得できなければ `None`（エラーにはしない）。
#[tauri::command]
pub async fn dsx_latest_version() -> Option<String> {
    latest_dsx_version().await
}

/// workspace root 配下の全リポジトリを更新する（`dsx repo update --root`）。
#[tauri::command]
pub async fn repo_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    let root = update_root(&load_config()?)?;
    run_task(&state, DsxTask::RepoUpdate { root }).await
}

/// `dsx run --root`: システム更新 → リポジトリ更新。
#[tauri::command]
pub async fn daily_refresh(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    let root = update_root(&load_config()?)?;
    run_task(&state, DsxTask::DailyRefresh { root }).await
}

/// 環境変数を注入して、指定のディレクトリでコマンドを実行する（`dsx env run`）。
#[tauri::command]
pub async fn env_inject(
    state: State<'_, RunnerState>,
    repo_path: String,
    cmd: String,
) -> Result<DsxOutput, String> {
    run_task(
        &state,
        DsxTask::EnvRun {
            cwd: repo_path,
            command: cmd,
        },
    )
    .await
}

#[tauri::command]
pub async fn sys_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_task(&state, DsxTask::SysUpdate).await
}

/// 更新はせず、`sys update` の計画だけを表示する。
#[tauri::command]
pub async fn sys_update_dry_run(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_task(&state, DsxTask::SysUpdateDryRun).await
}

#[tauri::command]
pub async fn dsx_doctor(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_task(&state, DsxTask::Doctor).await
}

#[tauri::command]
pub async fn dsx_self_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_task(&state, DsxTask::SelfUpdate).await
}
