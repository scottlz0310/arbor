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
node --version          # Node 20 LTS
dsx --version           # dsx CLI v0.2.2+ が PATH に必要
```

### 起動・ビルド
```bash
npm install             # フロントエンド依存インストール
cargo tauri dev         # 開発サーバー起動 (Vite + Tauri ホットリロード)
cargo tauri build       # リリースビルド (.msi / .dmg)
```

### Rust チェック
```bash
cd src-tauri
cargo check             # コンパイルチェック（ビルドなし、高速）
cargo clippy            # Lint
cargo test              # テスト実行
```

### フロントエンドのみ
```bash
npm run dev             # Vite dev server のみ (Tauri なし)
npm run build           # TypeScript コンパイル + Vite ビルド
```

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
- git の書き込み操作（fetch/pull/cleanup）は **すべて dsx に委譲**し、Arbor 側で再実装しない
- git2 は **読み取り専用**（ステータス・ブランチ一覧・コミットグラフ）のみ使用
- AI（Ollama）は **Explain / Prioritize / Risk の説明生成のみ**。コマンド実行は一切しない
- 破壊的操作は**必ず ConfirmDialog を経由**させる

### Rust バックエンド (`src-tauri/src/`)

| ファイル | 責務 |
|---------|------|
| `lib.rs` | Tauri Builder + 全コマンドの `invoke_handler` 登録 |
| `models.rs` | `RepoInfo` / `BranchInfo` / `CommitNode` / `DsxOutput` 等の共有データ型 |
| `config.rs` | `AppConfig` の読み書き。`dirs::config_dir()` で OS ごとのパスを解決 |
| `commands/repo.rs` | git2 による読み取りコマンド群 (`list_repositories`, `get_branches`, `delete_branches`, `fetch_all`) |
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

## 実装フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | シェル + dsx ラッパー + git2 可視化コア | スキャフォールド済み |
| 2 | GitHub PR/Issue 連携 + SVG コミットグラフ (d3) | 未着手 |
| 3 | Ollama AI Insight Engine | 未着手 |
| 4 | UX 磨き + リリース | 未着手 |

詳細タスクは `tasks.md` を参照。
