# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

**Arbor** は Tauri v2 製のデスクトップアプリ。複数のローカル git リポジトリを一元管理する。
既存の Go CLI ツール **dsx** をアクション実行層として内包し、git2 クレートで可視化する。

> 方向性は dsx の実行・表示基盤 兼 開発環境リフレッシュナーへ移行中（Issue #294）。GitHub 連携・AI Insight・Graph・Stash・Branches は削除済み。

- 仕様書: `docs/arbor-spec-design-b_2.html`（インタラクティブモックアップ込み）
- タスク一覧: `tasks.md`（フェーズ別タスク + spec レビューノート）

## 開発コマンド

### 前提ツール
```bash
# git2 ビルドに cmake が必要 (Windows: MSVC Build Tools or Visual Studio)
rustup update           # Rust 1.78+
bun --version           # .bun-version に準拠（Node.js は不要）
dsx --version           # dsx CLI が PATH に必要（Daily Refresh は v0.12.0+）
```

### 起動・ビルド
```bash
bun install             # フロントエンド依存インストール
bun run tauri dev       # 開発サーバー起動 (Vite + Tauri ホットリロード)
bun run tauri build     # リリースビルド (macOS: .app / .dmg、Linux: AppImage / deb。Windows は exe だけ。MSIX は packaging/msix/)
```

実機で動作を確かめるときは、設定ファイルの置き場所を差し替えて、利用者の `config.toml` を触らないようにする（debug build のみ有効）。

```bash
# <dir>/arbor/config.toml を使う。config.toml は、あらかじめコピーしておく
ARBOR_CONFIG_DIR=<dir> bun run tauri dev
```

Daily Refresh や sys update などは、実際にシステムとリポジトリを更新するので、実行前に確認する。

### Rust チェック
```bash
# Cargo.toml は src-tauri/ 配下のため --manifest-path を指定する
cargo check  --manifest-path src-tauri/Cargo.toml   # コンパイルチェック（ビルドなし、高速）
cargo clippy --manifest-path src-tauri/Cargo.toml   # Lint
cargo test   --manifest-path src-tauri/Cargo.toml   # テスト実行
```

### フロントエンドのみ
```bash
bun run dev             # Vite dev server のみ (Tauri なし)
bun run build           # TypeScript コンパイル + Vite ビルド
bun run typecheck       # 型チェックのみ（emit なし）
bun run test            # bun test（ワンショット）
bun run test:watch      # bun test ウォッチモード
bun run test:coverage   # カバレッジ付き（coverage/lcov.info を生成）
```

単一テストファイルを実行する場合:
```bash
bun test src/lib/ruleEngine.test.ts
```

テスト基盤は bun test + happy-dom。Tauri IPC（`@tauri-apps/api/core` / `event` / `plugin-dialog`）の
モックと zustand ストアのテスト間リセットは preload（`src/test/setup.ts`）に集約されている。
テストファイル内では `mock.module` を使わず、`spyOn` でモジュール関数を差し替え、
module レベルの spy を作ったファイルには `afterAll(() => mock.restore())` を入れること
（bun test は全ファイルを 1 プロセスで実行するため、spy がファイル間に漏れる）。

### PowerShell スクリプト（MSIX）のテスト

`packaging/msix/` と `scripts/*.ps1`（MSIX の生成・署名・インストール）は、Pester 5+ でテストする（`tests/*.Tests.ps1`。CI の `PowerShell Tests`）。`Test-ReleaseMsix.ps1` のテストは Windows SDK（makeappx / signtool）を使う。

```powershell
Invoke-Pester -Path tests -CI
```

### Git フック（lefthook）

`lefthook.yml` で定義。`bun install` 実行時に自動インストールされる。

- **pre-commit（並列）**: `bun run typecheck`、`cargo check`
- **pre-push（直列）**: `cargo clippy -- -D warnings`、`cargo test`、`bun run test`

### リリース（release-automate）

1. Actions の `Prepare Release` を、版（`MAJOR.MINOR.PATCH`）を指定して手動で実行する。リリース準備 PR（`chore(release): vX.Y.Z`。版の更新と、CHANGELOG の `[Unreleased]` の確定）が、Bot 名義で作られる。
2. レビューして、squash マージする。`Release`（`.github/workflows/release.yml`）が、自動で動く: draft の Release とタグ → macOS / Linux のビルドと添付（`build-tauri`）、Windows の MSIX の作成（`msix-build` = `build-exe.yml`。Secrets なし）→ 署名（`msix-sign`。Environment `msix-signing`。複合アクション `.github/actions/package-msix-signed`）→ 添付（`attach-msix`）→ updater の `latest.json`（macOS と Linux の 2 つ）→ `verify`（`verify-release.yml`。成果物の組・`latest.json`・MSIX の checksum と `.appinstaller` の整合（ubuntu）と、MSIX の署名・Identity・Publisher（windows））→ `finalize`（公開）。`verify` が失敗すると、公開されず、draft のまま残る。Windows の配布物は、`arbor_x64.msix`・`arbor.appinstaller`・`arbor.cer`・`install.ps1`・`checksums-msix.txt`（msi / setup.exe は、公開しない。`verify` が、混入していれば失敗する）。
3. 公開の前に draft を確認したいとき、または検証の実装そのものを試したいときは、Actions の `Verify Release` を、タグを指定して実行する（読み取りのみ）。手元では、`GH_REPO=scottlz0310/arbor scripts/verify-release-assets.sh vX.Y.Z`（成果物の組・`latest.json`・MSIX の整合）。MSIX の署名の検証は、draft から `arbor_x64.msix` と `arbor.cer` を取得して、`pwsh scripts/Test-ReleaseMsix.ps1 -Dir <取得先> -Version X.Y.Z`。
4. 公開のあと、Windows では、`install.ps1`（README の「インストール」）で、実機に入れて確認する。2 回目以降のリリースでは、既存の MSIX が、`.appinstaller` で自動更新されることも確認する（約 8 時間ごと。すぐ確かめるときは、最新の Release の `arbor.appinstaller` を開く）。
5. 検証用の MSIX（リリースではない）は、Actions の `Package MSIX` を、`workflow_dispatch` で、タグ（実在しなくてよい）を指定して実行する（main から。署名の Environment が main に限定されているため）。

**失敗したとき**
- **一時的な失敗（ネットワーク・ランナー）**: 同じ実行で「Re-run failed jobs」を使う（新しいタグは切らない）。
- **ワークフローの定義の不具合**: 再実行は、その実行の時点の定義で動くため、直らない。main で直しても、`finalize`（release-automate）は「実行の SHA = リリースのコミット」を要求するため、新しい定義では公開できない。この場合に限る例外の手順: `Verify Release` か `scripts/verify-release-assets.sh` で draft を検証 → `gh release edit vX.Y.Z --draft=false --latest` で公開 → 公開した理由と検証の結果を、PR・CHANGELOG・ハンドオフに記録 → 直した定義が、次のリリースで動くことを確認する。
- **draft の取り残し**: リリースのあとに、`gh release list` で、draft が残っていないことを確認する（v0.2.1 は、成果物が揃ったまま、3 か月、未公開の draft として残った）。

**権限**: draft の Release は、書き込み権限のあるトークンにしか見えない。draft を読むジョブは、読み取りだけでも `contents: write` が要る（`contents: read` では `release not found` になる。v0.3.0 の公開で、実際に `verify` が、これで失敗した）。reusable workflow を呼ぶ job にも、同じ `permissions` が要る。

### Windows の MSIX と署名証明書（#324）

Windows の配布は、自己署名の MSIX + `.appinstaller` + `install.ps1`（dsx と同じ型）。生成は `packaging/msix/`、CI は、`build-exe.yml`（`arbor.exe` のビルド。再利用ワークフロー。Secrets なし）と、複合アクション `.github/actions/package-msix-signed`（署名・検証・checksum）を部品とし、`package-msix.yml`（手動実行・PR。検証用）と `release.yml`（リリース）が、同じ部品で組む。検証したものが、そのまま配布物になる。msi / NSIS は、配布しない。

- **署名証明書**: Subject `CN=scottlz0310`（`AppxManifest.xml` の Publisher と一致させる）、5 年（2031-10-19 まで）。pfx は、GitHub の **Environment `msix-signing`** のシークレット `SIGNING_CERTIFICATE_BASE64` / `SIGNING_CERTIFICATE_PASSWORD`（**リポジトリの Secrets ではない**。同一リポジトリの PR は、ワークフロー自体を書き換えて、リポジトリの Secrets を読める。Environment は、デプロイできるブランチを `main` だけに限定していて、PR のワークフローからは読めない）。バックアップは、pfx と cer を `-BackupDir` で指定した場所に、パスワードを Bitwarden の secure note「arbor MSIX signing certificate」に置く（pfx とパスワードを同じ場所に置かない）。バックアップ先の具体的な場所と手順は、ハンドオフ（`arbor-dsx/handoff/arbor.md` のトピック 2）。
- **ワークフローの規則**: 署名用の Secrets を参照するのは、`package-msix.yml` の `package-signed` と、`release.yml` の `msix-sign`（どちらも `environment: msix-signing`。**直接のジョブ**。`package-signed` は PR では動かさない）だけ。PR で動くジョブ（`build`、`package-unsigned`）には、`${{ secrets.* }}` を展開しない。`pull_request_target` は使わない。**署名のジョブを、再利用ワークフロー（`workflow_call`）の中に置かない**（再利用ワークフローの中では、Environment に紐づいても、Environment のシークレットが `secrets` に渡らず、空になる。v0.4.0 のリリースで、実際に失敗した。直接実行の `workflow_dispatch` では取れるため、手動実行では気づけない）。複合アクションは `secrets` を参照できないので、署名のジョブが `with:` で渡す。`tests/PackageMsixWorkflow.Tests.ps1`・`ReleaseWorkflow.Tests.ps1`・`WorkflowSecrets.Tests.ps1` が検査する。署名用の Secrets を使うジョブを足すときは、同じ規則に従う。
- **生成**: Bitwarden を解錠したシェル（`BW_SESSION`）から、`pwsh packaging/msix/New-SigningCertificate.ps1 -BackupDir <バックアップ先> -Register`。pfx の書き出し、Bitwarden への保存、Environment のシークレットの登録（Environment が無ければ作り、デプロイを `main` に限定）の順に進み、前の工程が失敗したら止まる。パスワードは、画面にもログにも出さない。`-BackupDir` に既定値は無い。
- **復元**（シークレットを失った、リポジトリを移した、Environment に移すとき）: 証明書は作り直さず、バックアップから登録し直す。`pwsh packaging/msix/Register-SigningSecrets.ps1 -BackupDir <バックアップ先>`（Bitwarden を解錠したシェルから）。pfx が、Bitwarden のパスワードで開けることを確かめてから、登録する。
- **ローテーション**（期限の前、または鍵が漏れたとき）: 同じ Subject で新しい証明書を生成して、Environment のシークレットを更新（既存の物がある場合は `-Force`。Bitwarden の同名の項目は、先に削除するか、`-BitwardenItemName` を変える）→ 次のリリース → 各 PC で `install.ps1` を再実行（新しい `.cer` を信頼登録するため UAC が出る）。Subject を変えると Package Identity の Publisher が変わり、更新できない。
- **署名のパスの確認**: Environment が main に限定されているため、作業ブランチでは動かない。ワークフローを main に入れてから、Actions の `Package MSIX` を `workflow_dispatch` で実行して、成果物 `arbor-msix` を確認する。
- **手元で確認する**: `bun run tauri build --no-bundle` で `arbor.exe` を作り、`pwsh packaging/msix/Build-Msix.ps1 -BinaryPath src-tauri/target/release/arbor.exe -Tag v0.0.0 -OutDir <出力先>` で MSIX を組む（未署名）。署名した MSIX の確認は、Actions の `Package MSIX` を実行して、成果物 `arbor-msix` を取得する。手元で署名まで試すときは、Bitwarden の項目からパスワードを取り出して `-PfxPath` / `-PfxPassword` に渡す（パスワードを画面やログに出さない）。
- **Bitwarden（`BW_SESSION`）**: dsx v0.12.0 から、Daily Refresh（`dsx run`）は Bitwarden に触れない。スタートメニューからの起動（シェルの環境変数を引き継がない）でも動くので、Arbor は Bitwarden の状態を表示も操作もしない。シークレットが要る用途は `dsx env`。実行エイリアス `arbor` は `AppxManifest.xml` で宣言する（`WindowsApps` に置かれる。シェルから起動するとき用）。
- **書き込み仮想化**: MSIX は既定（有効）のままにしている（`AppxManifest.xml` のコメントに、理由と実機の結果）。新しく作られるファイルは、アンインストールで消える。**すでに実在するディレクトリ**（旧版が作った `%LOCALAPPDATA%\dev.scottlz0310.arbor` など）への書き込みは、仮想化されず、実フォルダに入る。パッケージ内の挙動を調べるときは、`Invoke-CommandInDesktopPackage -PackageFamilyName <PFN> -AppId Arbor -Command powershell.exe -Args "..."` が使える。

## アーキテクチャ

### レイヤー構造

```
Frontend (React 19 + Zustand)
        ↕  Tauri IPC (invoke / events)
Rust backend (Tauri commands)
    ├── git2 クレート     — 読み取り専用 git 操作
    ├── std::process::Command → dsx CLI  — 書き込み操作を委譲
    └── reqwest → GitHub Releases（dsx の最新バージョン確認のみ）
```

**重要な設計原則:**
- git の**一括操作**（fetch-all / pull / cleanup）は **dsx に委譲**し、Arbor 側で再実装しない
- git2 は主に**読み取り**（ステータス・Cleanup 候補の列挙）に使用する。
  ただし `fetch_all`（単一）・`fetch_repositories`（一括）と Cleanup の実行（`cleanup_execute`）は git2 で直接実装（dsx への往復コストを避けるため、個別選択に構造化データが必要なため）
- 破壊的操作は**必ず ConfirmDialog を経由**させる

### Rust バックエンド (`src-tauri/src/`)

ロジックは `commands/` などに置き、Tauri のコマンド（フロントエンドからの入口）は `ipc/` に置く。`commands/` の関数は、`ipc/` の同名のコマンドから呼ばれる（コマンド名は、フロントエンドの `invoke` と同じ）。

| ファイル | 責務 |
|---------|------|
| `lib.rs` | Tauri Builder + 全コマンドの `invoke_handler` 登録 |
| `ipc/` | `#[tauri::command]` の薄いラッパーだけ（`cleanup` / `config` / `dsx` / `fetch` / `remote_status` / `repo` / `runner`）。ロジックは持たず、`commands/` の関数を呼ぶ。カバレッジの対象外で、`ipc/guard.rs` が薄さと `lib.rs` への登録を検査する |
| `models.rs` | `RepoInfo` / `BranchInfo` / `CommitNode` / `DsxOutput` 等の共有データ型 |
| `config.rs` | `AppConfig` の読み書き。保存先は全 OS で `~/.config/arbor/config.toml`（旧版の保存先からは初回にコピー）。未設定の `workspace.root` は、あれば `~/src` で補う |
| `workspace.rs` | 管理対象リポジトリの決定。`workspace.root` 直下（深さ 1。dsx の `repo.root` と同じ規則）の自動検出と、手動登録（ディスク上に無いものは除く）の和集合（`effective_repos`）。protected branches は、全体の既定（main / master / develop / dev）に、手動登録の設定を追加して解決する |
| `commands/repo.rs` | git2 によるリポジトリ情報コマンド群（`list_repositories` は実効リポジトリを最大 8 並列でスキャン、`get_repo_status`）、`fetch_all`、`open_repo_folder`（管理対象のリポジトリのフォルダだけを OS のファイルマネージャで開く） |
| `commands/config_cmd.rs` | config.toml CRUD（手動登録の追加・削除、`update_settings`、存在しない手動登録の検出）と `get_workspace_status`（Header の root 表示用） |
| `commands/dsx.rs` | dsx CLI ラッパー。実行は `commands/runner.rs` に委譲する。`dsx_check`（版と `supports_daily_refresh`）、`repo_update` / `daily_refresh`（どちらも Arbor の `workspace.root` を `--root` で渡す。Daily Refresh は dsx v0.12.0 以上が必要） |
| `commands/fetch.rs` | 管理対象リポジトリの一括 fetch（`fetch_repositories`）。git2 で最大 4 並列に fetch し、1 件ごとの結果を runner の job としてコンソールへ流す。`cancel_run` で転送中の fetch も中断できる |
| `commands/remote_status.rs` | リモートの状態の確認（`check_remotes`）。各リポジトリの `origin`（GitHub のもの）について、`gh api repos/{owner}/{repo}` で、アーカイブ済み・移転（transfer / rename）・見つからない（404）を調べる。最大 4 並列で、1 件ごとの結果を runner の job としてコンソールへ流す（fetch と同じ枠）。ネットワークを使うため、自動では走らせず、Status タブの「Remote を確認」で手動で行う。`gh` の呼び出しは `Looker` で差し替えられる |
| `commands/runner.rs` | 外部コマンドの実行基盤（子プロセスを持たない処理は `run_job` で同じ枠に載せる）。stdout / stderr を行単位で `process_*` イベントとして送信し、同時実行は 1 件に制限する。`cancel_run` でプロセスツリーごと強制終了する（Windows は Job Object、Unix はプロセスグループ） |

### IPC ラッパーとカバレッジ

`#[tauri::command]` の関数は `src-tauri/src/ipc/` だけに置く。関数は、状態や設定を取り出し、`commands/` 側のテスト済みの関数を呼んで、結果を返すだけにする（分岐・繰り返し・変換などのロジックは `commands/` 側に置く）。

- `ipc/` は、カバレッジの対象から外している（CI の `cargo llvm-cov --ignore-filename-regex` と `codecov.yml` の `ignore`）。ラッパーは `tauri::State` を要し、Windows では `tauri::test` のテスト実行ファイルが起動しないため、単体テストできない。ロジックを持たないので、除外しても測るべきものは減らない。
- 除外が正当であり続けるように、`ipc/guard.rs` のテストが次を検査する。違反すると `cargo test` が失敗する。
  - `ipc/` に置けるのは、`use` / `mod` と `#[tauri::command]` の関数だけ。
  - コマンドの本文は 4 文以内で、`if` / `match` / `for` / `while` / `loop` / `&&` / `||` / `let ... else` を含まない（含むロジックは `commands/` へ切り出す）。
  - `ipc/` のコマンドと、`lib.rs` の `generate_handler!` の登録が、過不足なく一致する。
  - 除外の設定が `ipc/` を指している。
- 新しいコマンドを足すときは、ロジックを `commands/` に書いてテストし、`ipc/` に呼び出すだけの関数を足して、`lib.rs` に登録する。

### フロントエンド (`src/`)

| パス | 責務 |
|-----|------|
| `types/index.ts` | Rust モデルと 1:1 対応する TypeScript 型定義 |
| `lib/invoke.ts` | `@tauri-apps/api/core` の `invoke` を型安全にラップした関数群 |
| `lib/ruleEngine.ts` | ルールベース Insight 生成。diverged / far behind を検出 |
| `lib/processEvents.ts` | `process_*` イベントの購読。描画フレームごとにまとめて `consoleStore` へ反映する |
| `lib/ansi.ts` | ANSI エスケープの最小パーサ（前景 16 色・太字・薄字。他は除去） |
| `stores/repoStore.ts` | リポジトリ一覧と選択状態（Zustand） |
| `stores/uiStore.ts` | ナビゲーション状態・Toast（Zustand） |
| `stores/consoleStore.ts` | 実行ログ（リングバッファ 10,000 行）と実行状態（Zustand） |
| `stores/envStore.ts` | dsx の版・workspace root の現況（Header の pill 用。Zustand） |
| `lib/dsxActions.ts` | Daily Refresh / sys update / Update All の実行と Toast、Daily Refresh を実行できない理由の判定 |
| `lib/rescanAfterRun.ts` | run の終了を検知して、一覧と環境の状態を自動で読み直す |
| `views/` | ページコンポーネント（Status / Cleanup / Tools / Settings）。Status・Cleanup・Tools が Summary の下のタブで、Settings は Header から開く。Tools は dsx の版の確認・self-update と、sys update / `-n` / repo update / doctor の実行ボタン（出力は解析せず、コンソールに流すだけ） |
| `components/` | 共通 UI（Header, SummaryStrip, TabBar, AppBar, ConfirmDialog, Toast, LogConsole） |
| `lib/dsxVersion.ts` | `v0.11.0` / `dsx version 0.11.0` 形式の版の比較 |
| `lib/repoStatus.ts` | 要対応の判定（`needsAction`）、状態バッジ、Status タブの絞り込みと並び順 |
| `lib/remoteStatus.ts` | リモートの状態のバッジ（archived / remote なし / 移転 / 確認失敗）と件数、確認の実行と Toast |
| `stores/remoteStore.ts` | 直近のリモートの状態の確認結果（Status のバッジと Summary の注記用。確認は遅いため自動では行わず、アプリを閉じると失われる。Zustand） |
| `stores/cleanupStore.ts` | 直近の Cleanup プレビューの候補数（Summary 用。プレビューは remote へ接続して遅いため、自動では読み込まない） |

**データフロー:** Rust コマンド → `lib/invoke.ts` → Zustand store → React コンポーネント
**イベント:** Rust `runner.rs` が `process_started` / `process_output` / `process_finished` を emit → `lib/processEvents.ts`（`App.tsx` が購読）→ `consoleStore` → `LogConsole`（App 下部のドック）（ペイロードは `camelCase`。型は `types/index.ts` の `Process*`）

### 設定ファイル

- **実行時設定**: 全 OS で `~/.config/arbor/config.toml`（dsx の `~/.config/dsx` と同じ。Windows は `%USERPROFILE%\.config\arbor\config.toml`）。MSIX は `%APPDATA%` への書き込みをパッケージ領域へ仮想化し、アンインストールで消すため、ユーザープロファイル直下に置く（#324）。
  - 旧版の保存先（`dirs::config_dir()/arbor/config.toml`。Windows は `%APPDATA%\arbor`、macOS は `~/Library/Application Support/arbor`）にだけ設定があるときは、初回の読み込みで新しい場所へコピーする（旧ファイルは消さない）。
- **リポジトリの範囲**: `workspace.root`（既定 `~/src`。空文字列で自動検出を無効化）の直下を自動検出し、`repositories`（手動登録）を足す。手動登録は root の外のリポジトリの追加と、名前・protected branches の追加に使う。
- **protected branches**: `settings.protected_branches`（既定 main / master / develop / dev）に、手動登録の `protected_branches` を追加して Cleanup に適用する

### 主要 Tauri コマンドマッピング

| Tauri コマンド | バックエンド処理 | 備考 |
|---------------|-----------------|------|
| `sys_update` / `sys_update_dry_run` | `dsx sys update --no-tui` / `... -n` | dry run は計画だけを表示する。dsx が管理するツール群を更新する（dsx 本体は更新しない） |
| `dsx_doctor` | `dsx doctor` | 依存ツールと設定の診断。出力は `process_output` イベントでストリーム |
| `repo_update` | `dsx repo update --root <workspace root> --no-tui --jobs 4` | root 配下の全リポジトリを更新。stdout / stderr を `process_output` イベントでストリーム |
| `daily_refresh` | `dsx run --root <workspace root> --no-tui --jobs 4` | システム更新 → リポジトリ更新（Bitwarden には触れない）。dsx v0.12.0 未満では拒否する |
| `cleanup_preview` | git2 | 管理対象（自動検出 + 手動登録）の全リポジトリの削除候補を読み取り専用で列挙 |
| `cleanup_execute` | git2 | 選択候補を再検証して local branch 削除または remote-tracking ref prune を実行 |
| `fetch_repositories` | git2（`commands/fetch.rs`） | 全管理対象を最大 4 並列で fetch。進捗は `process_*` イベント、結果は `FetchSummary`。実行枠は dsx と共有（同時に 1 件） |
| `check_remotes` | `gh api`（`commands/remote_status.rs`） | 全管理対象の `origin` を GitHub に問い合わせ、アーカイブ済み・移転・見つからないを返す。進捗は `process_*` イベント。実行枠は dsx・fetch と共有（同時に 1 件） |

`repo_update` などの dsx コマンドは `runner` 経由でストリーミングする。Cleanup コマンドは
`commands/cleanup.rs` で実装し、dsx を呼び出さない。

### 認証の制約

git2 の fetch（`fetch_all` / `fetch_repositories`）は、`commands/fetch.rs` の `credentials_callback` で認証情報を取る。HTTPS は git の認証情報ヘルパー（`credential.helper`。Windows は Git Credential Manager）、SSH は ssh-agent を使う（git2 は、このコールバックを設定しないと、どちらも使わない）。認証情報を入力する UI は無い。認証情報が未設定、または誤っている場合、`remote.fetch(...)` のエラーが `Result::Err` としてフロントに返され、Toast とコンソールに表示される。

## 実装フェーズ

旧計画（GitHub 連携・Graph・AI Insight）は廃止し、Issue #294 のピボット計画に置き換えた。

| 段階 | 内容 | 状態 |
|------|------|------|
| PR-A | 範囲外の機能の削除 | 完了 |
| PR-B | 実行基盤（runner）と実行ログコンソール | 完了 |
| PR-C | workspace のスキャンと一括 fetch | 完了 |
| PR-D | ダッシュボード（Header・Summary・タブ・dsx Tools） | 完了 |
| IPC | IPC ラッパーの `ipc/` への分離とカバレッジ対象外化 | 完了 |
| PR-E | 実機検証とドキュメント | 完了 |

詳細タスクは `tasks.md` を参照。
