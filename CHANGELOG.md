# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/).

## [0.1.0] — 2026-05-23

### feat — Phase 4: UX 磨き + リリース

- **クロスプラットフォームリリース workflow** (P4-05/06/07) (#140)
  - `.github/workflows/release.yml` 新規作成（`v*` タグ push / `workflow_dispatch` で発火）
  - matrix ビルド（windows / macos / ubuntu）+ updater 署名 + `latest.json` 自動生成

- **Tauri 自動更新 (updater)** (P4-05) (#138 / #139)
  - `tauri-plugin-updater` 導入、GitHub Releases の `latest.json` をエンドポイントに設定
  - minisign 鍵ペア生成、公開鍵を `tauri.conf.json` に登録、秘密鍵を GitHub Secrets に配置

- **コマンドパレット** (P4-01) (#102)
  - `Ctrl/Cmd+K` でパレットを開閉、ビュー遷移・リポジトリ切替をインクリメンタル検索

- **Stash Manager** (P4-02/03) (#103)
  - `list_stashes` / `apply_stash` / `drop_stash`（git2 直接実装）
  - stash 一覧テーブル + Apply / Drop UI（Drop は ConfirmDialog 必須）

- **dsx バージョン管理 UI** (P4-04)
  - Settings に「バージョン確認」ボタン追加、最新版と比較して `go install` コマンドを案内
  - 新版が見つかった場合に「Self Update」ボタン（ConfirmDialog 経由）

- **削除済みリポジトリの一括登録解除 UI** (P4-12) (#119)
  - Settings に「N件の無効なリポジトリ」バナー + チェックボックス一覧ダイアログ

- **アクセシビリティ改善** (P4-10)
  - `ConfirmDialog`: フォーカストラップ / Escape キー / ARIA 属性
  - `Sidebar`: `aria-pressed` / `aria-current="page"` / `aria-label` 付与

- **CI check-runs を head_sha ベースに統一** (P4-11)
  - fork PR / force-push 後の CI ドット表示ずれを解消

### feat — Phase 3: AI Insight Engine (Ollama)

- **Ollama バックエンド統合** (P3-01〜06)
  - `ollama_available` / `get_ai_insights` コマンド追加
  - バックグラウンド非同期 + stale-while-revalidate キャッシュ
  - Ollama オフライン時はルールベース Insight へ自動フォールバック

- **AI Insight UI** (P3-07/08)
  - Overview の「RECOMMENDED ACTIONS」パネル
  - Cleanup Wizard に AI 理由テキスト（`✦ {aiReason}`）表示

- **AI 設定 UI** (P3-09)
  - provider / model / Ollama URL / timeout_secs を Settings から編集
  - 「Test Connection」ボタンで疎通確認

### feat — Phase 2: GitHub 連携 + コミットグラフ

- GitHub PAT を OS キーチェーン（keyring）に保存 (P2-01)
- `get_pull_requests` / `get_issues` / `get_check_runs` Rust コマンド (P2-02/03/04)
- PR / Issue 一覧 + CI ステータスドット表示 (P2-05)
- TanStack Query 導入 — GitHub API キャッシュ + 5分間隔自動リフレッシュ (P2-06)
- SVG コミットグラフ（d3 lane 計算）(P2-07/08)
- `env_inject` / `sys_update` dsx コマンドラッパー (P2-09/10)

### feat — Phase 1: コア

- Tauri v2 + React 19 + TypeScript + Vite 6 プロジェクト初期化
- git2 による `list_repositories` / `get_repo_status` / `get_branches` / `delete_branches` / `fetch_all`
- dsx ラッパー: `repo_update`（ストリーミング）/ `repo_cleanup_preview` / `repo_cleanup`
- Overview / Branches / Cleanup / Settings / PullRequests / Graph / Stash ビュー
- ルールベース Insight Engine: diverged / stale / behind / merged ブランチを検出
- React ErrorBoundary + Toast + ConfirmDialog

### chore

- Renovate による依存自動更新を設定
- カスタムアプリアイコン（全サイズ）
- `.gitattributes` で改行コード LF 統一
- lefthook pre-commit / pre-push フック設定

### ci

- `.github/workflows/ci.yml` — Rust (clippy / test + llvm-cov) + Frontend (typecheck / build / vitest)
- `.github/workflows/release.yml` — クロスプラットフォームビルド + 署名 + updater manifest
- Codecov フラグ別カバレッジ管理
