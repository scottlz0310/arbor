//! Arbor 自身の更新（Tauri updater。macOS と Linux の AppImage 向け）。
//!
//! 更新の有無は、リリースの `latest.json`（`tauri.conf.json` の `plugins.updater.endpoints`）で調べる。
//! Windows は MSIX の `.appinstaller` が更新するため、アプリ内では更新しない。
//! 確認と適用の流れは、外部（ネットワーク・ファイル置き換え）を関数で受け取り、テストで差し替える。

use super::runner::{JobContext, Runner, RunnerState, Stream};
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

/// 更新を適用して再起動する。ダウンロードから再起動までを runner の `run_job` に載せ、実行中の他のコマンド
/// （dsx・fetch など）と同時に走らせない（再起動で、実行中のコマンドを途中で切らないため）。
/// 対応していない環境では、枠を取らず、何もせずに、エラーを返す。
///
/// 「キャンセル」は、ファイルを置き換える前までなら効く: ダウンロードの完了を待って、置き換えずに捨てる
/// （進行中のダウンロードは、途中では止めない）。置き換えが始まったら、取り消さずに再起動まで進む
/// （置き換えの途中で止めると、中途半端な状態が残るため）。
pub fn install_update<T>(
    runner: &Runner,
    unsupported: Option<&str>,
    download: impl FnOnce() -> Result<T, String>,
    apply: impl FnOnce(T) -> Result<(), String>,
    restart: impl FnOnce(),
) -> Result<(), String> {
    if let Some(reason) = unsupported {
        return Err(reason.to_string());
    }

    runner
        .run_job("Arbor update", |ctx| {
            ctx.log(Stream::Stdout, "[arbor] 更新をダウンロードします");
            let downloaded = match download() {
                Ok(downloaded) => downloaded,
                Err(e) => return fail(ctx, e),
            };
            if ctx.is_cancelled() {
                ctx.log(Stream::Stderr, "[arbor] キャンセルされたため、適用しません");
                return (1, Err("更新をキャンセルしました".to_string()));
            }

            ctx.log(
                Stream::Stdout,
                "[arbor] 適用します（この間は取り消せません）",
            );
            match apply(downloaded) {
                Ok(()) => {
                    ctx.log(Stream::Stdout, "[arbor] 適用しました。再起動します");
                    restart();
                    (0, Ok(()))
                }
                Err(e) => fail(ctx, e),
            }
        })?
        .value
}

fn fail(ctx: &JobContext, message: String) -> (i32, Result<(), String>) {
    ctx.log(Stream::Stderr, format!("[arbor] {message}"));
    (1, Err(message))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::runner::{
        EventSink, ProcessFinished, ProcessOutput, ProcessStarted, SystemLauncher,
    };
    use std::cell::Cell;
    use std::sync::{Arc, Mutex};

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

    #[derive(Default)]
    struct RecordingSink {
        lines: Mutex<Vec<(Stream, String)>>,
        finished: Mutex<Vec<ProcessFinished>>,
    }

    impl EventSink for RecordingSink {
        fn started(&self, _: &ProcessStarted) {}

        fn output(&self, event: &ProcessOutput) {
            self.lines
                .lock()
                .unwrap()
                .push((event.stream, event.text.clone()));
        }

        fn finished(&self, event: &ProcessFinished) {
            self.finished.lock().unwrap().push(event.clone());
        }
    }

    fn runner(sink: &Arc<RecordingSink>) -> Arc<Runner> {
        Arc::new(Runner::new(
            Arc::new(SystemLauncher),
            Arc::clone(sink) as Arc<dyn EventSink>,
        ))
    }

    #[test]
    fn install_update_installs_then_restarts_inside_the_slot() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);
        let restarted = Cell::new(false);

        let result = install_update(
            &runner,
            None,
            || {
                // ダウンロードの最中は枠が埋まっていて、他のコマンドを始められない。
                assert!(runner.run_job("other", |_| (0, ())).is_err());
                Ok("bytes")
            },
            |bytes| {
                assert_eq!(bytes, "bytes");
                assert!(runner.run_job("other", |_| (0, ())).is_err());
                Ok(())
            },
            || {
                assert!(runner.run_job("other", |_| (0, ())).is_err());
                restarted.set(true);
            },
        );

        assert_eq!(result, Ok(()));
        assert!(restarted.get());
        assert_eq!(sink.finished.lock().unwrap()[0].exit_code, Some(0));
        // 終わったら枠が空く。
        assert!(runner.run_job("other", |_| (0, ())).is_ok());
    }

    #[test]
    fn install_update_reports_failure_without_restarting() {
        // (ダウンロードの失敗, 適用の失敗)
        let cases: [(Option<&str>, Option<&str>); 2] =
            [(Some("network down"), None), (None, Some("disk full"))];

        for (download_error, apply_error) in cases {
            let sink = Arc::new(RecordingSink::default());
            let runner = runner(&sink);
            let applied = Cell::new(false);

            let result = install_update(
                &runner,
                None,
                || download_error.map_or(Ok(()), |e| Err(e.to_string())),
                |()| {
                    applied.set(true);
                    apply_error.map_or(Ok(()), |e| Err(e.to_string()))
                },
                || panic!("失敗したら、再起動しない"),
            );

            let message = download_error.or(apply_error).unwrap();
            assert_eq!(result, Err(message.to_string()), "{message}");
            assert_eq!(applied.get(), download_error.is_none(), "{message}");
            assert_eq!(sink.finished.lock().unwrap()[0].exit_code, Some(1));
            assert!(sink
                .lines
                .lock()
                .unwrap()
                .iter()
                .any(|(s, t)| *s == Stream::Stderr && t.contains(message)));
            assert!(runner.run_job("other", |_| (0, ())).is_ok());
        }
    }

    #[test]
    fn install_update_cancelled_during_download_is_not_applied() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);

        let result = install_update(
            &runner,
            None,
            || {
                // 実行中の更新は、最初の run（run 1）として枠にいる。キャンセルは受理される。
                runner.cancel(1).unwrap();
                Ok(())
            },
            |()| panic!("キャンセルされたら、適用しない"),
            || panic!("キャンセルされたら、再起動しない"),
        );

        assert_eq!(result, Err("更新をキャンセルしました".to_string()));
        let finished = sink.finished.lock().unwrap();
        assert!(finished[0].cancelled);
        assert_eq!(finished[0].exit_code, Some(1));
        drop(finished);
        assert!(runner.run_job("other", |_| (0, ())).is_ok());
    }

    #[test]
    fn install_update_does_not_abort_once_applying() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);
        let restarted = Cell::new(false);

        let result = install_update(
            &runner,
            None,
            || Ok(()),
            |()| {
                // 置き換えの途中で止めると中途半端な状態が残るため、取り消さずに再起動まで進む。
                runner.cancel(1).unwrap();
                Ok(())
            },
            || restarted.set(true),
        );

        assert_eq!(result, Ok(()));
        assert!(restarted.get());
    }

    #[test]
    fn install_update_refuses_when_unsupported() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);

        let result = install_update(
            &runner,
            Some("Windows です"),
            || -> Result<(), String> {
                panic!("対応していない環境では、ダウンロードしない")
            },
            |()| panic!("対応していない環境では、適用しない"),
            || panic!("対応していない環境では、再起動しない"),
        );

        assert_eq!(result, Err("Windows です".to_string()));
        assert!(sink.finished.lock().unwrap().is_empty());
    }

    #[test]
    fn install_update_is_rejected_while_another_command_is_running() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);
        let (inside_tx, inside_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = {
            let runner = Arc::clone(&runner);
            std::thread::spawn(move || {
                runner.run_job("other", |_| {
                    inside_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    (0, ())
                })
            })
        };
        inside_rx.recv().unwrap();

        let result = install_update(
            &runner,
            None,
            || -> Result<(), String> {
                panic!("別のコマンドの実行中は、ダウンロードしない")
            },
            |()| panic!("別のコマンドの実行中は、適用しない"),
            || panic!("別のコマンドの実行中は、再起動しない"),
        );

        release_tx.send(()).unwrap();
        holder.join().unwrap().unwrap();
        assert!(result.unwrap_err().contains("別のコマンドを実行中"));
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
