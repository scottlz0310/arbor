# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/). Unreleased changes are in `[Unreleased]`.

## [Unreleased]

### feat — Phase 4

- **コマンドパレット** (P4-01) (#102)
  - `Ctrl/Cmd+K` でパレットを開閉
  - ビュー遷移（7 件）・リポジトリ切替をインクリメンタル検索
  - `↑↓` でナビゲーション、`Enter` で実行、`Esc` で閉じる
  - `uiStore` に `commandPaletteOpen` / `openCommandPalette` / `closeCommandPalette` を追加
  - フロントエンドテスト 16 件追加

- **repo.rs インテグレーションテスト** (T-05)
  - `repo_info_for_path` の `modified_count` / `untracked_count` / `stash_count` / `ahead` / `behind` を一時 git リポジトリで検証
  - 追加テスト 7 件: modified_count, untracked_count, deleted_file_counts_as_modified, stash_count, multiple_stashes, ahead_count, behind_count
  - `ahead` / `behind` は git2 ローカルクローン + fetch で設定

- **CI check-runs を head_sha ベースに統一** (P4-11)
  - `PullRequest` モデル（Rust / TS）に `head_sha` フィールドを追加
  - `RawRef` に `sha` を追加し GitHub API レスポンスから取得
  - check-runs の queryKey / queryFn / checkMap を `head_sha` ベースに変更
  - fork PR で同名ブランチが重複するケースの誤った CI ドット表示を解消
  - force-push 後にキャッシュが自動無効化されるようになった
  - Rust ユニットテスト 1 件 + フロントエンドテスト 2 件追加

- **dsx バージョン管理 UI** (P4-04)
  - Settings の dsx CLI セクションに「バージョン確認」ボタンを追加
  - クリックで GitHub Releases API から最新タグを取得し現行バージョンと比較
  - 最新版なら ✓ 表示、新バージョンがあれば `go install` コマンドを案内
  - `dsx_latest_version` Rust コマンド追加（reqwest, 8s タイムアウト、エラー時は null）
  - フロントエンドテスト 5 件追加

- **Stash Manager** (P4-02/03) (#103)
  - `list_stashes` / `apply_stash` / `drop_stash` Rust コマンドを追加（git2 直接実装）
  - `StashInfo` 型を `models.rs` / `types/index.ts` に追加
  - `src/views/Stash.tsx` — stash 一覧テーブル + Apply / Drop 操作
  - Drop は `ConfirmDialog` 必須。操作後に `stash_count` バッジを更新
  - Drop の in-flight guard（`dropping` state）で二重実行・別 stash 誤削除を防止
  - Apply 中は全ボタンを disabled（`applyingIndex` state）
  - `useEffect` に cancelled flag を追加し repo 切り替え race を解消
  - `ConfirmDialog` に `confirmDisabled` prop を追加
  - Rust ユニットテスト 4 件 + フロントエンドテスト 10 件追加

### chore

- アプリアイコンをカスタムデザインに差し替え（全サイズ再生成） (#124)
- `.gitattributes` 追加 — 改行コード LF 統一、Cargo.toml の dirty 化を解消 (#124)
- `.gitignore` に `.claude/` を追加 (#124)

---

## [0.1.0-dev] — Phase 1–4 開発中

### feat — Phase 4

- **削除済みリポジトリの一括登録解除 UI** (P4-12) (#119)
  - `scan_missing_repositories` Rust コマンドを追加（`Path::exists()` で存在チェック）
  - Settings に「N件の無効なリポジトリ」バナー + チェックボックス一覧ダイアログ
  - ConfirmDialog 必須。config 削除のみ、ディスク削除なし

### feat — Phase 3 AI Insight

- **AI Insight フェーズバッジ & ローディングアニメーション** (#122)
  - ルール計算中 `⟳ Rules…`、AI 分析中 `✦ AI 分析中…`（パルスアニメーション）
  - AI 失敗 `✗ AI 失敗`（アンバー）、Ollama オフライン `⚠ Offline`（アンバー）
  - 健全状態の空メッセージを `✓ すべてのリポジトリは健全です`（緑）に変更
  - `arbor-spin` / `arbor-pulse` キーフレームを `global.css` に追加

- **AI Insight — バックグラウンド非同期化 & タイムアウト修正** (#116)
  - cache miss 時の同期フェッチを廃止し、常にバックグラウンド spawn に変更
  - `timeout_secs` デフォルトを 30 → 120 に変更
  - Ollama 未起動時に `⚠ Ollama offline` バッジを表示

- **AI 設定 UI** (P3-09) — Settings 画面の AI Engine セクションを編集可能フォームに刷新
  - provider / model / Ollama URL / timeout_secs を個別編集・保存
  - 「Test Connection」ボタンで Ollama 疎通確認
  - `update_ai_config` Rust コマンドを追加、保存後にキャッシュを即時無効化

- **AI Insight UI 統合** (P3-07/08)
  - Overview に「RECOMMENDED ACTIONS」パネルを追加
  - Cleanup Wizard に AI 理由テキスト表示（`✦ {aiReason}`）

- **AI Insight キャッシュ & フォールバック耐障害性** (P3-04/05)
  - `AiCacheState` による `hash(repoState)` ベースのキャッシュ
  - stale-while-revalidate — キャッシュヒット時は即返却 + バックグラウンド再計算
  - Ollama 不可時にルールベース Insight へフォールバック

- **Ollama バックエンド基盤** (P3-01/02/03/06)
  - `ollama_available` — 起動確認 (GET /api/tags)
  - `get_ai_insights` — リポジトリ状態から Insight 生成 (POST /api/generate)
  - `/no_think` + JSON-only プロンプトでモデル出力を安定化
  - `InsightKind` enum で LLM 出力の境界を型で閉じる

### feat — Phase 2 GitHub 連携 & コミットグラフ

- GitHub PAT を OS キーチェーン（keyring クレート）に保存 (P2-01)
- `get_pull_requests` / `get_issues` / `get_check_runs` Rust コマンド (P2-02/03/04)
- `PullRequests.tsx` — PR / Issue 一覧 + CI ステータスドット (P2-05)
- TanStack Query 導入 — GitHub API キャッシュ + 5分間隔自動リフレッシュ (P2-06)
- `get_commit_graph` — d3 向け CommitNode 配列 + lane 計算 (P2-07)
- `Graph.tsx` — SVG コミットグラフ (d3 lane 計算 + 素 SVG 描画) (P2-08)
- `env_inject` / `sys_update` dsx コマンドラッパー (P2-09/10)
- PAT 未設定時の GitHub API エラーを graceful に処理 (P2-12)

### feat — Phase 1 コア

- Tauri v2 + React 19 + TypeScript + Vite 6 プロジェクト初期化 (P1-02)
- git2 による `list_repositories` / `get_repo_status` / `get_branches` (P1-12/13/14)
- `delete_branches` / `fetch_all` (P1-15/16)
- dsx ラッパー: `repo_update` (ストリーミング) / `repo_cleanup_preview` / `repo_cleanup` (P1-17〜20)
- Overview / Branches / Cleanup / Settings / PullRequests / Graph ビュー (P1-30〜33, P2-05/08)
- ルールベース Insight Engine (P1-35): diverged / stale / behind / merged 検出
- React ErrorBoundary + Toast + ConfirmDialog (P1-37/28/29)
- `AppConfig` の TOML 読み書き、OS ごとのパス解決 (P1-09/10)

### chore

- Renovate による依存自動更新を設定
- keyring v3 → keyring-core v1 移行 (#75)
- macOS / Linux の Rust CI チェックを追加 (#77)
- pnpm v11 へアップグレード (#85)

### ci

- `.github/workflows/ci.yml` — Rust (check / clippy / test + llvm-cov) + Frontend (typecheck / build / vitest) (#T-06)
- Codecov フラグ別カバレッジ管理（frontend / rust） (#T-08)
- lefthook pre-commit (typecheck + cargo check) / pre-push (clippy + test) (#T-07)
