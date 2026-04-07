# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

**Arbor** は Tauri v2 製のデスクトップアプリ。複数のローカル git リポジトリを一元管理する。
既存の Go CLI ツール **dsx** をアクション実行層として内包し、git2 クレートで可視化、GitHub REST API で PR/Issue 連携、Ollama で AI Insight を提供する。

- 仕様書: `docs/arbor-spec-design-b_2.html`（インタラクティブモックアップ込み）
- タスク一覧: `tasks.md`（フェーズ別タスク + spec レビューノート）

## 開発コマンド

### 前提ツール
```bash
# git2 ビルドに cmake が必要 (Windows: MSVC Build Tools or Visual Studio)
rustup update           # Rust 1.78+
node --version          # Node 24 LTS
pnpm --version          # pnpm 10+（npm/npx の代わりに使用）
dsx --version           # dsx CLI v0.2.5+ が PATH に必要
```

### 起動・ビルド
```bash
pnpm install            # フロントエンド依存インストール
pnpm tauri dev          # 開発サーバー起動 (Vite + Tauri ホットリロード)
pnpm tauri build        # リリースビルド (.msi / .dmg)
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
pnpm dev                # Vite dev server のみ (Tauri なし)
pnpm build              # TypeScript コンパイル + Vite ビルド
pnpm typecheck          # 型チェックのみ（emit なし）
pnpm test               # vitest run（ワンショット）
pnpm test:watch         # vitest ウォッチモード
pnpm test:coverage      # カバレッジ付き（coverage/lcov.info を生成）
```

単一テストファイルを実行する場合:
```bash
pnpm vitest run src/lib/ruleEngine.test.ts
```

### Git フック（lefthook）

`lefthook.yml` で定義。`pnpm install` 実行時に自動インストールされる。

- **pre-commit（並列）**: `pnpm run typecheck`、`cargo check`
- **pre-push（直列）**: `cargo clippy -- -D warnings`、`cargo test`、`pnpm test`

## アーキテクチャ

### レイヤー構造

```
Frontend (React 19 + Zustand)
        ↕  Tauri IPC (invoke / events)
Rust backend (Tauri commands)
    ├── git2 クレート     — 読み取り専用 git 操作
    ├── std::process::Command → dsx CLI  — 書き込み操作を委譲
    ├── reqwest → GitHub REST API v3
    └── reqwest → Ollama (Phase 3)
```

**重要な設計原則:**
- git の**一括操作**（fetch-all / pull / cleanup）は **dsx に委譲**し、Arbor 側で再実装しない
- git2 は主に**読み取り**（ステータス・ブランチ一覧・コミットグラフ）に使用する。
  ただし単一リポジトリの `fetch_all` と `delete_branches` は git2 で直接実装（dsx への往復コストを避けるため）
- AI（Ollama）は **Explain / Prioritize / Risk の説明生成のみ**。コマンド実行は一切しない
- 破壊的操作は**必ず ConfirmDialog を経由**させる

### Rust バックエンド (`src-tauri/src/`)

| ファイル | 責務 |
|---------|------|
| `lib.rs` | Tauri Builder + 全コマンドの `invoke_handler` 登録 |
| `models.rs` | `RepoInfo` / `BranchInfo` / `CommitNode` / `DsxOutput` 等の共有データ型 |
| `config.rs` | `AppConfig` の読み書き。`dirs::config_dir()` で OS ごとのパスを解決 |
| `commands/repo.rs` | git2 によるリポジトリ情報コマンド群（`list_repositories`, `get_branches`, `get_repo_status`）と、一部書き込み操作（`delete_branches`, `fetch_all`） |
| `commands/config_cmd.rs` | config.toml CRUD + `scan_directory`（再帰的 git リポジトリ検索） |
| `commands/dsx.rs` | dsx CLI ラッパー。長時間処理は `app_handle.emit("dsx_progress", line)` でフロントにストリーム送信 |

新しい Tauri コマンドを追加したら `lib.rs` の `invoke_handler!` に登録する。

### フロントエンド (`src/`)

| パス | 責務 |
|-----|------|
| `types/index.ts` | Rust モデルと 1:1 対応する TypeScript 型定義 |
| `lib/invoke.ts` | `@tauri-apps/api/core` の `invoke` を型安全にラップした関数群 |
| `lib/ruleEngine.ts` | ルールベース Insight 生成（AI なし・Phase 1）。diverged/stale/behind を検出 |
| `stores/repoStore.ts` | リポジトリ一覧と選択状態（Zustand） |
| `stores/uiStore.ts` | ナビゲーション状態・Toast・dsx 進捗ログ（Zustand） |
| `views/` | ページコンポーネント。Overview / Branches / Cleanup / Settings が Phase 1 実装済み |
| `components/` | 共通 UI（Sidebar, AppBar, ConfirmDialog, Toast） |

**データフロー:** Rust コマンド → `lib/invoke.ts` → Zustand store → React コンポーネント
**イベント:** Rust `emit("dsx_progress", line)` → `App.tsx` の `listen()` → `uiStore.appendDsxLine()`
**サーバー状態:** `@tanstack/react-query` は現在依存関係に含まれているが、Phase 1 では未使用。Phase 2 以降の GitHub API キャッシュ用途を想定。

### 設定ファイル

- **実行時設定**: `dirs::config_dir()/arbor/config.toml`
  - Windows: `%APPDATA%\arbor\config.toml`
  - macOS: `~/Library/Application Support/arbor/config.toml`
- **GitHub PAT**: OS キーチェーン（keyring クレート）に保存。`config.settings.github_keychain_key` がキー名
- **AI モデル**: `config.ai.model`。デフォルト `qwen3.5:latest`（`ollama list` で確認済み）

### dsx コマンドマッピング

| Tauri コマンド | dsx コマンド | 備考 |
|---------------|------------|------|
| `repo_update` | `dsx repo update --no-tui --jobs 4` | stdout を `dsx_progress` イベントでストリーム |
| `repo_cleanup_preview` | `dsx repo cleanup -n` | dry-run、stdout をそのままフロントに返す |
| `repo_cleanup` | `dsx repo cleanup` | ConfirmDialog 後に呼び出す |

`repo_update` と `repo_cleanup` は `run_dsx_with_events` を使いストリーミング。`repo_cleanup_preview` は `run_dsx_sync`（同期）。

### 認証の制約（Phase 1）

`fetch_all` は git2 のシステム git 認証情報ヘルパー / SSH エージェントに依存する。SSH / HTTPS 認証情報 UI は Phase 2 以降。HTTPS リポジトリで認証情報が未設定の場合、`remote.fetch(...)` のエラーが `Result::Err` としてフロントに返され、UI 側で例外を捕捉して Toast 表示される。

## 実装フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | シェル + dsx ラッパー + git2 可視化コア | スキャフォールド済み |
| 2 | GitHub PR/Issue 連携 + SVG コミットグラフ (d3) | 未着手 |
| 3 | Ollama AI Insight Engine | 未着手 |
| 4 | UX 磨き + リリース | 未着手 |

詳細タスクは `tasks.md` を参照。
