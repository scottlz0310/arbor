# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

**Arbor** は Tauri v2 製のデスクトップアプリ。複数のローカル git リポジトリを一元管理する。
既存の Go CLI ツール **dsx** をアクション実行層として内包し、git2 クレートで可視化する。

> 方向性は dsx の実行・表示基盤 兼 開発環境リフレッシュナーへ移行中（Issue #294）。GitHub 連携・AI Insight・Graph・Stash・Branches は削除済み。

- 仕様書: `docs/arbor-spec-design-b_2.html`（インタラクティブモックアップ込み）
- タスク一覧: `tasks.md`（フェーズ別タスク + spec レビューノート）

## 開発コマンド

### 前提ツール
```bash
# git2 ビルドに cmake が必要 (Windows: MSVC Build Tools or Visual Studio)
rustup update           # Rust 1.78+
bun --version           # .bun-version に準拠（Node.js は不要）
dsx --version           # dsx CLI v0.2.5+ が PATH に必要
```

### 起動・ビルド
```bash
bun install             # フロントエンド依存インストール
bun run tauri dev       # 開発サーバー起動 (Vite + Tauri ホットリロード)
bun run tauri build     # リリースビルド (.msi / .dmg)
```

### Rust チェック
```bash
# Cargo.toml は src-tauri/ 配下のため --manifest-path を指定する
cargo check  --manifest-path src-tauri/Cargo.toml   # コンパイルチェック（ビルドなし、高速）
cargo clippy --manifest-path src-tauri/Cargo.toml   # Lint
cargo test   --manifest-path src-tauri/Cargo.toml   # テスト実行
```

### フロントエンドのみ
```bash
bun run dev             # Vite dev server のみ (Tauri なし)
bun run build           # TypeScript コンパイル + Vite ビルド
bun run typecheck       # 型チェックのみ（emit なし）
bun run test            # bun test（ワンショット）
bun run test:watch      # bun test ウォッチモード
bun run test:coverage   # カバレッジ付き（coverage/lcov.info を生成）
```

単一テストファイルを実行する場合:
```bash
bun test src/lib/ruleEngine.test.ts
```

テスト基盤は bun test + happy-dom。Tauri IPC（`@tauri-apps/api/core` / `event` / `plugin-dialog`）の
モックと zustand ストアのテスト間リセットは preload（`src/test/setup.ts`）に集約されている。
テストファイル内では `mock.module` を使わず、`spyOn` でモジュール関数を差し替え、
module レベルの spy を作ったファイルには `afterAll(() => mock.restore())` を入れること
（bun test は全ファイルを 1 プロセスで実行するため、spy がファイル間に漏れる）。

### Git フック（lefthook）

`lefthook.yml` で定義。`bun install` 実行時に自動インストールされる。

- **pre-commit（並列）**: `bun run typecheck`、`cargo check`
- **pre-push（直列）**: `cargo clippy -- -D warnings`、`cargo test`、`bun run test`

## アーキテクチャ

### レイヤー構造

```
Frontend (React 19 + Zustand)
        ↕  Tauri IPC (invoke / events)
Rust backend (Tauri commands)
    ├── git2 クレート     — 読み取り専用 git 操作
    ├── std::process::Command → dsx CLI  — 書き込み操作を委譲
    └── reqwest → GitHub Releases（dsx の最新バージョン確認のみ）
```

**重要な設計原則:**
- git の**一括操作**（fetch-all / pull / cleanup）は **dsx に委譲**し、Arbor 側で再実装しない
- git2 は主に**読み取り**（ステータス・Cleanup 候補の列挙）に使用する。
  ただし `fetch_all`（単一）・`fetch_repositories`（一括）と Cleanup の実行（`cleanup_execute`）は git2 で直接実装（dsx への往復コストを避けるため、個別選択に構造化データが必要なため）
- 破壊的操作は**必ず ConfirmDialog を経由**させる

### Rust バックエンド (`src-tauri/src/`)

ロジックは `commands/` などに置き、Tauri のコマンド（フロントエンドからの入口）は `ipc/` に置く。`commands/` の関数は、`ipc/` の同名のコマンドから呼ばれる（コマンド名は、フロントエンドの `invoke` と同じ）。

| ファイル | 責務 |
|---------|------|
| `lib.rs` | Tauri Builder + 全コマンドの `invoke_handler` 登録 |
| `ipc/` | `#[tauri::command]` の薄いラッパーだけ（`cleanup` / `config` / `dsx` / `fetch` / `repo` / `runner`）。ロジックは持たず、`commands/` の関数を呼ぶ。カバレッジの対象外で、`ipc/guard.rs` が薄さと `lib.rs` への登録を検査する |
| `models.rs` | `RepoInfo` / `BranchInfo` / `CommitNode` / `DsxOutput` 等の共有データ型 |
| `config.rs` | `AppConfig` の読み書き。`dirs::config_dir()` で OS ごとのパスを解決。未設定の `workspace.root` は、あれば `~/src` で補う |
| `workspace.rs` | 管理対象リポジトリの決定。`workspace.root` 直下（深さ 1。dsx の `repo.root` と同じ規則）の自動検出と、手動登録（ディスク上に無いものは除く）の和集合（`effective_repos`）。protected branches は、全体の既定（main / master / develop / dev）に、手動登録の設定を追加して解決する |
| `commands/repo.rs` | git2 によるリポジトリ情報コマンド群（`list_repositories` は実効リポジトリを最大 8 並列でスキャン、`get_repo_status`）、`fetch_all`、`open_repo_folder`（管理対象のリポジトリのフォルダだけを OS のファイルマネージャで開く） |
| `commands/config_cmd.rs` | config.toml CRUD（手動登録の追加・削除、`update_settings`、存在しない手動登録の検出）と `get_workspace_status`（Header の root 表示用） |
| `commands/dsx.rs` | dsx CLI ラッパー。実行は `commands/runner.rs` に委譲する。`dsx_check`（版と `supports_run_root`）、`bitwarden_status`、`repo_update` / `daily_refresh`（どちらも Arbor の `workspace.root` を `--root` で渡す。Daily Refresh は dsx v0.11.0 以上が必要） |
| `commands/fetch.rs` | 管理対象リポジトリの一括 fetch（`fetch_repositories`）。git2 で最大 4 並列に fetch し、1 件ごとの結果を runner の job としてコンソールへ流す。`cancel_run` で転送中の fetch も中断できる |
| `commands/runner.rs` | 外部コマンドの実行基盤（子プロセスを持たない処理は `run_job` で同じ枠に載せる）。stdout / stderr を行単位で `process_*` イベントとして送信し、同時実行は 1 件に制限する。`cancel_run` でプロセスツリーごと強制終了する（Windows は Job Object、Unix はプロセスグループ） |

### IPC ラッパーとカバレッジ

`#[tauri::command]` の関数は `src-tauri/src/ipc/` だけに置く。関数は、状態や設定を取り出し、`commands/` 側のテスト済みの関数を呼んで、結果を返すだけにする（分岐・繰り返し・変換などのロジックは `commands/` 側に置く）。

- `ipc/` は、カバレッジの対象から外している（CI の `cargo llvm-cov --ignore-filename-regex` と `codecov.yml` の `ignore`）。ラッパーは `tauri::State` を要し、Windows では `tauri::test` のテスト実行ファイルが起動しないため、単体テストできない。ロジックを持たないので、除外しても測るべきものは減らない。
- 除外が正当であり続けるように、`ipc/guard.rs` のテストが次を検査する。違反すると `cargo test` が失敗する。
  - `ipc/` に置けるのは、`use` / `mod` と `#[tauri::command]` の関数だけ。
  - コマンドの本文は 4 文以内で、`if` / `match` / `for` / `while` / `loop` / `&&` / `||` / `let ... else` を含まない（含むロジックは `commands/` へ切り出す）。
  - `ipc/` のコマンドと、`lib.rs` の `generate_handler!` の登録が、過不足なく一致する。
  - 除外の設定が `ipc/` を指している。
- 新しいコマンドを足すときは、ロジックを `commands/` に書いてテストし、`ipc/` に呼び出すだけの関数を足して、`lib.rs` に登録する。

### フロントエンド (`src/`)

| パス | 責務 |
|-----|------|
| `types/index.ts` | Rust モデルと 1:1 対応する TypeScript 型定義 |
| `lib/invoke.ts` | `@tauri-apps/api/core` の `invoke` を型安全にラップした関数群 |
| `lib/ruleEngine.ts` | ルールベース Insight 生成。diverged / far behind を検出 |
| `lib/processEvents.ts` | `process_*` イベントの購読。描画フレームごとにまとめて `consoleStore` へ反映する |
| `lib/ansi.ts` | ANSI エスケープの最小パーサ（前景 16 色・太字・薄字。他は除去） |
| `stores/repoStore.ts` | リポジトリ一覧と選択状態（Zustand） |
| `stores/uiStore.ts` | ナビゲーション状態・Toast（Zustand） |
| `stores/consoleStore.ts` | 実行ログ（リングバッファ 10,000 行）と実行状態（Zustand） |
| `stores/envStore.ts` | dsx の版・Bitwarden の状態・workspace root の現況（Header の pill 用。Zustand） |
| `lib/dsxActions.ts` | Daily Refresh / sys update / Update All の実行と Toast、Daily Refresh を実行できない理由の判定 |
| `lib/rescanAfterRun.ts` | run の終了を検知して、一覧と環境の状態を自動で読み直す |
| `views/` | ページコンポーネント（Status / Cleanup / Tools / Settings）。Status・Cleanup・Tools が Summary の下のタブで、Settings は Header から開く。Tools は dsx の版の確認・self-update と、sys update / `-n` / repo update / doctor の実行ボタン（出力は解析せず、コンソールに流すだけ） |
| `components/` | 共通 UI（Header, SummaryStrip, TabBar, AppBar, ConfirmDialog, Toast, LogConsole） |
| `lib/dsxVersion.ts` | `v0.11.0` / `dsx version 0.11.0` 形式の版の比較 |
| `lib/repoStatus.ts` | 要対応の判定（`needsAction`）、状態バッジ、Status タブの絞り込みと並び順 |
| `stores/cleanupStore.ts` | 直近の Cleanup プレビューの候補数（Summary 用。プレビューは remote へ接続して遅いため、自動では読み込まない） |

**データフロー:** Rust コマンド → `lib/invoke.ts` → Zustand store → React コンポーネント
**イベント:** Rust `runner.rs` が `process_started` / `process_output` / `process_finished` を emit → `lib/processEvents.ts`（`App.tsx` が購読）→ `consoleStore` → `LogConsole`（App 下部のドック）（ペイロードは `camelCase`。型は `types/index.ts` の `Process*`）

### 設定ファイル

- **実行時設定**: `dirs::config_dir()/arbor/config.toml`
  - Windows: `%APPDATA%\arbor\config.toml`
  - macOS: `~/Library/Application Support/arbor/config.toml`
- **リポジトリの範囲**: `workspace.root`（既定 `~/src`。空文字列で自動検出を無効化）の直下を自動検出し、`repositories`（手動登録）を足す。手動登録は root の外のリポジトリの追加と、名前・protected branches の追加に使う。
- **protected branches**: `settings.protected_branches`（既定 main / master / develop / dev）に、手動登録の `protected_branches` を追加して Cleanup に適用する

### 主要 Tauri コマンドマッピング

| Tauri コマンド | バックエンド処理 | 備考 |
|---------------|-----------------|------|
| `sys_update` / `sys_update_dry_run` | `dsx sys update --no-tui` / `... -n` | dry run は計画だけを表示する。dsx が管理するツール群を更新する（dsx 本体は更新しない） |
| `dsx_doctor` | `dsx doctor` | 依存ツールと設定の診断。出力は `process_output` イベントでストリーム |
| `repo_update` | `dsx repo update --root <workspace root> --no-tui --jobs 4` | root 配下の全リポジトリを更新。stdout / stderr を `process_output` イベントでストリーム |
| `daily_refresh` | `dsx run --root <workspace root> --no-tui --jobs 4` | Bitwarden 解錠 → 環境変数 → システム更新 → リポジトリ更新。dsx v0.11.0 未満では拒否する |
| `cleanup_preview` | git2 | 管理対象（自動検出 + 手動登録）の全リポジトリの削除候補を読み取り専用で列挙 |
| `cleanup_execute` | git2 | 選択候補を再検証して local branch 削除または remote-tracking ref prune を実行 |
| `fetch_repositories` | git2（`commands/fetch.rs`） | 全管理対象を最大 4 並列で fetch。進捗は `process_*` イベント、結果は `FetchSummary`。実行枠は dsx と共有（同時に 1 件） |

`repo_update` などの dsx コマンドは `runner` 経由でストリーミングする。Cleanup コマンドは
`commands/cleanup.rs` で実装し、dsx を呼び出さない。

### 認証の制約

git2 の fetch（`fetch_all` / `fetch_repositories`）は、`commands/fetch.rs` の `credentials_callback` で認証情報を取る。HTTPS は git の認証情報ヘルパー（`credential.helper`。Windows は Git Credential Manager）、SSH は ssh-agent を使う（git2 は、このコールバックを設定しないと、どちらも使わない）。認証情報を入力する UI は無い。認証情報が未設定、または誤っている場合、`remote.fetch(...)` のエラーが `Result::Err` としてフロントに返され、Toast とコンソールに表示される。

## 実装フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | シェル + dsx ラッパー + git2 可視化コア | スキャフォールド済み |
| 2〜4 | 旧計画（GitHub 連携・Graph・AI Insight）は廃止。Issue #294 のピボット計画に置き換え | 進行中 |

詳細タスクは `tasks.md` を参照。
