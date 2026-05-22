# Arbor

複数のローカル git リポジトリを一元管理する Tauri v2 製デスクトップアプリ。

![Arbor App Icon](app-icon.png)

## 機能

- **Overview** — 全リポジトリの状態（ahead/behind/modified/stash）をカード形式で俯瞰
- **Branches** — ブランチ一覧・フィルタ・マージ済みブランチの一括削除
- **Cleanup Wizard** — `dsx repo cleanup` を GUI から実行。AI による理由テキスト付き
- **Pull Requests** — GitHub REST API で PR / Issue / CI ステータスを表示
- **Commit Graph** — d3 製 SVG コミットグラフ
- **AI Insight** — Ollama (qwen3:latest) でリポジトリの優先度・リスクを分析
- **Settings** — リポジトリ登録・GitHub PAT・AI エンジン設定

## 前提ツール

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Rust / rustup | 1.78+ | バックエンドビルド |
| Node.js | 24 LTS | フロントエンドビルド |
| pnpm | 10+ | パッケージ管理 |
| cmake | 最新安定版 | git2 クレートのビルドに必要 |
| [dsx CLI](https://github.com/scottlz0310/dsx) | 0.2.5+ | git 一括操作 |
| Ollama | 最新安定版 | AI Insight（任意） |

> **Windows**: MSVC Build Tools または Visual Studio が必要  
> **macOS**: Xcode Command Line Tools が必要

## セットアップ

```bash
# 依存インストール（git フックも同時にセットアップされる）
pnpm install

# 開発サーバー起動（Vite + Tauri ホットリロード）
pnpm tauri dev
```

## ビルド

```bash
# リリースビルド（.msi / .dmg を生成）
pnpm tauri build
```

## 開発コマンド

```bash
# フロントエンド
pnpm typecheck          # 型チェック
pnpm test               # vitest（ワンショット）
pnpm test:watch         # vitest ウォッチモード
pnpm test:coverage      # カバレッジ付きテスト

# Rust バックエンド（src-tauri/ 配下）
cargo check  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
```

## アーキテクチャ

```
Frontend (React 19 + Zustand)
        ↕  Tauri IPC (invoke / events)
Rust backend (Tauri commands)
    ├── git2         — 読み取り専用 git 操作
    ├── dsx CLI      — git 一括操作（fetch-all / cleanup 等）
    ├── reqwest      — GitHub REST API v3
    └── reqwest      — Ollama API（AI Insight）
```

設定ファイルの保存先:

| OS | パス |
|----|------|
| Windows | `%APPDATA%\arbor\config.toml` |
| macOS | `~/Library/Application Support/arbor/config.toml` |

## AI Insight のセットアップ（任意）

```bash
# Ollama のインストール後
ollama pull qwen3:latest

# Arbor を起動し Settings › AI Engine で接続確認
```

Ollama が未起動の場合はルールベース Insight にフォールバックします。

## ライセンス

[MIT](LICENSE) © 2026 scottlz0310
