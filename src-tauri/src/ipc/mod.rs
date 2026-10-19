//! Tauri のコマンド（フロントエンドからの呼び出しの入口）。
//!
//! このディレクトリには、`#[tauri::command]` の関数だけを置く。関数は、状態や設定を取り出し、
//! `commands/` 側のテスト済みの関数を呼んで、結果を返すだけにする。分岐・繰り返し・変換などのロジックは、
//! `commands/` 側に置く。
//!
//! 薄いラッパーは、`tauri::State` を要するため単体テストが難しい（Windows では `tauri::test` のテスト実行ファイルが
//! 起動しない）。そのためこのディレクトリは、カバレッジの対象から外している（CI の `cargo llvm-cov
//! --ignore-filename-regex` と `codecov.yml` の `ignore`）。除外が正当であり続けるように、下の `guard` のテストが、
//! ロジックが紛れ込んでいないことと、`lib.rs` への登録漏れがないことを検査する。

pub mod cleanup;
pub mod config;
pub mod dsx;
pub mod fetch;
pub mod repo;
pub mod runner;

#[cfg(test)]
mod guard;
