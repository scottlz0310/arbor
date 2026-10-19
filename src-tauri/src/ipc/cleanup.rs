use crate::commands::cleanup::{build_preview, execute_cleanup};
use crate::config::load_config;
use crate::models::{CleanupExecutionRequest, CleanupExecutionResult, CleanupPreview};

/// 登録済み全 repo を横断して Cleanup 候補を列挙する（読み取り専用）。
/// 全 repo × 全 remote へ順に接続して遅いため、UI を止めないよう別スレッドで実行する。
#[tauri::command(async)]
pub fn cleanup_preview() -> Result<CleanupPreview, String> {
    build_preview(&load_config()?)
}

/// preview で選択された候補を、repo ごとに再検証して実行する。
#[tauri::command(async)]
pub fn cleanup_execute(request: CleanupExecutionRequest) -> Result<CleanupExecutionResult, String> {
    execute_cleanup(&load_config()?, request.candidates)
}
