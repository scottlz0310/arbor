# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/). Unreleased changes are in `[Unreleased]`.

## [Unreleased]

### fix (修正予定)

- **AI Insight — バックグラウンド非同期化 & タイムアウト修正**
  - `get_ai_insights_cached`: cache miss 時の同期フェッチを廃止し、常にバックグラウンド spawn に変更
    - 起動直後に UI をブロックしない。Ollama の応答速度に依存しない設計
    - バックグラウンド開始時に `ai_insights_loading` イベントを emit して "Analyzing..." を表示
    - 失敗時（タイムアウト含む）に `ai_insights_updated []` を emit して "Analyzing..." を解除
  - `fetch_from_ollama`: クリーンな repo（全 stat が 0）をフィルタリングしてプロンプトを削減（最大 10 件）
    - フィルタ後が空の場合は即 `Ok([])` を返す（Ollama 不要）
  - `AiConfig::default()`: `timeout_secs` を 30 → 120 に変更
  - `Overview`: `aiBgRunning` state を追加し `insightLoading` との競合を解消
    - `ai_insights_loading` → `aiBgRunning = true`
    - `ai_insights_updated` → `aiBgRunning = false`
  - Ollama 未起動時に `⚠ Ollama offline` バッジとメッセージを表示 (P3-05 UX 改善)
    - `InsightResult` に `ollamaOffline: boolean` を追加
    - Ollama 到達不能時は `ruleResult(true)` でフラグを立てる
    - Overview: `ollamaOffline` state を追加しパネル常時表示 + バッジ・メッセージ表示

### feat (追加予定)

- **Phase 3 — AI 設定 UI** ([#101](https://github.com/scottlz0310/arbor/issues/101))
  - Settings 画面の AI Engine セクションを編集可能フォームに刷新 (P3-09)
    - provider / model / Ollama URL / timeout_secs を個別に編集・保存可能
    - AI Insight の enabled トグル
    - 「Test Connection」ボタンで Ollama 疎通確認 (✓/✗ インライン表示)
    - dirty state 管理: 変更がある場合のみ「Save」が有効になる
  - Rust: `update_ai_config` コマンドを `config_cmd.rs` に追加
    - 全フィールドを optional に受け取り、変更分のみ `config.toml` に書き込む
    - バリデーション: URL/model/provider 空文字 Err、timeout_secs 範囲 (1–300) Err
    - 保存後に `AiCacheState::clear()` でキャッシュを即時無効化
  - `AiCacheState::clear()` メソッドを `ai.rs` に追加

- **Phase 3 — AI Insight UI 統合** ([#100](https://github.com/scottlz0310/arbor/issues/100))
  - Overview に「RECOMMENDED ACTIONS」パネルを追加 (P3-07)
    - `fetchInsights()` でルールベース / AI Insight を取得し、最大 5 件の `InsightCard` を表示
    - `insightSource` バッジで AI / Rules を区別表示
    - `listen('ai_insights_updated', ...)` でバックグラウンド更新をリアルタイム反映
  - Cleanup Wizard に AI 理由テキストを表示 (P3-08)
    - マージ済み / ステールブランチ行の下に `✦ {aiReason}` を表示
    - `findInsightReason(branchName)` で Insight を branch 名で引き当て

- **Phase 3 — AI Insight キャッシュ & フォールバック耐障害性** ([#99](https://github.com/scottlz0310/arbor/issues/99))
  - `AiCacheState` (Tauri State) による `hash(repoState)` ベースのキャッシュ
  - `get_ai_insights_cached` コマンド: stale-while-revalidate — キャッシュヒット時は即返却 + バックグラウンド再計算 → `emit("ai_insights_updated", ...)`
  - `src/lib/aiService.ts` 新規作成: `fetchInsights()` でOllama不可・エラー時に `generateInsights()` へフォールバック
  - `convertAiInsights()`: `AiInsight[]` → `Insight[]` の変換（priority 0-3 → low/medium/high）
  - `getAiInsightsCached` を `lib/invoke.ts` に追加
  - テスト追加: Rust 3件（hash一貫性・差分・キャッシュ読み書き）、Frontend 10件（変換・フォールバック全パス）

### feat

- **Phase 3 — Ollama バックエンド基盤** (`src-tauri/src/commands/ai.rs`)
  - `ollama_available` — Ollama の起動確認 (GET /api/tags)
  - `get_ai_insights` — リポジトリ状態から AI Insight を生成 (POST /api/generate)
  - State Aggregator — `RepoInfo[]` から Ollama プロンプト用の構造化 JSON を生成
  - `/no_think` + JSON-only プロンプトでモデル出力を安定化
  - コードフェンスの自動除去パーサー
  - `AiInsight` 型を `models.rs` / `types/index.ts` に追加
  - `ollamaAvailable` / `getAiInsights` を `lib/invoke.ts` に追加
  - 関連: [#98](https://github.com/scottlz0310/arbor/issues/98)
- **レビュー対応** (PR #110 フィードバック)
  - `InsightKind` enum を `models.rs` に追加し、`AiInsight.kind` の型を `String` → `InsightKind` に変更。Serde が未知の kind 文字列を即 Err にするため LLM 出力の境界を型で閉じた
  - `parse_insights` に `priority > 3` のガード追加
  - `ollama_available` の `load_config()` 失敗を `Ok(false)` に変更（エラー伝播しない可用性プローブに統一）
  - `ollama_url()` ヘルパーで末尾スラッシュを正規化（`//api/generate` 防止）
  - テスト追加: `parse_insights_invalid_kind_returns_err` / `parse_insights_priority_out_of_range_returns_err` / `ollama_url_trims_trailing_slash`
