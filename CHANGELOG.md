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
