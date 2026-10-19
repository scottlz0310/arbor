# Arbor

複数のローカル git リポジトリを一元管理する Tauri v2 製デスクトップアプリ。

![Arbor App Icon](app-icon.png)

## 機能

- **Header** — dsx の版・Bitwarden の状態・workspace root を表示し、Scan / Fetch All / dsx sys update / Daily Refresh（`dsx run --root`）を実行
- **Repository Status** — 全リポジトリの状態（ahead / behind / dirty / detached / no upstream）をカードで俯瞰し、要対応のリポジトリを先頭に提示。リポジトリごとの Fetch とフォルダを開く操作。「Remote を確認」で、各リポジトリの origin を GitHub に問い合わせ、アーカイブ済み・移転・見つからないクローンをバッジで示す（`gh` を使う。削除は、Arbor では行わない）
- **Summary** — リポジトリ数・要対応の数・Cleanup 候補・dsx 環境の状態を一覧し、クリックで該当のビューへ移動
- **Cleanup Wizard** — 全登録リポジトリの local branch 削除と remote-tracking ref prune を、実行直前の再検証付きで一括管理
- **dsx Tools** — dsx CLI の版の確認と self-update、`dsx sys update`（確認つき）・`-n`（ドライラン）・`repo update`・`doctor` の実行。出力は実行ログコンソールに流れる
- **Settings** — workspace root と手動登録リポジトリの管理

## インストール

### Windows（MSIX。v0.4.0 以降）

PowerShell で、次を実行する（自己署名の証明書 `arbor.cer` を信頼登録して、MSIX 版をインストールする。証明書のインポートのときだけ、UAC が出る）。

```powershell
iex ([Text.Encoding]::UTF8.GetString((iwr -UseBasicParsing https://github.com/scottlz0310/arbor/releases/latest/download/install.ps1).Content).TrimStart([char]0xFEFF))
```

- 更新は、Windows が、バックグラウンドで自動で行う（約 8 時間ごと）。Arbor のアプリ内の更新機能は、Windows 版には無い。
- 対応は、Windows 10（19041 以降）/ 11 の x64 のみ。WebView2 ランタイムが要る（Windows 11 は標準で入っている）。
- **v0.3.0 までの msi / setup.exe 版**: 先に、「設定 > アプリ」からアンインストールする。設定（`config.toml`）は、`~/.config/arbor/config.toml` に、初回の起動で引き継がれる（旧版の `%APPDATA%\arbor\config.toml` は、コピーするだけで、消さない）。旧版が作った `%LOCALAPPDATA%\dev.scottlz0310.arbor`（WebView2 のデータ）は、MSIX 版では使わず、MSIX 版のアンインストールでも消えない。不要なら、手で削除する。
- **起動**: スタートメニュー、または、シェルから `arbor`。Daily Refresh で Bitwarden のシークレットを使うときは、**解錠したシェルから `arbor` で起動する**（スタートメニューからの起動は、シェルの `BW_SESSION` を引き継がない）。
- **アンインストール**: 「設定 > アプリ」。設定（`~/.config/arbor`）は残る。信頼登録した証明書は、残る（不要なら、`Cert:\LocalMachine\TrustedPeople` から削除する）。

### macOS / Linux

[Releases](https://github.com/scottlz0310/arbor/releases) の、dmg（macOS）、AppImage・deb（Linux）。アプリ内の自動更新は、まだ無い（[#327](https://github.com/scottlz0310/arbor/issues/327)）。macOS は、署名・公証をしていない。

## 前提ツール

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Rust / rustup | 1.78+ | バックエンドビルド |
| Bun | `.bun-version` に準拠 | パッケージ管理・フロントエンドツールチェーン実行 |
| cmake | 最新安定版 | git2 クレートのビルドに必要 |
| [dsx CLI](https://github.com/scottlz0310/dsx) | 0.11.0+ | Daily Refresh（`dsx run --root`）に必要 |

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
# リリースビルド（macOS: .app / .dmg、Linux: AppImage / deb。Windows は実行ファイルだけで、インストーラは作らない）
bun run tauri build
```

Windows の配布物（MSIX）は、`tauri build` では作らない。`bun run tauri build --no-bundle` で `arbor.exe` を作り、`packaging/msix/Build-Msix.ps1` で MSIX にする（署名と手順は、CLAUDE.md の「リリース」）。

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

## 使うときの注意

- **Bitwarden**: Arbor からは、Bitwarden を解錠できない（パスワードを入力する画面が無い）。Daily Refresh で Bitwarden の環境変数も使うときは、ターミナルで解錠して `BW_SESSION` を設定し、そのターミナルから Arbor を起動する。未解錠のまま Daily Refresh を押すと、確認ダイアログが出る（そのまま実行すると、解錠が必要な処理は失敗するか、省略される）。
- **fetch の認証**: Fetch / Fetch All は、git の認証情報ヘルパー（HTTPS。Windows は Git Credential Manager）と ssh-agent を使う。認証情報を入力する画面は無いので、先に `git fetch` で認証を通しておく。
- **Remote の確認**: 「Remote を確認」は、[GitHub CLI（`gh`）](https://cli.github.com/)を使う。`gh auth login` で、ログインしておく（非公開リポジトリも、`gh` の認証で読む）。GitHub に問い合わせるため、自動では行わない。GitHub 以外の origin は、対象外。権限の無い非公開リポジトリは、GitHub が 404 で答えるため、「remote なし」と区別できない。
- **管理対象**: `workspace.root` 直下の git リポジトリが、自動で一覧に入る。手動登録のうち、ディスク上に無いものは一覧・Fetch の対象から外れる（Settings の「無効なリポジトリを検出」から、登録を外せる）。

## アーキテクチャ

```
Frontend (React 19 + Zustand)
        ↕  Tauri IPC (invoke / events)
Rust backend (Tauri commands)
    ├── git2         — 状態取得・可視化・Cleanup の単一リポジトリ操作
    ├── dsx CLI      — repo update など複数リポジトリの一括操作
    └── reqwest      — dsx の最新バージョン確認（GitHub Releases）
```

設定ファイルの保存先は、全 OS で `~/.config/arbor/config.toml`（Windows は `%USERPROFILE%\.config\arbor\config.toml`）。
旧版の保存先（Windows の `%APPDATA%\arbor\config.toml`、macOS の `~/Library/Application Support/arbor/config.toml`）に設定があり、新しい場所に無いときは、初回の起動でコピーする（旧ファイルは消さない）。

## ライセンス

[MIT](LICENSE) © 2026 scottlz0310
