use crate::commands::runner::RunnerState;
use crate::commands::updater::UpdateCheck;
use crate::commands::updater_tauri::{check_for_update, install_available_update};
use tauri::{AppHandle, State};

/// Arbor の新しい版の有無を調べる（macOS と Linux の AppImage 向け）。
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<UpdateCheck, String> {
    check_for_update(&app).await
}

/// 新しい版をダウンロードして適用し、再起動する。他のコマンドの実行中は拒否する。
#[tauri::command]
pub async fn updater_install(app: AppHandle, state: State<'_, RunnerState>) -> Result<(), String> {
    install_available_update(&app, &state).await
}
