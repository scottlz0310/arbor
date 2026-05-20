# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/). Unreleased changes are in `[Unreleased]`.

## [Unreleased]

### feat (追加予定)

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
