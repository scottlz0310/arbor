use crate::commands::runner::RunnerState;
use tauri::State;

/// 実行中のコマンドをキャンセルする。`run_id` は `process_started` イベントで通知される。
#[tauri::command]
pub fn cancel_run(state: State<'_, RunnerState>, run_id: u64) -> Result<(), String> {
    state.runner().cancel(run_id)
}
