# Changelog

All notable changes to Arbor will be documented in this file.
Format: [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### feat

- **設定ファイルの保存先を、全 OS で `~/.config/arbor/config.toml` に統一した**（#324 PR 1）。これまでは、OS 標準の設定ディレクトリ（Windows の `%APPDATA%\arbor`、macOS の `~/Library/Application Support/arbor`）だった。Windows の配布を MSIX に一本化するため。MSIX は `%APPDATA%` への書き込みをパッケージ領域へ仮想化し、アンインストールで消すが、ユーザープロファイル直下は仮想化されず、外部から編集でき、アンインストールでも残る（dsx の `~/.config/dsx` と同じ）
  - **旧版の保存先にだけ設定があるときは、初回の読み込みで、新しい場所へコピーする**。旧ファイルは消さない（旧版へ戻しても、設定が残る）。新しい場所に設定があるときは、上書きしない。コピーに失敗したときは、握りつぶさずに、場所を含めてエラーにする
  - **移行は、並行した読み込みから保護している**（レビューでの指摘）。起動時は、`list_repositories` と `get_workspace_status` などが並行して `load_config` を呼ぶため、初回の移行が重なると、同じ移行先へ同時にコピーして、Windows で共有違反（os error 32）になりえた。設定の読み込み・変更を 1 つのロックで直列にし、移行は、一時ファイルへコピーし終えてからハードリンクで公開する（読み手は途中のファイルを見ず、別のプロセスが先に公開していても上書きしない）。8 スレッドで同時に移行する回帰テストを追加した（ロックと原子的な公開を外すと、失敗することを確認した）
  - `ARBOR_CONFIG_DIR`（debug build のみ）は、これまでどおり。隔離先を使うときは、旧版の保存先を見ない（実機の設定を持ち込まない）

- **Windows 向けの MSIX（自己署名 + `.appinstaller` + `install.ps1`）の生成と、署名証明書のスクリプトを追加した**（#324 PR 3a。dsx・photo-map-studio と同じ型）。リリースにはまだ繋いでいない（msi / NSIS はそのまま。切り替えは PR 3b）
  - `packaging/msix/`: `AppxManifest.xml`（`runFullTrust`。**書き込み仮想化は、既定（有効）のまま**にした。理由と実機の結果は、下の「実機での確認」。**実行エイリアス `arbor`** を宣言した）、`arbor.appinstaller.template`（`AutomaticBackgroundTask` のみ。GUI の起動時の更新確認を避ける）、`Build-Msix.ps1`（`tauri build --no-bundle` で作った `arbor.exe` を `makeappx` でパッケージ化し、`signtool` で署名。ロゴは `src-tauri/icons` のものを使う）
  - `New-SigningCertificate.ps1`: 自己署名証明書（`CN=scottlz0310`、コード署名 EKU、5 年）を生成し、pfx と cer を `-BackupDir`（必須。既定値もハードコードも無い）へ書き出す。pfx のパスワードは Bitwarden の secure note に保存し（`-SkipBitwarden` で省略可）、`-Register` で GitHub Secrets（`SIGNING_CERTIFICATE_BASE64` / `_PASSWORD`）に登録する。値は標準入力で渡し、パスワードは画面にもログにも出さない。事前確認（既存の pfx / Bitwarden の同名項目 / 同名の Secrets）を済ませてから生成し、バックアップが失敗したら Secrets を登録しない
  - `scripts/install.ps1`: 証明書が `LocalMachine\TrustedPeople` に無いときだけ、証明書のインポートを管理者権限（UAC）で行い、MSIX のインストール自体は元のユーザーで行う。旧版（msi / setup.exe）が残っていれば警告する
  - `scripts/Test-ReleaseMsix.ps1`: 署名した MSIX の Identity（Name・Version）、Publisher と `.cer` の Subject の一致、署名者の同一性、署名後の改ざんの有無を検証する
  - `.github/workflows/package-msix.yml`: 署名済みの MSIX を作る（`workflow_dispatch` と、`release.yml` から呼ぶ `workflow_call`）。MSIX に関わる PR では、未署名でパッケージ化だけを検証する。**署名用の Secrets（`SIGNING_CERTIFICATE_*`）は、署名するステップ（`env.SIGN == 'true'`）の `env` にだけ展開し、PR（未署名）のステップには展開しない**（レビューでの指摘。同一リポジトリの PR では Secrets が使えるため、`PfxPath` を省略するだけでは、PR 側の `Build-Msix.ps1` にパスワードが渡っていた。ビルドを署名と未署名の 2 つのステップに分け、未署名のステップは、パスワードが渡っていれば失敗する）。この規則は `tests/PackageMsixWorkflow.Tests.ps1` が検査する（漏れを再現すると失敗することを確認した）
  - Pester のテスト（`tests/*.Tests.ps1`）と、CI の `PowerShell Tests` ジョブを追加した
  - 署名証明書は、Arbor 専用（Thumbprint `E4091D55B296AE1E279643301803AC2035C78355`、2031-10-19 まで）。バックアップと Bitwarden への保存、Secrets への登録は、このスクリプトで行った
  - **実機での確認**（Windows 11、署名済みの MSIX を実際にインストール。UAC は、証明書の信頼登録の 1 回）
    - 署名は `Valid`（信頼登録の後）。`Test-ReleaseMsix.ps1` が成功。CI（`Package MSIX`）でも、署名・検証・checksum が通った
    - パッケージ内から、`dsx`（`WindowsApps` の実行エイリアス）・`git`・`gh`・`bw` が動く。`dsx doctor`、Remote の確認（`gh`。24 件）、Fetch All（git2 + Git Credential Manager。24 件）、Daily Refresh（Bitwarden 解錠済み。リポジトリ 23 件を更新、失敗 0）が成功した。scoop が書いたユーザー環境変数（`ANDROID_HOME`）は、パッケージの外から見えた
    - **実行中のキャンセル**（確認ダイアログの「強制終了」）が、パッケージ内でも効く（`■ キャンセルしました`、`dsx` の子プロセスが残らない）。`explorer` が前面に開く（#317 / #319 の回帰なし）
    - **旧設定の移行**: パッケージ内から旧版の保存先（`%APPDATA%\arbor\config.toml`）が読め、`~/.config/arbor/config.toml` にコピーされた（ハッシュが一致。旧ファイルは無傷）
    - **Bitwarden の解錠状態（`BW_SESSION`）は、起動の経路で決まる**: スタートメニューや explorer からの起動は、シェルの環境変数を引き継がないため、ヘッダーは「Bitwarden: 未解錠」になり、`doctor` も `BW_SESSION` を失敗として報告する。**シェルから `arbor`（実行エイリアス）で起動すると引き継ぎ**、「解錠済み」「Ready」になる。Daily Refresh で Bitwarden を使うときは、解錠したシェルから `arbor` で起動する（msi / exe 版と同じ運用）
    - **アンインストール**: 書き込み仮想化が有効なら、WebView2 のデータは `LocalCache` に入り、アンインストールで、パッケージ領域・実フォルダ・エイリアスとも**何も残らない**（設定の `~/.config/arbor` だけが残る）。仮想化を無効にした試作版では、WebView2 のデータ（約 83MB）が `%LOCALAPPDATA%\dev.scottlz0310.arbor` に残った。ただし、**すでに実在するディレクトリへの書き込みは、仮想化されない**ため、旧版（exe / msi）が先に作ったディレクトリがある PC では、そこに書かれ、アンインストールで消えない（その PC では、一度、手で削除する）

### ci

- **MSIX の署名用の Secrets を、リポジトリの Secrets から、Environment のシークレットへ移した**（#324 PR 3b-1）。同一リポジトリの PR は、ワークフロー自体を書き換えて、リポジトリの Secrets を読める（PR #329 のレビューで、署名用のパスワードが PR のステップに展開されていたと指摘され、ステップを分けて直したが、それは、PR のスクリプトを経由した漏えいを防ぐだけだった）。Environment `msix-signing` は、デプロイできるブランチを `main` だけに限定していて、PR のワークフローからは読めない
  - `package-msix.yml` を 3 つのジョブに分けた: `build`（`arbor.exe` を作る。Secrets は使わず、PR でも動く）、`package-unsigned`（PR 用。environment なし。署名用の Secrets は展開せず、渡っていれば失敗する）、`package-signed`（`environment: msix-signing`。PR では動かさない。署名・検証・checksum）。署名のジョブは、`build` が作った実行ファイルを受け取るだけで、ビルドスクリプトや依存の install スクリプトを、署名用の Secrets を持つジョブで動かさない
  - `packaging/msix/Register-SigningSecrets.ps1`（新規）: バックアップ（Dropbox の pfx と、Bitwarden のパスワード）から、証明書を作り直さずに、Environment のシークレットへ登録する。pfx が、そのパスワードで開けること（cer があれば、Thumbprint の一致も）を確かめてから登録する。Environment を作り（無ければ）、デプロイできるブランチを `main` だけに限定する。**外部（GitHub）への書き込みは、最後の工程だけ**で、それまでの判定は、すべて読み取りだけで行う（レビューでの指摘: 同名のシークレットの確認が、Environment の更新の後だったため、衝突で中止しても、既存の Environment のデプロイ制限が書き換わったままになりえた）。衝突の判定は、既存のデプロイ制限が想定（カスタム。main のみ）と異なる（`-Force` なしでは書き換えない）、想定外のブランチ / タグのポリシーがある（黙って消さない。`-Force` でも）、同名のシークレットがある（`-Force` なしでは上書きしない）。想定どおりの Environment には、何も書き込まない。`New-SigningCertificate.ps1 -Register` も、登録先を Environment に変えた（共通の関数は `SigningSecrets.ps1`）
  - 規則を `tests/PackageMsixWorkflow.Tests.ps1` で検査する（ジョブの外に Secrets を展開しない、`pull_request_target` を使わない、署名用の Secrets を展開するジョブは Environment を持ち PR では動かない、Environment のないジョブには Secrets を展開しない、ワークフローとスクリプトの Environment の名前が一致する）。Environment を外す、または未署名のジョブに展開すると、失敗することを確認した
  - 署名用の Secrets は、同じ値（Thumbprint `E4091D55…8355`）を Environment に登録済み。リポジトリの Secrets は、`workflow_dispatch` で署名のパスを確認してから、削除する
  - Environment が main に限定されるため、作業ブランチでは署名のジョブが動かない。署名のパスは、ワークフローを main に入れてから、`workflow_dispatch` で確認する

- **リリースの公開前の検証（`verify`）が、draft の Release を読めず、必ず失敗していた問題を直し、同じ種類の失敗を、リリースの前に見つけられる構造にした**。v0.3.0 のリリースで、`verify` が `contents: read` で動いたため、draft（書き込み権限のあるトークンにしか見えない）が `release not found` になり、成果物が揃っていても、公開に進めなかった（`finalize` は実行されず、draft のまま残った）。実行前のレビューでは、`GH_REPO` の指摘までしか、見つからなかった
  - **検証を、独立した `verify-release.yml`（`workflow_call` と `workflow_dispatch`）にした**。`release.yml` は、これを呼ぶだけ。手動でも、タグを指定するだけで、**どの draft にも、公開の前に実行できる**ため、検証の実装そのものを、実際の draft で、リリースの前に試せる。権限が `contents: write` である理由を、コメントに残した
  - **検証の中身を、`scripts/verify-release-assets.sh` に出した**。CI と手元で、同じものを実行する（成果物の組、`latest.json` の版とタグの一致、全 URL が Release の成果物を指すこと、プラットフォームが 3 つであること）。`shellcheck` を通し、実際の draft（v0.3.0）への成功と、存在しないタグ・不正な形式への失敗を確認した。Windows の `jq` / `gh` が付ける行末の CR も扱う
  - **失敗時の手順書を、CLAUDE.md の「リリース」に追加した**。一時的な失敗は「Re-run failed jobs」、ワークフローの定義の不具合は、再実行では直らず（再実行は、その時点の定義で動く）、`finalize` が「実行の SHA = リリースのコミット」を要求するため、main で直しても公開できない、という制約と、その場合の例外の手順（検証 → 手動の公開 → 記録）を明記した。draft の取り残しの確認（v0.2.1 の教訓）も入れた


## [0.3.0] - 2026-10-19

### docs

- **`tasks.md` の、ハンドオフの参照先を更新した**。#294 の完了に伴い、ハンドオフを `completed/` へ移したため。後続の Issue（#313・#317）も載せた

- **実機検証の結果をドキュメントに反映した**（#294 PR-E）。Windows の実機（28 リポジトリ）で、起動・旧形式の config の読み込み・`open_repo_folder`・`dsx doctor`・`sys update -n` と実行中のキャンセル・`Fetch All`・Settings の保存・Daily Refresh（Bitwarden 解錠済み）・Bitwarden 未解錠のときの表示と確認ダイアログを確認した。見つけた不具合は、認証が要る remote の fetch の失敗（#311）と、存在しない手動登録の扱い（#314）で、いずれも修正済み
  - README: dsx の前提の版を 0.11.0+ に更新し、「使うときの注意」（Bitwarden の解錠・fetch の認証・管理対象）と、実装の段階の表を追加した
  - CLAUDE.md: dsx の版、実装の段階の表、実機で動作を確かめるときの起動方法（`ARBOR_CONFIG_DIR`、`BW_SESSION`）を更新した

### fix

- **フォルダを開く（`open_repo_folder`）の explorer ウィンドウが、Arbor の背面に開く問題を直した**（#317）。Windows は、前面の権限を持たないプロセスのウィンドウを背面に開く。explorer は、起動済みのシェルへ要求を渡して開くため、Arbor が前面の権限を持つうちに `AllowSetForegroundWindow` で許可を出すようにした。実機で、`Open` を押したあとに、フォルダのウィンドウが前面になることを確認した（Windows 以外は、変更なし）

- **Rust のテストの一時ディレクトリが、並列で同じ名前になり、macOS の CI が不安定だった問題を直した**。名前を時刻（ナノ秒）だけで作っていたが、macOS は時計の分解能がマイクロ秒で、並列のテストが同じ名前を作って衝突していた（`commands/repo.rs` の `repo_info_for_path_*` が、`.git` の作成で失敗していた）。連番を足す共通の補助（`test_util::unique_suffix`）を作り、6 か所の `TempDir` / 一時パスに使う

- **ディスク上に無い手動登録を、一覧・要対応・Fetch の対象から外した**（#314）。削除済みのクローンを指す手動登録が、Status に branch 不明のカードとして表示され、「要対応」と Header の件数に数えられ、`Fetch All` を失敗させていた。`effective_repos` で除くので、一覧・fetch・cleanup・Header・フォルダを開く操作に、まとめて効く。Settings の「無効なリポジトリを検出」からは、これまでどおり登録を外せる

- **認証が要る remote（非公開リポジトリなど）の fetch が 401 で失敗していた**（#311）。`fetch_repository` が `RemoteCallbacks` に認証情報の取得（`credentials`）を設定しておらず、libgit2 は認証情報ヘルパーも ssh-agent も使わなかったため、公開リポジトリしか fetch できなかった。HTTPS は git の認証情報ヘルパー（`credential.helper`。Windows は Git Credential Manager）、SSH は ssh-agent を使い、ユーザー名の要求にも応える。認証情報の要求に応える回数には上限（3 回）を付け、誤った認証情報を返され続けても fetch が終わらなくなることを防ぐ。`Fetch All` と、単体の `fetch_repo` の両方が直る。実機の 28 リポジトリで、`Fetch All` の失敗が 5 件から 2 件（どちらも存在しないパスの手動登録）に減ることを確認した。SSH remote は、実機に該当するリポジトリがなく、未検証

### ci

- **リリースを release-automate へ移行した**。リリース準備 PR の作成から、タグ・draft の Release・ビルド・検証・公開までを、手作業なしで行う。これまでの `release.yml`（タグの push で draft を作ってビルドし、公開は手作業）では、v0.2.1 が、成果物が揃ったまま、3 か月、未公開の draft として残っていた
  - `prepare-release.yml`（新規）: 手動起動で、版（`MAJOR.MINOR.PATCH`）を指定すると、`package.json`・`tauri.conf.json`・`Cargo.toml`・`Cargo.lock` の版の更新と、`CHANGELOG.md` の `[Unreleased]` の確定を含むリリース準備 PR（`chore(release): vX.Y.Z`）を、Bot（GitHub App）名義で作る
  - `release.yml`（作り替え）: リリース準備 PR の squash マージで動く。release-automate が draft の Release とタグを作り、3 OS のビルドと成果物の添付、updater の `latest.json` の生成を行い、**Release から成果物を取り直して照合（必要な成果物の有無、`latest.json` の版とタグの一致、URL が Release の成果物を指すこと）してから、公開する**。照合に失敗すると、draft のまま残る。タグは `GITHUB_TOKEN` で作られ、タグの push を起点にする別のワークフローを起動しないため、ビルドは、タグの push ではなく、この流れから続ける
  - 署名（`TAURI_SIGNING_*`）と、成果物の組（msi / setup.exe / dmg / AppImage / deb / rpm と updater の署名）は、これまでと同じ

- **IPC ラッパーを `src-tauri/src/ipc/` に分け、カバレッジ対象から外した**（#309）。`#[tauri::command]` の 24 個の関数を、ロジックを持たない薄いラッパーとして `ipc/` に集め、ロジックは `commands/` のテストできる関数へ切り出した（`DsxTask`・`modify_config`・`register_repository` / `apply_settings` / `build_preview` / `fetch_all_repositories` など）。コマンド名・引数・戻り値は変えていない
  - `ipc/` は CI の `cargo llvm-cov --ignore-filename-regex` と `codecov.yml` の `ignore` で対象外にする。ラッパーは `tauri::State` を要し、Windows では `tauri::test` のテスト実行ファイルが起動しないため、単体テストできない
  - `ipc/guard.rs` のテスト（`syn` で構文木を検査）が、除外の正当性を保つ。`ipc/` には `use` / `mod` と `#[tauri::command]` の関数だけを置け、本文は 4 文以内で分岐・繰り返しを含められない。コマンドと `generate_handler!` の登録が過不足なく一致し、除外の設定が `ipc/` を指していることも検査する。違反すると `cargo test` が失敗する
  - 設定の読み込み・保存を `load_from` / `save_to` に分け、「読み込み → 変更 → 保存」を `modify_config` にまとめた（失敗した変更は保存しない）。テストを追加した
- Codecov の frontend フラグの対象を `src/lib/` のみから `src/lib/`・`src/components/`・`src/views/` に広げた。`bunfig.toml` と `coverage-manifest.test.ts` は、すでに lib / components / views を対象にしていたため、設定のずれを直した（コンポーネントとビューのテストが Codecov の patch に反映されず、`codecov/patch` が Rust のコマンド部分だけで判定されていた）

### feat

- **アーカイブ済み・移転・消えた remote のクローンを検出して、Status に表示する**（#313）。git だけでは、アーカイブ済みかどうかが分からない（transfer の後も旧 URL はリダイレクトされ、アーカイブの後も fetch は成功する）ため、消し忘れたクローンに気づけなかった
  - Status タブの「🔍 Remote を確認」で、各リポジトリの `origin`（GitHub のもの）を `gh api repos/{owner}/{repo}` で問い合わせ、結果をカードのバッジで示す: `▣ archived`（アーカイブ済み）・`✗ remote なし`（404。削除されたか、権限が無い）・`→ 移転`（transfer や rename の後。GitHub 上の現在の名前を、ヒントに出す）・`! 確認失敗`。Summary の TOTAL のカードにも、件数を添える（「要対応」の数には混ぜない）
  - ネットワークを使うため、自動では走らせない。fetch と同じ実行の枠（同時に 1 件）で、進捗を実行ログコンソールに流し、最大 4 並列で確認する。`cancel_run` で中断できる。結果は、アプリを閉じるまで保持する
  - 削除は、Arbor では行わない。カードの `Open` で、エクスプローラーを開いて消す。GitHub 以外の `origin`・`origin` の無いリポジトリは、対象外
  - `gh` の呼び出しは差し替えられる形で、`origin` の URL の解釈（https・scp・ssh://）、`gh` の出力の解釈、アーカイブ・移転の判定を、ネットワークに出ないテストで確認している。`gh api` の owner / repo は、使える文字だけに限る
  - 実機で、アーカイブ済みで `scottlz0310-user/` へ移転済みのリポジトリのクローンが、`▣ archived` と、移転後の名前つきで表示されることを確認した

- **dsx Tools タブ**（#294 PR-D3）。Repository Status / Branch Cleanup に並ぶタブとして、dsx の管理を集約した。これで PR-D（Refresher Dashboard）は完了
  - dsx の版と場所、最新版の確認（バージョン確認）、Self Update。Settings にあった dsx の管理（版の確認・Sys Update・Self Update）を、ここへ移した
  - 実行ボタン: Update All Tools（`dsx sys update`。確認ダイアログつき）、Dry Run（`dsx sys update -n`。計画だけを表示）、Update Repositories（`dsx repo update --root`）、Doctor（`dsx doctor`）。出力は解析せず、実行ログコンソールに流す。別の run の実行中、または dsx が無いときは押せない
  - `sys_update_dry_run`・`dsx_doctor` を追加
  - MSIX 版の dsx は `dsx self-update` では更新されない（.appinstaller による自動更新）。self-update が成功しても版が上がらなかった場合は、公式の `install.ps1` を実行する手順を案内する
  - Summary の「DSX ENVIRONMENT」カードは、Settings ではなくこのタブへ移動する
  - 修正: Settings の dsx 表示が「dsx dsx version 0.11.0」と重複していた（版は `v0.11.0` に整形して表示する）
- **ダッシュボード**（#294 PR-D2）。サイドバーをやめ、Header の下に Summary strip と、Repository Status / Branch Cleanup のタブを置いた。Settings は Header から開く
  - Summary: リポジトリ数（クリーンの数）・要対応の数・Cleanup 候補数・dsx 環境（Ready / Attention / Missing）。クリックで該当のビューへ移動する。Cleanup 候補数は、プレビューが全リポジトリの remote へ接続して遅いため、Cleanup を開いたときだけ集計し、run の終了や Scan で破棄する
  - Status: All / Needs Action / Clean の絞り込み（件数つき）。要対応を先頭に並べる。リポジトリごとに Fetch（git2）とフォルダを開く操作。状態に `dirty`（未コミット・未追跡の変更）を追加。要対応の判定は branch-chk の DETACHED / DIRTY / AHEAD / BEHIND / DIVERGED / no-upstream
  - `open_repo_folder` を追加。渡されたパスは管理対象の検索にだけ使い、開くのは管理対象として解決したパスだけ（任意のパスは開かない）
  - 修正: 起動直後に必ず Settings が開いていた。リポジトリの読み込み前の空の一覧で「0 件なら Settings へ」を判定していたため、初回の読み込みが終わってから、1 回だけ判定する（読み込みに失敗した場合も 0 件として誘導する。誘導後は、0 件のままでも Status へ戻れる）
  - 修正: Settings のスクロールバーが、コンテンツ幅（680px）の位置に出ていた
- **Header と Daily Refresh**（#294 PR-D1）。画面上部に、dsx の版・Bitwarden の状態・workspace root（リポジトリ数）の pill と、Scan / Fetch All / dsx sys update / Daily Refresh のボタンを追加
  - Daily Refresh は `dsx run --root <workspace root>` を実行する。dsx v0.11.0 未満・root 未設定・root を読めない場合は無効にし、理由をツールチップに出す。Bitwarden が未解錠なら、確認してから実行する（Arbor では解錠しない）
  - `repo_update` は、リポジトリ 1 件ではなく workspace root 配下の全リポジトリを `--root` つきで更新する（従来は dsx 自身の設定の root を更新していて、選択中のリポジトリとずれていた）。リポジトリごとの Update ボタンとコマンドパレットの項目は削除し、「Update All Repositories」を追加
  - run（dsx の実行・fetch）が終わると、一覧と環境の状態を自動で読み直す。中断された run も対象。Settings での root・手動登録の変更でも、Header の表示（root・リポジトリ数・Daily Refresh の有効 / 無効）を読み直す
  - `dsx_check` は `supports_run_root` を返す。`bitwarden_status`（`dsx env status --quiet` の終了コード）と `get_workspace_status`（root・検出数・読めない理由）を追加
  - 同期で起動する `dsx` の確認コマンドでも、Windows のリリースビルドでコンソール窓が出ないようにした
- **全リポジトリの一括 fetch**（#294 PR-C-2）。Overview の「Fetch All」とコマンドパレットから、管理対象（workspace root 配下の自動検出 + 手動登録）の全リポジトリを git2 で fetch する（`fetch_repositories`）
  - runner の job として実行し、dsx と同じ枠・同じ `process_*` イベントを使う。1 件ごとの結果と最後の集計がコンソールに流れ、実行中は `cancel_run` で中断できる（転送中の fetch も打ち切る）
  - 並列数は 4（dsx の `repo update --jobs 4` と同じ）。1 件が失敗しても残りは続け、失敗したリポジトリは stderr 行と結果に残す。中断された fetch は失敗として数えない
  - 実行中に別のコマンド（dsx など）を起動しようとすると、従来どおり拒否する。Fetch All のボタンも実行中は押せない
  - runner に `run_job`（子プロセスを持たない処理を同じ枠で実行。panic しても `process_finished` を送って枠を空ける）を追加
  - 単一リポジトリの `fetch_all` は、この実装を共有する（挙動は変えない）
- **Workspace スキャナー**（#294 PR-C-1）。`workspace.root`（既定 `~/src`）の直下を自動で検出し、一覧・Cleanup の対象にする。dsx の `repo.root` と同じ規則（root 自身が git ならそれも、直下の子ディレクトリのみ）なので、dsx の実行対象と常に一致する
  - 手動登録（`repositories`）は残し、root の外のリポジトリの追加と、名前・protected branches の追加に使う。Settings の「Scan Folder」（深さ 4 の再帰検出）は、Workspace の root 設定に置き換えた
  - 状態に `is_detached`・`has_upstream`・`source`（workspace / manual）を追加。Overview のカードに `detached` と `no upstream`（upstream が無く、ahead / behind が 0 になるため「同期済み」と区別する）を表示する
  - `list_repositories` を最大 8 並列のスキャンにし、UI スレッドを塞がないようにした（実測: 26 リポジトリを約 0.5 秒）
  - protected branches に全体の既定（main / master / develop / dev）を追加。手動登録の設定は、これに追加される
  - `root` が存在しない・読めない場合は、手動登録だけを一覧にし、警告をログに出す
- **実行ログコンソールを追加**（#294 PR-B-2）。App の下部に開閉できるドックとして常駐し、dsx の出力を `process_*` イベントでリアルタイムに表示する
  - stdout / stderr / システム行を色分けして表示し、ANSI の前景色・太字・薄字を解釈する（React の要素として描画し、HTML としては解釈しない）
  - `\r` で上書きされる進捗行は、1 行のまま更新する
  - 自動追従（上へスクロールすると解除し、最下部へ戻ると再開）、フィルタ、Copy（ANSI を除去）、Clear、開閉
  - 実行中は「キャンセル」を表示し、確認ダイアログを経て `cancel_run` を呼ぶ
  - 保持するのは直近 10,000 行。受信したイベントは描画フレームごとにまとめて反映する
  - 実行が始まるとドックが自動で開く
- **外部コマンドの実行基盤を追加**（#294 PR-B-1）。`commands/runner.rs` が dsx の実行を担い、`dsx_progress` イベントを `process_started` / `process_output` / `process_finished` に置き換えた
  - stdout に加えて stderr も行単位で逐次送信する（従来は stderr を終了時にまとめて返していた）
  - `\r` で上書きされる進捗行を区別して送る（`overwrite`）。不正な UTF-8 は置換文字にして読み取りを続ける（従来は不正なバイトで実行全体が失敗していた）
  - 同時に実行できるコマンドは 1 件。実行中の 2 件目は起動せずエラーにする
  - `cancel_run` を追加。Windows は Job Object、Unix はプロセスグループで、子孫プロセスまで強制終了する。実行が終わった時点で残った子孫プロセスも止める
  - Windows のリリースビルドで、dsx 実行時にコンソール窓が出ないようにした（`CREATE_NO_WINDOW`）
  - 標準入力を閉じて起動する（対話入力を待つコマンドが止まらず、失敗するようにする）
- 依存: Windows に `windows-sys`（Job Object）、Unix に `libc` を追加

### refactor

- Overview 内の埋め込みログパネルと、`uiStore` の `dsxProgress` / `dsxRunning` を削除（実行ログは `LogConsole` に統合）
- **Arbor のピボット（#294）の第一段階: スコープ外の機能を削除**。dsx の実行・表示基盤 兼 開発環境リフレッシュナーへ向けて、次の画面とその裏側（Rust コマンド・モデル・テスト・依存）を削除
  - AI Assistant / Ollama（`get_ai_insights` などの AI コマンド、AI 設定）
  - PR / Issues（GitHub REST API 連携、GitHub PAT の保存と、リポジトリごとの GitHub 設定）
  - Commit Graph、Stash、Branches（`get_commit_graph`、stash 系、`get_branches`、`delete_branches`）
  - 依存: `@tanstack/react-query`、`keyring-core` 系（macOS / Linux）、`windows-sys`（DPAPI）、未使用の `tokio`
  - Overview の Recommended Actions は、ルールベース（diverged / far behind）のみに簡素化
  - ナビゲーションは Overview / Cleanup / Settings の 3 つ

### 互換性に関する注意

- 旧バージョンの `config.toml`（`[ai]`、GitHub PAT、リポジトリごとの GitHub 設定を含む）は、そのまま読み込める。未知のフィールドは無視され、次回の保存時に削除される
- macOS / Linux の OS キーチェーンに保存済みの GitHub PAT（サービス名 `arbor_github_pat`）は、自動では削除されない。不要であればキーチェーンから手動で削除すること。Windows の暗号化済み PAT は `config.toml` の保存時に削除される

## [0.2.1] — 2026-07-17

### chore

- vite を `^8.1.4` → `^8.1.5` に更新 (#205)
- フロントエンド toolchain から Node.js を撤去（#197 PR 2）。vite / tsc を `bun --bun` で Bun ランタイム実行に切り替え、CI / release workflow の `actions/setup-node` と `engines.node` を削除
- テストランナーを Vitest から bun test へ移行（#197 PR 1）。jsdom → happy-dom、Tauri IPC 境界モックの preload 集約、zustand ストアのテスト間リセット、`vi.mock` の spyOn 統一を実施。カバレッジは `coverage/lcov.info` 出力を維持
- CI/release の cargo キャッシュを Swatinem/rust-cache@v2 に移行。キーに rustc バージョンが含まれず toolchain 更新後にキャッシュが恒久的に無効化・再保存されない問題を修正し、ジョブ別 key と main 限定保存で並行ジョブのキャッシュ汚染とスコープ重複を防止 (#202)
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
