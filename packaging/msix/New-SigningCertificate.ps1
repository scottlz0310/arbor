#Requires -Version 7
<#
.SYNOPSIS
MSIX 署名用の自己署名証明書を生成し、バックアップ（BackupDir と Bitwarden）と GitHub Secrets への登録まで行う。

.DESCRIPTION
AppxManifest.xml の Publisher と一致する Subject の自己署名コード署名証明書を生成する。
実行順は次のとおりで、前の工程が失敗したら、後の工程へ進まない（Secrets だけが登録されて、
バックアップが無い状態を作らない）。

  1. 事前確認: 出力先に既存の pfx / cer が無いこと、Bitwarden が解錠済みで同名の項目が無いこと、
     （-Register のとき）同名の Secrets が無いこと。出力先のファイルと Secrets は -Force で上書きできる。
     Bitwarden の同名項目は、-Force でも上書きしない（削除するか、-BitwardenItemName を変える）。
  2. 生成: pfx（秘密鍵つき・パスワード保護）と cer（公開証明書）を BackupDir に書き出す。
     証明書は証明書ストアから削除する（pfx が唯一の保管物）。
  3. パスワードを Bitwarden の secure note に保存する（-SkipBitwarden で省略できる）。
  4. （-Register のとき）SIGNING_CERTIFICATE_BASE64 / SIGNING_CERTIFICATE_PASSWORD を GitHub Secrets に登録する。
     値は標準入力で渡す（引数やログに出さない）。

パスワードは、画面にもログにも出力しない。pfx と同じ場所にも書かない。

.PARAMETER BackupDir
pfx と cer の書き出し先（バックアップ）。必須で、既定値は持たない。

.PARAMETER Register
GitHub Secrets に登録する。

.PARAMETER SkipBitwarden
パスワードを Bitwarden に保存しない。パスワードは GitHub Secrets にだけ残るため、pfx のバックアップは
証明書を残す以上の意味を持たない（紛失したら、証明書を作り直し、各 PC で install.ps1 を再実行する）。

.PARAMETER Force
BackupDir の既存の pfx / cer と、GitHub の同名の Secrets を上書きする。

.EXAMPLE
pwsh packaging/msix/New-SigningCertificate.ps1 -BackupDir ~/Dropbox/src/arbor-dsx/cert -Register

.NOTES
復元の手順は、ハンドオフ（arbor-dsx/handoff/arbor.md のトピック 2）に書く。
Bitwarden に保存するには、BW_SESSION を設定した（解錠済みの）シェルから実行する。
#>
param(
    [Parameter(Mandatory)][string]$BackupDir,
    [string]$Subject = "CN=scottlz0310",
    [string]$Repo = "scottlz0310/arbor",
    [string]$BitwardenItemName = "arbor MSIX signing certificate",
    [int]$ValidYears = 5,
    [switch]$Register,
    [switch]$SkipBitwarden,
    [switch]$Force
)
$ErrorActionPreference = "Stop"

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

function Test-ArborBitwardenUnlocked {
    param([scriptblock]$StatusStep)

    $json = if ($null -ne $StatusStep) { & $StatusStep } else { & bw status 2>$null }
    try {
        return ($json | ConvertFrom-Json).status -eq "unlocked"
    } catch {
        return $false
    }
}

function Test-ArborBitwardenItemExists {
    param(
        [Parameter(Mandatory)][string]$Name,
        [scriptblock]$ListStep
    )

    $json = if ($null -ne $ListStep) { & $ListStep -Name $Name } else { & bw list items --search $Name }
    $items = @($json | ConvertFrom-Json) | Where-Object { $_.name -eq $Name }
    return @($items).Count -gt 0
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

function Get-ArborExistingSecretNames {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [scriptblock]$ListStep
    )

    if ($null -ne $ListStep) { return @(& $ListStep -Repo $Repo) }
    $names = & gh secret list --repo $Repo --json name --jq ".[].name"
    if ($LASTEXITCODE -ne 0) { throw "GitHub Secrets の一覧を取得できません（終了コード: $LASTEXITCODE）。gh auth status を確認してください" }
    return @($names | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Register-ArborSigningSecrets {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Base64,
        [Parameter(Mandatory)][string]$Password,
        [scriptblock]$SetStep
    )

    $values = [ordered]@{
        SIGNING_CERTIFICATE_BASE64   = $Base64
        SIGNING_CERTIFICATE_PASSWORD = $Password
    }
    foreach ($name in $values.Keys) {
        if ($null -ne $SetStep) {
            $null = & $SetStep -Repo $Repo -Name $name -Value $values[$name]
            continue
        }
        # 値は標準入力で渡す（引数に出さない）
        $values[$name] | & gh secret set $name --repo $Repo
        if ($LASTEXITCODE -ne 0) { throw "Secret $name の登録に失敗しました（終了コード: $LASTEXITCODE）" }
    }
}

function Invoke-ArborSigningCertificateSetup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BackupDir,
        [string]$Subject = "CN=scottlz0310",
        [string]$Repo = "scottlz0310/arbor",
        [string]$BitwardenItemName = "arbor MSIX signing certificate",
        [int]$ValidYears = 5,
        [switch]$Register,
        [switch]$SkipBitwarden,
        [switch]$Force,
        [scriptblock]$CertificateStep,
        [scriptblock]$BitwardenStatusStep,
        [scriptblock]$BitwardenListStep,
        [scriptblock]$BitwardenCreateStep,
        [scriptblock]$SecretListStep,
        [scriptblock]$SecretSetStep
    )

    $secretNames = @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")

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
    if ($Register -and -not $Force) {
        $existing = @(Get-ArborExistingSecretNames -Repo $Repo -ListStep $SecretListStep) | Where-Object { $secretNames -contains $_ }
        if (@($existing).Count -gt 0) {
            throw "GitHub に同名の Secrets があります: $($existing -join ', ')（上書きするには -Force）"
        }
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

    # 4. Secrets への登録
    if ($Register) {
        $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
        Register-ArborSigningSecrets -Repo $Repo -Base64 $base64 -Password $password -SetStep $SecretSetStep
    }

    Write-Host "証明書を生成しました（有効期限: $($cert.NotAfter.ToString('yyyy-MM-dd'))、Subject: $Subject、Thumbprint: $($cert.Thumbprint)）"
    Write-Host "  バックアップ先: $backupPath（arbor-signing.pfx は秘密鍵つき。コミット禁止）"
    Write-Host "  パスワード: $(if ($SkipBitwarden) { '保管していません（GitHub Secrets にだけあります）' } else { "Bitwarden の「$BitwardenItemName」" })"
    Write-Host "  GitHub Secrets: $(if ($Register) { "$($secretNames -join ' / ') を登録しました（$Repo）" } else { '登録していません（-Register で登録）' })"

    return [PSCustomObject]@{
        Thumbprint = $cert.Thumbprint
        NotAfter   = $cert.NotAfter
        PfxPath    = $pfxPath
        CerPath    = $cerPath
    }
}

# 関数だけを読み込む用途（テスト）では、実行しない
if ($MyInvocation.InvocationName -ne ".") {
    $null = Invoke-ArborSigningCertificateSetup -BackupDir $BackupDir -Subject $Subject -Repo $Repo -BitwardenItemName $BitwardenItemName -ValidYears $ValidYears -Register:$Register -SkipBitwarden:$SkipBitwarden -Force:$Force
}
