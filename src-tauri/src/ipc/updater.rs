use crate::commands::updater::{check_for_update, install_available_update, UpdateCheck};
use tauri::AppHandle;

/// Arbor の新しい版の有無を調べる（macOS と Linux の AppImage 向け）。
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<UpdateCheck, String> {
    check_for_update(&app).await
}

/// 新しい版をダウンロードして適用し、再起動する。
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    install_available_update(&app).await?;
    app.restart()
}
