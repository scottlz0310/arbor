#Requires -Version 5.1
<#
.SYNOPSIS
Arbor の署名証明書を信頼して MSIX 版をインストールする。

.DESCRIPTION
GitHub Releases から公開証明書と .appinstaller を取得する。
証明書がまだ LocalMachine\TrustedPeople に信頼登録されていない場合だけ、
証明書のインポート処理を管理者権限で実行する。MSIX のインストールは
元のユーザー権限で行うため、UAC で別の管理者アカウントを指定しても
アプリが別ユーザーへインストールされることはない。

このスクリプトは irm の結果を iex で実行することを前提にしているため、
自分自身のパス（$PSCommandPath）を使って再実行しない。

.PARAMETER BaseUrl
証明書と .appinstaller を取得するベース URL。ローカル検証時に差し替えられる。

.EXAMPLE
iex ([Text.Encoding]::UTF8.GetString((iwr -UseBasicParsing https://github.com/scottlz0310/arbor/releases/latest/download/install.ps1).Content).TrimStart([char]0xFEFF))

.EXAMPLE
pwsh -File .\scripts\install.ps1 -BaseUrl http://localhost:8000
#>
param(
    [string]$BaseUrl = "https://github.com/scottlz0310/arbor/releases/latest/download"
)

$ErrorActionPreference = "Stop"

function Get-ArborAssetUrl {
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$AssetName
    )

    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        throw "ダウンロード元の URL が空です。"
    }

    return "{0}/{1}" -f $BaseUrl.TrimEnd("/"), $AssetName
}

function Invoke-ArborDownload {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Path,
        [scriptblock]$DownloadStep
    )

    try {
        if ($null -ne $DownloadStep) {
            $null = & $DownloadStep -Uri $Uri -OutFile $Path
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
        }
    } catch {
        throw "ファイルのダウンロードに失敗しました（$Uri）: $($_.Exception.Message)"
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "ダウンロードしたファイルが見つかりません（$Path）"
    }
}

function Get-ArborCertificateThumbprint {
    param(
        [Parameter(Mandatory)][string]$Path
    )

    try {
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Path)
        $thumbprint = ($certificate.Thumbprint -replace "\s", "").ToUpperInvariant()
    } catch {
        throw "署名証明書を読み込めませんでした（$Path）: $($_.Exception.Message)"
    }

    if ([string]::IsNullOrWhiteSpace($thumbprint)) {
        throw "署名証明書の thumbprint が空です（$Path）"
    }

    return $thumbprint
}

function Get-ArborTrustedCertificates {
    param(
        [scriptblock]$CertificateStoreStep
    )

    if ($null -ne $CertificateStoreStep) {
        return @(& $CertificateStoreStep)
    }

    $storePath = "Cert:\LocalMachine\TrustedPeople"
    if (-not (Test-Path -LiteralPath $storePath)) {
        throw "証明書ストアを解決できません: $storePath"
    }

    try {
        return @(Get-ChildItem -LiteralPath $storePath)
    } catch {
        throw "証明書ストアを読み込めませんでした（$storePath）: $($_.Exception.Message)"
    }
}

function Test-ArborCertificateTrusted {
    param(
        [Parameter(Mandatory)][string]$Thumbprint,
        [scriptblock]$CertificateStoreStep
    )

    $normalizedThumbprint = (($Thumbprint -replace "\s", "").ToUpperInvariant())
    foreach ($certificate in @(Get-ArborTrustedCertificates -CertificateStoreStep $CertificateStoreStep)) {
        if ($null -eq $certificate -or [string]::IsNullOrWhiteSpace([string]$certificate.Thumbprint)) {
            continue
        }

        $candidateThumbprint = (($certificate.Thumbprint -replace "\s", "").ToUpperInvariant())
        if ([string]::Equals($candidateThumbprint, $normalizedThumbprint, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function New-ArborElevatedCertificateImportCommand {
    param(
        [Parameter(Mandatory)][string]$CertificatePath,
        [Parameter(Mandatory)][string]$Thumbprint
    )

    $escapedCertificatePath = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($CertificatePath)
    $escapedThumbprint = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Thumbprint)
    $command = @'
$ErrorActionPreference = "Stop"
$certificatePath = '__ARBOR_CERTIFICATE_PATH__'
$expectedThumbprint = '__ARBOR_THUMBPRINT__'
$certStorePath = 'Cert:\LocalMachine\TrustedPeople'
if (-not (Test-Path -LiteralPath $certStorePath)) {
    throw "証明書ストアを解決できません: $certStorePath"
}
$imported = Import-Certificate -FilePath $certificatePath -CertStoreLocation $certStorePath
$matching = @($imported | Where-Object { $_.Thumbprint -eq $expectedThumbprint })
if ($matching.Count -eq 0) {
    throw "証明書の信頼登録後に thumbprint を確認できません: $expectedThumbprint"
}
'@

    return $command.Replace("__ARBOR_CERTIFICATE_PATH__", $escapedCertificatePath).Replace("__ARBOR_THUMBPRINT__", $escapedThumbprint)
}

function ConvertTo-ArborEncodedCommand {
    param(
        [Parameter(Mandatory)][string]$Command
    )

    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
}

function Invoke-ArborElevatedCertificateImport {
    param(
        [Parameter(Mandatory)][string]$CertificatePath,
        [Parameter(Mandatory)][string]$Thumbprint,
        [scriptblock]$StartProcessStep
    )

    $command = New-ArborElevatedCertificateImportCommand -CertificatePath $CertificatePath -Thumbprint $Thumbprint
    $encodedCommand = ConvertTo-ArborEncodedCommand -Command $command
    $argumentList = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedCommand
    )

    try {
        if ($null -ne $StartProcessStep) {
            $process = & $StartProcessStep -FilePath "powershell.exe" -Verb "RunAs" -ArgumentList $argumentList -Wait -PassThru
        } else {
            $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argumentList -Wait -PassThru
        }
    } catch {
        throw "証明書の信頼登録のための管理者権限への昇格に失敗しました: $($_.Exception.Message)"
    }

    if ($null -eq $process) {
        throw "証明書の信頼登録を実行したプロセスの結果を取得できませんでした"
    }

    if ($process.ExitCode -ne 0) {
        throw "証明書の信頼登録に失敗しました（終了コード: $($process.ExitCode)）"
    }
}

function Invoke-ArborAppInstaller {
    param(
        [Parameter(Mandatory)][string]$Path,
        [scriptblock]$InstallAppxStep
    )

    try {
        if ($null -ne $InstallAppxStep) {
            $null = & $InstallAppxStep -Path $Path -AppInstallerFile
        } else {
            Add-AppxPackage -Path $Path -AppInstallerFile
        }
    } catch {
        throw "MSIX のインストールに失敗しました（$Path）: $($_.Exception.Message)"
    }
}

# v0.3.0 までの msi / NSIS（setup.exe）の Arbor は、アンインストール情報（レジストリ）に表示名 "Arbor" で載る。
function Get-ArborLegacyUninstallEntries {
    param(
        [scriptblock]$UninstallEntriesStep
    )

    if ($null -ne $UninstallEntriesStep) {
        return @(& $UninstallEntriesStep)
    }

    $paths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    return @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "Arbor" })
}

function Test-ArborLegacyInstall {
    param(
        [scriptblock]$UninstallEntriesStep
    )

    $entries = @(Get-ArborLegacyUninstallEntries -UninstallEntriesStep $UninstallEntriesStep)
    if ($entries.Count -gt 0) {
        Write-Warning "msi / setup.exe 版の Arbor が残っています（$($entries.Count) 件）。MSIX 版へ移行した後に、「設定 > アプリ」から削除してください。設定（~/.config/arbor）は、そのまま引き継がれます。"
    }
}

function Install-Arbor {
    [CmdletBinding()]
    param(
        [string]$BaseUrl = "https://github.com/scottlz0310/arbor/releases/latest/download",
        [string]$WorkDir,
        [scriptblock]$DownloadStep,
        [scriptblock]$CertificateThumbprintStep,
        [scriptblock]$CertificateStoreStep,
        [scriptblock]$StartProcessStep,
        [scriptblock]$InstallAppxStep,
        [scriptblock]$UninstallEntriesStep
    )

    $ownsWorkDir = $false
    if ([string]::IsNullOrWhiteSpace($WorkDir)) {
        $WorkDir = Join-Path ([IO.Path]::GetTempPath()) "arbor-install-$([guid]::NewGuid().ToString('N'))"
        $ownsWorkDir = $true
    }

    try {
        New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

        $certificateUrl = Get-ArborAssetUrl -BaseUrl $BaseUrl -AssetName "arbor.cer"
        $appInstallerUrl = Get-ArborAssetUrl -BaseUrl $BaseUrl -AssetName "arbor.appinstaller"
        $certificatePath = Join-Path $WorkDir "arbor.cer"
        $appInstallerPath = Join-Path $WorkDir "arbor.appinstaller"

        Write-Host "署名証明書を取得しています..."
        Invoke-ArborDownload -Uri $certificateUrl -Path $certificatePath -DownloadStep $DownloadStep

        if ($null -ne $CertificateThumbprintStep) {
            $thumbprint = & $CertificateThumbprintStep -Path $certificatePath
        } else {
            $thumbprint = Get-ArborCertificateThumbprint -Path $certificatePath
        }
        $thumbprint = (($thumbprint -replace "\s", "").ToUpperInvariant())
        if ([string]::IsNullOrWhiteSpace($thumbprint)) {
            throw "署名証明書の thumbprint が空です（$certificatePath）"
        }

        if (Test-ArborCertificateTrusted -Thumbprint $thumbprint -CertificateStoreStep $CertificateStoreStep) {
            Write-Host "署名証明書は既に信頼されています。"
        } else {
            Write-Host "署名証明書を LocalMachine\TrustedPeople に信頼登録します（UAC が表示されます）..."
            Invoke-ArborElevatedCertificateImport -CertificatePath $certificatePath -Thumbprint $thumbprint -StartProcessStep $StartProcessStep

            if (-not (Test-ArborCertificateTrusted -Thumbprint $thumbprint -CertificateStoreStep $CertificateStoreStep)) {
                throw "証明書の信頼登録後に thumbprint を確認できません: $thumbprint"
            }
        }

        Write-Host ".appinstaller を取得しています..."
        Invoke-ArborDownload -Uri $appInstallerUrl -Path $appInstallerPath -DownloadStep $DownloadStep

        Write-Host "MSIX 版 Arbor をインストールしています..."
        Invoke-ArborAppInstaller -Path $appInstallerPath -InstallAppxStep $InstallAppxStep

        Test-ArborLegacyInstall -UninstallEntriesStep $UninstallEntriesStep

        Write-Host ""
        Write-Host "Arbor のインストールが完了しました。"
        Write-Host "新しいバージョンは MSIX の自動更新で配布されます。"
    } finally {
        if ($ownsWorkDir -and (Test-Path -LiteralPath $WorkDir)) {
            Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Install-Arbor -BaseUrl $BaseUrl
