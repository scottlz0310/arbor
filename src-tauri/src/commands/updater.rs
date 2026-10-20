//! Arbor 自身の更新（Tauri updater。macOS と Linux の AppImage 向け）。
//!
//! 更新の有無は、リリースの `latest.json`（`tauri.conf.json` の `plugins.updater.endpoints`）で調べる。
//! Windows は MSIX の `.appinstaller` が更新するため、アプリ内では更新しない。
//! 確認と適用の流れは、外部（ネットワーク・ファイル置き換え）を関数で受け取り、テストで差し替える。

use serde::Serialize;
use std::future::Future;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// 利用できる更新。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
}

/// 更新の確認の結果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheck {
    /// アプリ内では更新できない（理由つき）。
    Unsupported {
        reason: String,
    },
    UpToDate {
        current_version: String,
    },
    Available {
        current_version: String,
        version: String,
        notes: Option<String>,
    },
}

/// アプリ内の更新に対応していない理由。対応していれば `None`。
/// Linux は、自己更新できる AppImage（実行時に `APPIMAGE` が設定される）だけが対象で、deb は対象外。
pub fn unsupported_reason(os: &str, appimage: bool) -> Option<&'static str> {
    match os {
        "windows" => Some(
            "Windows 版は MSIX の .appinstaller で自動更新されます（約 8 時間ごと）。アプリ内では更新しません。",
        ),
        "linux" if !appimage => Some(
            "deb 版はアプリ内では更新できません。新しい deb を入れ直してください（AppImage 版は更新できます）。",
        ),
        "linux" | "macos" => None,
        _ => Some("この OS はアプリ内の更新に対応していません。"),
    }
}

fn current_unsupported_reason() -> Option<&'static str> {
    unsupported_reason(std::env::consts::OS, std::env::var_os("APPIMAGE").is_some())
}

/// 更新を確認する。対応していない環境では、ネットワークに出ず、理由を返す。
pub async fn check_update<F, Fut>(
    unsupported: Option<&str>,
    current_version: &str,
    fetch: F,
) -> Result<UpdateCheck, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Option<UpdateInfo>, String>>,
{
    if let Some(reason) = unsupported {
        return Ok(UpdateCheck::Unsupported {
            reason: reason.to_string(),
        });
    }

    Ok(match fetch().await? {
        Some(info) => UpdateCheck::Available {
            current_version: info.current_version,
            version: info.version,
            notes: info.notes,
        },
        None => UpdateCheck::UpToDate {
            current_version: current_version.to_string(),
        },
    })
}

/// 更新をダウンロードして適用する（再起動は呼び出し側）。対応していない環境では、何もせず、エラーを返す。
pub async fn install_update<F, Fut>(unsupported: Option<&str>, install: F) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    if let Some(reason) = unsupported {
        return Err(reason.to_string());
    }

    install().await
}

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

/// 新しい版をダウンロードして適用する。適用後の再起動は、呼び出し側が行う。
pub async fn install_available_update(app: &AppHandle) -> Result<(), String> {
    install_update(current_unsupported_reason(), || async {
        let update = fetch_update(app)
            .await?
            .ok_or_else(|| "利用できる更新がありません".to_string())?;

        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| format!("更新のダウンロードと適用に失敗しました: {e}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_reason_per_platform() {
        let cases = [
            ("windows", false, true),
            ("windows", true, true),
            ("linux", false, true),
            ("linux", true, false),
            ("macos", false, false),
            ("freebsd", false, true),
        ];

        for (os, appimage, unsupported) in cases {
            assert_eq!(
                unsupported_reason(os, appimage).is_some(),
                unsupported,
                "{os} (appimage={appimage})"
            );
        }
    }

    #[test]
    fn unsupported_reason_explains_each_case() {
        assert!(unsupported_reason("windows", false)
            .unwrap()
            .contains("MSIX"));
        assert!(unsupported_reason("linux", false).unwrap().contains("deb"));
    }

    fn info() -> UpdateInfo {
        UpdateInfo {
            current_version: "0.5.0".to_string(),
            version: "0.6.0".to_string(),
            notes: Some("notes".to_string()),
        }
    }

    #[test]
    fn check_update_reports_available() {
        let result = tauri::async_runtime::block_on(check_update(None, "0.5.0", || async {
            Ok(Some(info()))
        }));

        assert_eq!(
            result,
            Ok(UpdateCheck::Available {
                current_version: "0.5.0".to_string(),
                version: "0.6.0".to_string(),
                notes: Some("notes".to_string()),
            })
        );
    }

    #[test]
    fn check_update_reports_up_to_date() {
        let result =
            tauri::async_runtime::block_on(check_update(None, "0.5.0", || async { Ok(None) }));

        assert_eq!(
            result,
            Ok(UpdateCheck::UpToDate {
                current_version: "0.5.0".to_string()
            })
        );
    }

    #[test]
    fn check_update_propagates_fetch_error() {
        let result = tauri::async_runtime::block_on(check_update(None, "0.5.0", || async {
            Err("network down".to_string())
        }));

        assert_eq!(result, Err("network down".to_string()));
    }

    #[test]
    fn check_update_skips_network_when_unsupported() {
        let result =
            tauri::async_runtime::block_on(check_update(Some("deb です"), "0.5.0", || async {
                panic!("対応していない環境では、ネットワークに出ない")
            }));

        assert_eq!(
            result,
            Ok(UpdateCheck::Unsupported {
                reason: "deb です".to_string()
            })
        );
    }

    #[test]
    fn install_update_runs_the_installer() {
        let result = tauri::async_runtime::block_on(install_update(None, || async { Ok(()) }));

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn install_update_propagates_installer_error() {
        let result = tauri::async_runtime::block_on(install_update(None, || async {
            Err("disk full".to_string())
        }));

        assert_eq!(result, Err("disk full".to_string()));
    }

    #[test]
    fn install_update_refuses_when_unsupported() {
        let result =
            tauri::async_runtime::block_on(install_update(Some("Windows です"), || async {
                panic!("対応していない環境では、適用しない")
            }));

        assert_eq!(result, Err("Windows です".to_string()));
    }

    #[test]
    fn update_check_serializes_with_kind_tag() {
        let value = serde_json::to_value(UpdateCheck::Available {
            current_version: "0.5.0".to_string(),
            version: "0.6.0".to_string(),
            notes: None,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "available",
                "current_version": "0.5.0",
                "version": "0.6.0",
                "notes": null,
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheck::UpToDate {
                current_version: "0.5.0".to_string()
            })
            .unwrap(),
            serde_json::json!({"kind": "up_to_date", "current_version": "0.5.0"})
        );
    }
}
