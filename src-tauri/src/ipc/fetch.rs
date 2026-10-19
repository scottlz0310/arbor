use crate::commands::fetch::fetch_all_repositories;
use crate::commands::runner::RunnerState;
use crate::config::load_config;
use crate::models::FetchSummary;
use tauri::State;

/// 管理対象の全リポジトリを fetch する。進捗は `process_*` イベントで流れ、`cancel_run` で中断できる。
#[tauri::command]
pub async fn fetch_repositories(state: State<'_, RunnerState>) -> Result<FetchSummary, String> {
    fetch_all_repositories(&state, &load_config()?).await
}
