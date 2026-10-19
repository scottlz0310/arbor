#Requires -Version 7
<#
.SYNOPSIS
バックアップ（pfx と、Bitwarden のパスワード）から、署名用の Secrets を、GitHub の Environment に登録し直す。

.DESCRIPTION
証明書は作り直さない（Thumbprint は変わらない）。次のときに使う。
  - 署名用の Secrets を、リポジトリの Secrets から Environment のシークレットへ移すとき
  - Secrets を失った、または、リポジトリを移したとき

実行順は次のとおりで、前の工程が失敗したら、後の工程へ進まない。外部（GitHub）へ書き込むのは、最後の工程だけ
（衝突で中止するときに、既存の Environment のデプロイ制限を書き換えない）。
  1. 事前確認: BackupDir の pfx、Bitwarden の解錠と項目。
  2. pfx が、Bitwarden のパスワードで開けること（BackupDir に cer があれば、Thumbprint の一致も）を確認する。
  3. Environment の状態を、読み取りだけで取得し、衝突を判定する（既存のデプロイ制限が想定と異なる、想定外のポリシーがある、
     -Force なしで同名のシークレットがある、のいずれかなら、書き込まずに失敗する）。
  4. Environment を作り（無ければ）、デプロイできるブランチを -Branch だけに限定し、
     SIGNING_CERTIFICATE_BASE64 / SIGNING_CERTIFICATE_PASSWORD を登録する。値は標準入力で渡す（引数やログに出さない）。

パスワードは、画面にもログにも出力しない。

.PARAMETER BackupDir
pfx（arbor-signing.pfx）と cer（arbor.cer）があるバックアップ先。必須で、既定値は持たない。

.PARAMETER Environment
登録先の Environment の名前。ワークフロー（package-msix.yml）の `environment:` と同じにする。

.PARAMETER Force
Environment の同名のシークレットを上書きする。既存の Environment のデプロイ制限が想定と異なるときに、書き換える。
（想定外のブランチ / タグのポリシーは、-Force でも、黙って消さない。）

.EXAMPLE
pwsh packaging/msix/Register-SigningSecrets.ps1 -BackupDir ~/Dropbox/src/arbor-dsx/cert

.NOTES
Bitwarden を解錠したシェル（BW_SESSION）から実行する。リポジトリの管理者権限が要る（Environment の作成）。
#>
param(
    [Parameter(Mandatory)][string]$BackupDir,
    [string]$Repo = "scottlz0310/arbor",
    [string]$Environment = "msix-signing",
    [string]$Branch = "main",
    [string]$BitwardenItemName = "arbor MSIX signing certificate",
    [switch]$Force
)
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "SigningSecrets.ps1")

# pfx を、パスワードで開く。開けなければ例外。Thumbprint を返す。
function Get-ArborPfxThumbprint {
    param(
        [Parameter(Mandatory)][string]$PfxPath,
        [Parameter(Mandatory)][string]$Password
    )

    try {
        $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($PfxPath, $Password)
    } catch {
        throw "pfx を、Bitwarden のパスワードで開けません（$PfxPath）: $($_.Exception.Message)"
    }
    if (-not $cert.HasPrivateKey) { throw "pfx に秘密鍵がありません: $PfxPath" }
    return $cert.Thumbprint
}

function Get-ArborCerThumbprint {
    param([Parameter(Mandatory)][string]$CerPath)

    return [Security.Cryptography.X509Certificates.X509Certificate2]::new($CerPath).Thumbprint
}

function Invoke-ArborSigningSecretsRestore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BackupDir,
        [string]$Repo = "scottlz0310/arbor",
        [string]$Environment = "msix-signing",
        [string]$Branch = "main",
        [string]$BitwardenItemName = "arbor MSIX signing certificate",
        [switch]$Force,
        [scriptblock]$BitwardenStatusStep,
        [scriptblock]$BitwardenGetStep,
        [scriptblock]$PfxThumbprintStep,
        [scriptblock]$CerThumbprintStep,
        [scriptblock]$EnvironmentStateStep,
        [scriptblock]$EnvironmentStep,
        [scriptblock]$SecretListStep,
        [scriptblock]$SecretSetStep
    )

    # 1. 事前確認
    $pfxPath = Join-Path $BackupDir "arbor-signing.pfx"
    $cerPath = Join-Path $BackupDir "arbor.cer"
    if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
        throw "pfx がありません: $pfxPath"
    }
    if (-not (Test-ArborBitwardenUnlocked -StatusStep $BitwardenStatusStep)) {
        throw "Bitwarden が解錠されていません。BW_SESSION を設定したシェルから実行してください"
    }
    $password = Get-ArborSigningPassword -ItemName $BitwardenItemName -GetStep $BitwardenGetStep

    # 2. pfx が、そのパスワードで開けること（cer があれば、同じ証明書であること）
    $thumbprint = if ($null -ne $PfxThumbprintStep) { & $PfxThumbprintStep -PfxPath $pfxPath -Password $password } else { Get-ArborPfxThumbprint -PfxPath $pfxPath -Password $password }
    if (Test-Path -LiteralPath $cerPath -PathType Leaf) {
        $cerThumbprint = if ($null -ne $CerThumbprintStep) { & $CerThumbprintStep -CerPath $cerPath } else { Get-ArborCerThumbprint -CerPath $cerPath }
        if ($cerThumbprint -ne $thumbprint) {
            throw "pfx と cer の証明書が一致しません（pfx: $thumbprint、cer: $cerThumbprint）"
        }
    }

    # 3. Environment とシークレットの衝突の判定（読み取りだけ。外部へ書き込む前に、すべて済ませる。
    #    衝突で中止するときに、既存の Environment のデプロイ制限を書き換えないため）
    $environmentState = Get-ArborSigningEnvironmentState -Repo $Repo -Environment $Environment -StateStep $EnvironmentStateStep -SecretListStep $SecretListStep
    Assert-ArborSigningEnvironmentPlan -Environment $Environment -Branch $Branch -State $environmentState -Force:$Force

    # 4. 外部への書き込み（ここまでの確認がすべて成功してから）: Environment を整え、シークレットを登録する
    Initialize-ArborSigningEnvironment -Repo $Repo -Environment $Environment -Branch $Branch -State $environmentState -EnvironmentStep $EnvironmentStep
    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
    Register-ArborSigningSecrets -Repo $Repo -Environment $Environment -Base64 $base64 -Password $password -SetStep $SecretSetStep

    Write-Host "署名用のシークレットを登録しました（Thumbprint: $thumbprint）"
    Write-Host "  登録先: Environment「$Environment」（$Branch のみ）、$($ArborSigningSecretNames -join ' / ')（$Repo）"
    return [PSCustomObject]@{ Thumbprint = $thumbprint }
}

# 関数だけを読み込む用途（テスト）では、実行しない
if ($MyInvocation.InvocationName -ne ".") {
    $null = Invoke-ArborSigningSecretsRestore -BackupDir $BackupDir -Repo $Repo -Environment $Environment -Branch $Branch -BitwardenItemName $BitwardenItemName -Force:$Force
}
