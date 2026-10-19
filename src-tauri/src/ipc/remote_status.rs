use crate::commands::remote_status::check_all_remotes;
use crate::commands::runner::RunnerState;
use crate::config::load_config;
use crate::models::RemoteCheckSummary;
use tauri::State;

/// 管理対象の全リポジトリの、リモートの状態（アーカイブ済み・移転・見つからない）を確認する。
/// 進捗は `process_*` イベントで流れ、`cancel_run` で中断できる。
#[tauri::command]
pub async fn check_remotes(state: State<'_, RunnerState>) -> Result<RemoteCheckSummary, String> {
    check_all_remotes(&state, &load_config()?).await
}
