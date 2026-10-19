#Requires -Version 7
<#
.SYNOPSIS
MSIX 署名用の自己署名証明書を生成し、バックアップ（BackupDir と Bitwarden）と GitHub の Environment シークレットへの登録まで行う。

.DESCRIPTION
AppxManifest.xml の Publisher と一致する Subject の自己署名コード署名証明書を生成する。
実行順は次のとおりで、前の工程が失敗したら、後の工程へ進まない（Secrets だけが登録されて、
バックアップが無い状態を作らない）。

  1. 事前確認（読み取りだけ。外部へ書き込まない）: 出力先に既存の pfx / cer が無いこと、Bitwarden が解錠済みで
     同名の項目が無いこと、（-Register のとき）Environment の状態（デプロイ制限が想定どおりか、想定外のポリシーが
     無いか、同名のシークレットが無いか）。出力先のファイルとシークレットは -Force で上書きできる。
     Bitwarden の同名項目は、-Force でも上書きしない（削除するか、-BitwardenItemName を変える）。
  2. 生成: pfx（秘密鍵つき・パスワード保護）と cer（公開証明書）を BackupDir に書き出す。
     証明書は証明書ストアから削除する（pfx が唯一の保管物）。
  3. パスワードを Bitwarden の secure note に保存する（-SkipBitwarden で省略できる）。
  4. （-Register のとき）Environment（無ければ作り、デプロイできるブランチを -Branch だけに限定する）に、
     SIGNING_CERTIFICATE_BASE64 / SIGNING_CERTIFICATE_PASSWORD を登録する。値は標準入力で渡す（引数やログに出さない）。
     外部（GitHub）への書き込みは、この工程だけ。

署名用の Secrets を、リポジトリの Secrets ではなく Environment のシークレットに置くのは、同一リポジトリの PR が、
ワークフロー自体を書き換えて、リポジトリの Secrets を読めるため。Environment のデプロイを main に限定すれば、
PR のワークフローからは読めない。

パスワードは、画面にもログにも出力しない。pfx と同じ場所にも書かない。

.PARAMETER BackupDir
pfx と cer の書き出し先（バックアップ）。必須で、既定値は持たない。

.PARAMETER Register
GitHub の Environment シークレットに登録する。

.PARAMETER Environment
登録先の Environment の名前。ワークフロー（package-msix.yml）の `environment:` と同じにする。

.PARAMETER Branch
Environment がデプロイできるブランチ。既定は main。

.PARAMETER SkipBitwarden
パスワードを Bitwarden に保存しない。パスワードは GitHub にだけ残るため、pfx のバックアップは
証明書を残す以上の意味を持たない（紛失したら、証明書を作り直し、各 PC で install.ps1 を再実行する）。

.PARAMETER Force
BackupDir の既存の pfx / cer と、Environment の同名のシークレットを上書きする。

.EXAMPLE
pwsh packaging/msix/New-SigningCertificate.ps1 -BackupDir ~/Dropbox/src/arbor-dsx/cert -Register

.NOTES
バックアップからの復元は、Register-SigningSecrets.ps1。手順は、ハンドオフ（arbor-dsx/handoff/arbor.md のトピック 2）に書く。
Bitwarden に保存するには、BW_SESSION を設定した（解錠済みの）シェルから実行する。
#>
param(
    [Parameter(Mandatory)][string]$BackupDir,
    [string]$Subject = "CN=scottlz0310",
    [string]$Repo = "scottlz0310/arbor",
    [string]$Environment = "msix-signing",
    [string]$Branch = "main",
    [string]$BitwardenItemName = "arbor MSIX signing certificate",
    [int]$ValidYears = 5,
    [switch]$Register,
    [switch]$SkipBitwarden,
    [switch]$Force
)
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "SigningSecrets.ps1")

function New-ArborSigningPassword {
    $bytes = [byte[]]::new(24)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes)
}

# 証明書を生成して、pfx と cer を書き出す。ストアには残さない。
function New-ArborSelfSignedCertificateFiles {
    param(
        [Parameter(Mandatory)][string]$Subject,
        [Parameter(Mandatory)][int]$ValidYears,
        [Parameter(Mandatory)][string]$Password,
        [Parameter(Mandatory)][string]$PfxPath,
        [Parameter(Mandatory)][string]$CerPath
    )

    $cert = New-SelfSignedCertificate `
        -Type Custom `
        -Subject $Subject `
        -KeyUsage DigitalSignature `
        -FriendlyName "Arbor MSIX signing" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
        -NotAfter (Get-Date).AddYears($ValidYears)
    try {
        $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
        Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $securePassword | Out-Null
        Export-Certificate -Cert $cert -FilePath $CerPath | Out-Null
        return [PSCustomObject]@{ Thumbprint = $cert.Thumbprint; NotAfter = $cert.NotAfter }
    } finally {
        Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
    }
}

function Save-ArborSigningPassword {
    param(
        [Parameter(Mandatory)][string]$ItemName,
        [Parameter(Mandatory)][string]$Password,
        [Parameter(Mandatory)][string]$Thumbprint,
        [Parameter(Mandatory)][datetime]$NotAfter,
        [scriptblock]$CreateStep
    )

    $item = [ordered]@{
        organizationId = $null
        collectionIds  = $null
        folderId       = $null
        type           = 2
        name           = $ItemName
        notes          = $Password
        favorite       = $false
        fields         = @(
            [ordered]@{ name = "thumbprint"; value = $Thumbprint; type = 0 },
            [ordered]@{ name = "notAfter"; value = $NotAfter.ToString("yyyy-MM-dd"); type = 0 }
        )
        secureNote     = [ordered]@{ type = 0 }
        reprompt       = 0
    } | ConvertTo-Json -Depth 5 -Compress

    if ($null -ne $CreateStep) {
        $null = & $CreateStep -ItemJson $item
        return
    }

    # パスワードをコマンドラインに出さないよう、標準入力で渡す
    $encoded = $item | & bw encode
    if ($LASTEXITCODE -ne 0) { throw "bw encode に失敗しました（終了コード: $LASTEXITCODE）" }
    $null = $encoded | & bw create item
    if ($LASTEXITCODE -ne 0) { throw "Bitwarden への保存に失敗しました（終了コード: $LASTEXITCODE）" }
}

function Invoke-ArborSigningCertificateSetup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BackupDir,
        [string]$Subject = "CN=scottlz0310",
        [string]$Repo = "scottlz0310/arbor",
        [string]$Environment = "msix-signing",
        [string]$Branch = "main",
        [string]$BitwardenItemName = "arbor MSIX signing certificate",
        [int]$ValidYears = 5,
        [switch]$Register,
        [switch]$SkipBitwarden,
        [switch]$Force,
        [scriptblock]$CertificateStep,
        [scriptblock]$BitwardenStatusStep,
        [scriptblock]$BitwardenListStep,
        [scriptblock]$BitwardenCreateStep,
        [scriptblock]$EnvironmentStateStep,
        [scriptblock]$EnvironmentStep,
        [scriptblock]$SecretListStep,
        [scriptblock]$SecretSetStep
    )

    # 1. 事前確認（何も作る前に、後の工程が失敗する条件を取り除く）
    $backupPath = (New-Item -ItemType Directory -Force $BackupDir).FullName
    $pfxPath = Join-Path $backupPath "arbor-signing.pfx"
    $cerPath = Join-Path $backupPath "arbor.cer"
    if (-not $Force) {
        foreach ($path in $pfxPath, $cerPath) {
            if (Test-Path -LiteralPath $path) {
                throw "既に存在します: $path（上書きするには -Force。既存の証明書で署名した MSIX は、新しい証明書では更新できません）"
            }
        }
    }
    if (-not $SkipBitwarden) {
        if (-not (Test-ArborBitwardenUnlocked -StatusStep $BitwardenStatusStep)) {
            throw "Bitwarden が解錠されていません。BW_SESSION を設定したシェルから実行するか、-SkipBitwarden を指定してください"
        }
        if (Test-ArborBitwardenItemExists -Name $BitwardenItemName -ListStep $BitwardenListStep) {
            throw "Bitwarden に同名の項目があります: $BitwardenItemName（削除するか、-BitwardenItemName を変えてください）"
        }
    }
    $environmentState = $null
    if ($Register) {
        # Environment とシークレットの衝突は、外部へ書き込む前に、読み取りだけで判定する
        # （衝突で中止するときに、既存の Environment のデプロイ制限を書き換えないため）
        $environmentState = Get-ArborSigningEnvironmentState -Repo $Repo -Environment $Environment -StateStep $EnvironmentStateStep -SecretListStep $SecretListStep
        Assert-ArborSigningEnvironmentPlan -Environment $Environment -Branch $Branch -State $environmentState -Force:$Force
    }

    # 2. 生成
    $password = New-ArborSigningPassword
    if ($null -ne $CertificateStep) {
        $cert = & $CertificateStep -Subject $Subject -ValidYears $ValidYears -Password $password -PfxPath $pfxPath -CerPath $cerPath
    } else {
        $cert = New-ArborSelfSignedCertificateFiles -Subject $Subject -ValidYears $ValidYears -Password $password -PfxPath $pfxPath -CerPath $cerPath
    }

    # 3. パスワードのバックアップ
    if (-not $SkipBitwarden) {
        Save-ArborSigningPassword -ItemName $BitwardenItemName -Password $password -Thumbprint $cert.Thumbprint -NotAfter $cert.NotAfter -CreateStep $BitwardenCreateStep
    }

    # 4. Environment のシークレットへの登録
    if ($Register) {
        # ここまでの工程がすべて成功してから、Environment を整え、シークレットを登録する（外部への書き込みは、最後）
        Initialize-ArborSigningEnvironment -Repo $Repo -Environment $Environment -Branch $Branch -State $environmentState -EnvironmentStep $EnvironmentStep
        $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
        Register-ArborSigningSecrets -Repo $Repo -Environment $Environment -Base64 $base64 -Password $password -SetStep $SecretSetStep
    }

    Write-Host "証明書を生成しました（有効期限: $($cert.NotAfter.ToString('yyyy-MM-dd'))、Subject: $Subject、Thumbprint: $($cert.Thumbprint)）"
    Write-Host "  バックアップ先: $backupPath（arbor-signing.pfx は秘密鍵つき。コミット禁止）"
    Write-Host "  パスワード: $(if ($SkipBitwarden) { '保管していません（GitHub にだけあります）' } else { "Bitwarden の「$BitwardenItemName」" })"
    Write-Host "  GitHub: $(if ($Register) { "Environment「$Environment」（$Branch のみ）に $($ArborSigningSecretNames -join ' / ') を登録しました（$Repo）" } else { '登録していません（-Register で登録）' })"

    return [PSCustomObject]@{
        Thumbprint = $cert.Thumbprint
        NotAfter   = $cert.NotAfter
        PfxPath    = $pfxPath
        CerPath    = $cerPath
    }
}

# 関数だけを読み込む用途（テスト）では、実行しない
if ($MyInvocation.InvocationName -ne ".") {
    $null = Invoke-ArborSigningCertificateSetup -BackupDir $BackupDir -Subject $Subject -Repo $Repo -Environment $Environment -Branch $Branch -BitwardenItemName $BitwardenItemName -ValidYears $ValidYears -Register:$Register -SkipBitwarden:$SkipBitwarden -Force:$Force
}
