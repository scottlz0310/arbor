# Arbor — Implementation Tasks

> spec v0.3.0 ベースのタスク一覧。`[ ]` = 未着手 / `[x]` = 完了 / `[-]` = スキップ/延期

---

## レビューノート & 改善提案 (spec v0.3 → 実装差分)

### 仕様の明確化が必要な点
1. **dsx dry-run 出力スキーマ未定義** — `dsx repo cleanup -n` の stdout が JSON かテキストかが不明。
   実装前に `dsx repo cleanup -n --json` フラグの有無を確認し、パーサーを決める。
2. **`delete_branches` の実装先** — Branches ビューのチェックボックス削除は git2 直接か dsx 経由か不明。
   → 提案: **Branches ビューは git2 直接削除**（確認ダイアログ必須）、**Cleanup Wizard は dsx cleanup 経由** に分離する。
3. **`dsx repo update` の `--no-tui` フラグ** — Tauri コマンドマッピング表は `--tui -j 4` と記載しているが、
   Rust コード例は `--no-tui` を使用。GUI ラッパー用途のため **`--no-tui`（または `--json`）** に統一する。
4. **config.toml パス (Windows)** — 仕様は `~/.config/arbor/config.toml` と記載だが、
   Windows では `%APPDATA%\arbor\config.toml` が正しい。`dirs::config_dir()` で OS 対応を自動化する。
5. **`fetch_all` の認証フロー** — SSH / HTTPS 両対応と記載されているが git2 の credential callback 実装は複雑。
   Phase 1 は HTTPS + git credential helper フォールバックのみに限定し、SSH は Phase 2 に延期を推奨。

### データモデルへの追加提案
6. **`RepoInfo` に `untracked_count: u32` を追加** — Overview の MODIFIED カードは unstaged + untracked の合計が自然。
7. **`RepoInfo` に `last_fetched_at: Option<i64>` を追加** — 最終フェッチ時刻をサイドバーに表示するために必要。
8. **`BranchInfo` に `is_squash_merged: bool` を追加** — dsx が squash merge 判定を行うため、
   dry-run 結果のパース時に区別できると Cleanup Wizard の表示が正確になる。

### アーキテクチャへの改善提案
9. **長時間処理に Tauri Events を使う** — `repo_update` / `repo_cleanup` のような dsx 呼び出しは
   `Command::spawn()` + stdout streaming + `app_handle.emit("dsx_progress", ...)` パターンで
   リアルタイム進捗をフロントに送る。現仕様の `Command::output()` は完了まで UI がブロックされる。
10. **リポジトリ自動スキャン機能** — フォルダ選択 → 再帰的に `.git` ディレクトリを探索して一括登録する
    `scan_directory` コマンドを追加するとオンボーディングが大幅に改善される。
11. **Settings 画面のモックアップが欠如** — ロードマップに登場するが mockup セクションに存在しない。
    Phase 1 から Settings ビューを nav に加えることを推奨。
12. **React エラーバウンダリ** — invoke 失敗時のエラー表示はトーストのみの仕様だが、
    ビュー単位の `<ErrorBoundary>` も用意するとデバッグ効率が上がる。
13. **Stash Manager** — Phase 4 に記載されているが `stash_count` は Phase 1 から RepoInfo に含まれる。
    Branches ビューにスタッシュ枚数バッジだけ Phase 1 で表示し、Stash Manager UI は Phase 4 に残す。
14. **Ollama モデル名** — `ollama list` で確認済み。実モデル名は `qwen3.5:latest`。
    `config.rs` のデフォルト値を修正済み。

---

## Phase 1 — シェル + dsx ラッパー + 可視化コア (weeks 1–2)

### 環境・プロジェクト初期化
- [x] P1-01: 前提ツール確認 (Rust 1.78+, Node 20 LTS, cmake, git2 ビルド用 C コンパイラ)
- [x] P1-02: Tauri v2 + React 19 + TypeScript + Vite 6 プロジェクト初期化
- [x] P1-03: `src-tauri/Cargo.toml` 依存クレート設定
       (tauri, git2, serde, toml, dirs, keyring, reqwest, tokio)
- [x] P1-04: `package.json` 依存パッケージ設定
       (react, zustand, @tanstack/react-query, @tauri-apps/api, @tauri-apps/plugin-dialog)
- [x] P1-05: `tauri.conf.json` — ウィンドウ設定 (1280x800, min 900x600)
- [x] P1-06: `capabilities/default.json` — dialog プラグイン権限
- [x] P1-07: デザイントークン CSS (`src/styles/tokens.css`) 定義

### Rust バックエンド — データモデル & 設定
- [x] P1-08: `src-tauri/src/models.rs` — RepoInfo / BranchInfo / CommitNode / DeleteResult / DsxOutput 型定義
- [x] P1-09: `src-tauri/src/config.rs` — AppConfig / Settings / AiConfig / RepoConfig 型定義
- [x] P1-10: `config.rs` — `load_config()` / `save_config()` 実装 (dirs::config_dir() で OS 対応)
- [x] P1-11: `commands/config_cmd.rs` — `get_config` / `add_repository` / `remove_repository` / `scan_directory` コマンド

### Rust バックエンド — git2 読み取りコマンド
- [x] P1-12: `commands/repo.rs` — `list_repositories` (config の全リポジトリを git2 でスキャン)
- [x] P1-13: `commands/repo.rs` — `get_repo_status` (ahead/behind/modified/untracked/stash_count)
- [x] P1-14: `commands/repo.rs` — `get_branches` (ローカルブランチ全取得、is_merged 判定)
- [x] P1-15: `commands/repo.rs` — `delete_branches` (確認済み削除、current ブランチはスキップ)
- [x] P1-16: `commands/repo.rs` — `fetch_all` (HTTPS + git credential helper, Phase 1 スコープ)

### Rust バックエンド — dsx ラッパー
- [x] P1-17: `commands/dsx.rs` — `dsx_check` (PATH 上に dsx があるか確認 + バージョン取得)
- [x] P1-18: `commands/dsx.rs` — `repo_update` (`dsx repo update --no-tui -j 4` + Tauri emit で進捗通知)
- [x] P1-19: `commands/dsx.rs` — `repo_cleanup_preview` (`dsx repo cleanup -n` → stdout パース)
- [x] P1-20: `commands/dsx.rs` — `repo_cleanup` (`dsx repo cleanup` → 確認ダイアログ後実行)
- [x] P1-21: `lib.rs` — 全コマンドを `invoke_handler` に登録

### フロントエンド — 型 & ストア
- [x] P1-22: `src/types/index.ts` — Rust モデルに対応する TypeScript 型定義
- [x] P1-23: `src/lib/invoke.ts` — 型安全な invoke ラッパー関数群
- [x] P1-24: `src/stores/repoStore.ts` — Zustand ストア (repos / selectedRepo / loading / error)
- [x] P1-25: `src/stores/uiStore.ts` — Zustand ストア (activeView / notifications / dsx_progress)

### フロントエンド — コンポーネント & ビュー
- [x] P1-26: `src/components/Sidebar.tsx` — リポジトリリスト + ナビゲーション
- [x] P1-27: `src/components/AppBar.tsx` — パスブレッドクラム + アクションボタン
- [x] P1-28: `src/components/Toast.tsx` — エラー / 成功通知
- [x] P1-29: `src/components/ConfirmDialog.tsx` — 破壊的操作確認ダイアログ
- [x] P1-30: `src/views/Overview.tsx` — stat カード + repo グリッド
- [x] P1-31: `src/views/Branches.tsx` — ブランチテーブル (フィルター / チェックボックス / 削除)
- [x] P1-32: `src/views/Cleanup.tsx` — Cleanup Wizard (merged / stale / git maintenance セクション)
- [x] P1-33: `src/views/Settings.tsx` — リポジトリ管理 + dsx バージョン確認 + 設定 CRUD
- [x] P1-34: `src/App.tsx` — レイアウトシェル + ビュールーティング + 起動時 loadRepos()

### ルールベース Insight Engine (AI なし)
- [x] P1-35: `src/lib/ruleEngine.ts` — ルールベース Insight 実装
       - diverged → high risk
       - stale branch (> stale_threshold_days) → explain
       - merged branches count → prioritize cleanup
       - repo behind > 5 → prioritize pull

### 品質
- [x] P1-36: dsx 未インストール時の案内 UI (Settings 画面にインストール手順表示)
- [x] P1-37: `<ErrorBoundary>` コンポーネント追加 (ビュー単位でエラーを捕捉)
- [x] P1-38: 起動時 dsx_check → 未検出なら Settings ビューに遷移 + バナー表示
- [x] P1-39: 全破壊的操作 (delete_branches / repo_cleanup) に `<ConfirmDialog>` を挟む確認
- [x] P1-40: Windows / macOS 両方での動作確認

---

## テスト & CI/CD

### フロントエンドテスト
- [x] T-01: `vitest` 導入 + `vitest.config.ts` 設定
- [x] T-02: `src/lib/ruleEngine.test.ts` — ルールエンジン全ロジックのユニットテスト (12 ケース)
- [ ] T-03: `@testing-library/react` 導入 + 主要コンポーネントのスナップショットテスト (Phase 2 以降)

### Rust テスト
- [x] T-04: `config.rs` — デフォルト値・TOML ラウンドトリップのユニットテスト (4 ケース)
- [ ] T-05: `repo.rs` — `repo_info_for_path` のインテグレーションテスト (Phase 2 以降)

### CI (GitHub Actions)
- [x] T-06: `.github/workflows/ci.yml` — PR/push ごとに以下を実行
       - Rust: `cargo check` → `cargo clippy -D warnings` → `cargo llvm-cov --lcov` → Codecov upload (flag: rust)
       - Frontend: `npm ci` → `typecheck` → `build` → `vitest --coverage` → Codecov upload (flag: frontend)
- [x] T-08: `codecov.yml` — フラグ別カバレッジ管理（frontend / rust）+ PR コメント設定

### pre-commit / pre-push (lefthook)
- [x] T-07: `lefthook.yml` 設定 + `npm run prepare` でフックをインストール
       - pre-commit (parallel): `tsc --noEmit` + `cargo check`（高速チェック）
       - pre-push (serial): `cargo clippy -D warnings` + `cargo test` + `npm test`

---

## Phase 2 — GitHub 連携 + コミットグラフ + dsx env/sys (weeks 3–4)

- [x] P2-01: PAT 設定 UI + `keyring` クレートで OS キーチェーンに保存
- [x] P2-02: `commands/github.rs` — `get_pull_requests` (GitHub REST API GET /repos/{o}/{r}/pulls)
- [x] P2-03: `commands/github.rs` — `get_issues` (state: open/closed/all)
- [x] P2-04: `commands/github.rs` — `get_check_runs` (CI ステータス取得)
- [x] P2-05: `src/views/PullRequests.tsx` — PR / Issue 一覧 + CI ステータスドット
- [x] P2-06: TanStack Query 導入 — GitHub API キャッシュ + 5分間隔自動リフレッシュ
- [ ] P2-07: `commands/repo.rs` — `get_commit_graph` (d3 向け CommitNode 配列 + lane 計算)
- [ ] P2-08: `src/views/Graph.tsx` — SVG コミットグラフ (d3 lane 計算 + 素 SVG 描画)
- [ ] P2-09: `commands/dsx.rs` — `env_inject` (`dsx env run -- {cmd}`)
- [ ] P2-10: `commands/dsx.rs` — `sys_update` (`dsx sys update --no-tui`)
- [ ] P2-11: Settings 画面に sys_update ボタン追加
- [x] P2-12: PAT 未設定時の GitHub API エラーを graceful に処理 (PR ビュー無効化 + 設定案内)

---

## Phase 3 — AI Insight Engine — Ollama 統合 (week 5)

- [ ] P3-01: `commands/ai.rs` — `ollama_available` (GET /api/tags で起動確認)
- [ ] P3-02: `commands/ai.rs` — `get_ai_insights` (State Aggregator → qwen prompt → JSON パース)
- [ ] P3-03: State Aggregator 実装 (git2 + GitHub API → 構造化 JSON)
- [ ] P3-04: `hash(repoState)` ベースキャッシュ + バックグラウンド更新 (Tauri emit)
- [ ] P3-05: Ollama 未起動時 / タイムアウト時のフォールバック (ルールベースのみで継続)
- [ ] P3-06: `/no_think` + JSON-only 出力プロンプト実装
- [ ] P3-07: Overview「Recommended Actions」パネル
- [ ] P3-08: Cleanup Wizard に AI 理由テキスト表示
- [ ] P3-09: Settings 画面から provider / model / URL / timeout 変更可能に

---

## Phase 4 — UX 磨き + リリース (week 6)

- [ ] P4-01: Cmd/Ctrl+K コマンドパレット
- [ ] P4-02: `commands/repo.rs` — `list_stashes` / `apply_stash` / `drop_stash`
- [ ] P4-03: `src/views/Stash.tsx` — Stash Manager UI (一覧 / apply / drop)
- [ ] P4-04: dsx バージョン表示 + アップデート確認 UI (Settings 画面)
- [ ] P4-05: Tauri updater + GitHub Releases 自動更新フロー設定
- [ ] P4-06: Windows (.msi) インストーラービルド (`tauri build`)
- [ ] P4-07: macOS (.dmg) インストーラービルド
- [ ] P4-08: README / CHANGELOG 整備
- [ ] P4-09: GitHub public release 公開 (v0.1.0)
- [ ] P4-10: アクセシビリティ確認 (キーボードナビゲーション / フォーカス管理)
- [ ] P4-11: `PullRequest` モデルに `head_sha` を追加し、CI check-runs のキーと API ref を SHA ベースに統一
       (現在は `pr.number` をキャッシュキーに使用。fork PR で同名ブランチが重複する場合の完全な解決策として Phase 4 で対応)

---

## ビルド前提条件チェックリスト

- [x] Rust 1.78+ (`rustup update`)
- [x] Node.js 20 LTS
- [ ] cmake (git2 ビルドに必要)
- [x] Windows: MSVC Build Tools または Visual Studio
- [ ] macOS: Xcode Command Line Tools
- [x] `cargo install tauri-cli@^2`
- [ ] dsx CLI v0.2.2+ が PATH に存在
- [ ] (Phase 3) Ollama インストール済み + `qwen3.5:latest` モデル取得済み（未導入の場合: `ollama pull qwen3.5:latest` を実行）
