# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### chore

- パッケージマネージャーを pnpm から Bun へ移行し、lockfile、CI、release workflow、Tauri hook、開発ドキュメントを統一 (#195)

## [0.2.0] — 2026-07-15

### refactor

- 旧 Cleanup 画面専用の dsx cleanup command と登録を削除 (#190)

### feat

- **Cleanup Wizard 強化 (PR-C): repo 横断 UI と型付き実行結果表示** (#186)
  - Rust の `cleanup_preview` / `cleanup_execute` を利用する typed frontend API を追加
  - 全登録 repo の local branch / remote-tracking ref をカテゴリ・repo 単位で表示
  - merged のみ初期選択し、stale / upstream 消失 / remote-tracking は明示選択に限定
  - safety block、repo / remote エラー、構造化確認、項目単位の実行結果を表示
  - 実行後の再 preview と、複数 repo / remote・部分失敗を含む UI テストを追加

- **Cleanup Wizard 強化 (PR-B): 型付き execute と実行直前の再検証** (#186)
  - `cleanup_execute` Tauri コマンドと項目単位の `success` / `skipped` / `failed` 結果を追加
  - preview 時点の OID・upstream・remote・候補種別・merge 状態を repo 単位で再検証
  - current / default / protected / worktree の安全条件に該当する項目は実行時にも拒否
  - remote-tracking ref は削除直前に remote を再照会し、remote branch が復活した場合は skip
  - local branch 削除と remote-tracking ref prune の部分成功・部分失敗を分離して返却

- **Cleanup Wizard 強化 (PR-A): repo 横断 preview コマンド** (#186)
  - `cleanup_preview` Tauri コマンド追加。登録済み全 repo を横断して削除候補を列挙する
  - `CleanupCandidate` / `CleanupOperation` / `CleanupPreview` 等の共有モデル追加
    （local branch 削除と remote-tracking ref prune を別 operation として分離）
  - 候補判定: マージ済み / stale / upstream 消失 local branch、remote 上に存在しない
    stale remote-tracking ref（ls-remote 相当で最新状態を確認し、preview はローカル ref を変更しない）
  - 安全条件（checkout 中・default branch・protected・worktree 使用中）を `blocked` として付与
  - remote 接続失敗は repo 単位の `remote_errors` として報告し、該当 remote の prune 候補は提示しない
  - `RepoConfig.protected_branches` 設定を追加（Cleanup の削除対象から除外する branch/ref 名）

### test

- debug build の実機テスト用に `ARBOR_CONFIG_DIR` で隔離設定ディレクトリを指定可能にした

### ci

- Rust source 全体を rustfmt で統一し、CI の Rust lint job に format check を追加

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
