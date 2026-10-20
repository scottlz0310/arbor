//! `updater.rs` の外部への接続部（テストしない）。
//!
//! `AppHandle` と updater プラグインに直接触れるため、単体テストできない（Windows では `tauri::test` の
//! テスト実行ファイルが起動しない）。ここにはロジックを置かない: 流れ・分岐・テストする対象は、
//! `updater.rs` に置いて、ここからは呼ぶだけにする。カバレッジの対象外（CI の `cargo llvm-cov
//! --ignore-filename-regex` と `codecov.yml` の `ignore`）で、`ipc/guard.rs` が、ここに分岐・繰り返しが
//! 無いこと（と、除外の設定が、このファイルを指していること）を検査する。

use super::runner::RunnerState;
use super::updater::{
    check_update, current_unsupported_reason, install_update, UpdateCheck, UpdateInfo,
};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

async fn fetch_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    app.updater()
        .map_err(|e| format!("更新の確認を準備できませんでした: {e}"))?
        .check()
        .await
        .map_err(|e| format!("更新の確認に失敗しました: {e}"))
}

/// リリースの `latest.json` で、新しい版の有無を調べる。
pub async fn check_for_update(app: &AppHandle) -> Result<UpdateCheck, String> {
    check_update(
        current_unsupported_reason(),
        &app.package_info().version.to_string(),
        || async {
            Ok(fetch_update(app).await?.map(|update| UpdateInfo {
                current_version: update.current_version,
                version: update.version,
                notes: update.body,
            }))
        },
    )
    .await
}

/// 新しい版をダウンロードして適用し、再起動する（成功すると戻らない）。
/// 別のコマンドの実行中は、何もせず、エラーを返す。
pub async fn install_available_update(app: &AppHandle, state: &RunnerState) -> Result<(), String> {
    let runner = state.runner();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_update(
            &runner,
            current_unsupported_reason(),
            || {
                tauri::async_runtime::block_on(async {
                    let update = fetch_update(&app)
                        .await?
                        .ok_or_else(|| "利用できる更新がありません".to_string())?;
                    let bytes = update
                        .download(|_, _| {}, || {})
                        .await
                        .map_err(|e| format!("更新のダウンロードに失敗しました: {e}"))?;
                    Ok((update, bytes))
                })
            },
            |(update, bytes)| {
                update
                    .install(bytes)
                    .map_err(|e| format!("更新の適用に失敗しました: {e}"))
            },
            || app.restart(),
        )
    })
    .await
    .map_err(|e| format!("更新の実行スレッドが異常終了しました: {e}"))?
}
