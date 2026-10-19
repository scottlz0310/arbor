# Arbor

複数のローカル git リポジトリを一元管理する Tauri v2 製デスクトップアプリ。

![Arbor App Icon](app-icon.png)

## 機能

- **Header** — dsx の版・Bitwarden の状態・workspace root を表示し、Scan / Fetch All / dsx sys update / Daily Refresh（`dsx run --root`）を実行
- **Repository Status** — 全リポジトリの状態（ahead / behind / dirty / detached / no upstream）をカードで俯瞰し、要対応のリポジトリを先頭に提示。リポジトリごとの Fetch とフォルダを開く操作
- **Summary** — リポジトリ数・要対応の数・Cleanup 候補・dsx 環境の状態を一覧し、クリックで該当のビューへ移動
- **Cleanup Wizard** — 全登録リポジトリの local branch 削除と remote-tracking ref prune を、実行直前の再検証付きで一括管理
- **dsx Tools** — dsx CLI の版の確認と self-update、`dsx sys update`（確認つき）・`-n`（ドライラン）・`repo update`・`doctor` の実行。出力は実行ログコンソールに流れる
- **Settings** — workspace root と手動登録リポジトリの管理

## 前提ツール

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Rust / rustup | 1.78+ | バックエンドビルド |
| Bun | `.bun-version` に準拠 | パッケージ管理・フロントエンドツールチェーン実行 |
| cmake | 最新安定版 | git2 クレートのビルドに必要 |
| [dsx CLI](https://github.com/scottlz0310/dsx) | 0.2.5+ | git 一括操作 |

> **Windows**: MSVC Build Tools または Visual Studio が必要
>
> Bun の isolated linker はシンボリックリンクを使用します。`bun install` が権限エラーになる場合は、Windows の [開発者モード](https://learn.microsoft.com/windows/apps/get-started/enable-your-device-for-development)を有効にしてください。
>
> **macOS**: Xcode Command Line Tools が必要

## セットアップ

```bash
# 依存インストール（git フックも同時にセットアップされる）
bun install

# 開発サーバー起動（Vite + Tauri ホットリロード）
bun run tauri dev
```

## ビルド

```bash
# リリースビルド（.msi / .dmg を生成）
bun run tauri build
```

## 開発コマンド

```bash
# フロントエンド
bun run typecheck          # 型チェック
bun run test               # bun test（ワンショット）
bun run test:watch         # bun test ウォッチモード
bun run test:coverage      # カバレッジ付きテスト

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
    ├── git2         — 状態取得・可視化・Cleanup の単一リポジトリ操作
    ├── dsx CLI      — repo update など複数リポジトリの一括操作
    └── reqwest      — dsx の最新バージョン確認（GitHub Releases）
```

設定ファイルの保存先:

| OS | パス |
|----|------|
| Windows | `%APPDATA%\arbor\config.toml` |
| macOS | `~/Library/Application Support/arbor/config.toml` |

## ライセンス

[MIT](LICENSE) © 2026 scottlz0310
