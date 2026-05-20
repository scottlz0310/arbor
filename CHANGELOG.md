# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/). Unreleased changes are in `[Unreleased]`.

## [Unreleased]

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
