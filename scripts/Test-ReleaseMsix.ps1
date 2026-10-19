#Requires -Version 7
<#
.SYNOPSIS
draft Release から再取得した MSIX 一式が、公開してよい状態かを検証する。

.DESCRIPTION
次のいずれかに当てはまると、例外を投げて失敗する。
  - arbor_x64.msix / arbor.cer が無い
  - MSIX の AppxManifest.xml の Identity（Name・Publisher・Version）が、期待する値と一致しない
  - Publisher が公開証明書 arbor.cer の Subject と一致しない
  - MSIX の署名者が arbor.cer と異なる、署名が無い、または署名後に内容が書き換えられている

自己署名のため、署名の信頼チェーンまでは検証しない（利用者は install.ps1 が arbor.cer を信頼登録する）。
署名者の同一性と、署名後の改ざんの有無を確認する。MSIX・証明書の checksum は
verify-release-assets.sh が checksums-msix.txt と照合する。

.PARAMETER Dir
MSIX 一式を置いたディレクトリ。

.PARAMETER Version
期待する arbor の版。先頭に v を付けない（例: 0.11.0）。MSIX の版は末尾に .0 を付けた 4 要素になる。

.EXAMPLE
pwsh scripts/Test-ReleaseMsix.ps1 -Dir assets -Version 0.11.0
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][string]$Version
)
$ErrorActionPreference = "Stop"

$msixName = "scottlz0310.arbor"
$msixPath = Join-Path $Dir "arbor_x64.msix"
$cerPath = Join-Path $Dir "arbor.cer"

foreach ($path in $msixPath, $cerPath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "asset が無いか空です: $(Split-Path $path -Leaf)"
    }
}

$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $cerPath).Path)

# MSIX は ZIP。AppxManifest.xml の Identity を、パッケージ本体から直接読む
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $msixPath).Path)
try {
    $entry = $zip.GetEntry("AppxManifest.xml")
    if (-not $entry) {
        throw "arbor_x64.msix に AppxManifest.xml がありません"
    }

    $reader = [IO.StreamReader]::new($entry.Open())
    try {
        $manifest = [xml]$reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}
finally {
    $zip.Dispose()
}

$identity = $manifest.Package.Identity
if ($identity.Name -ne $msixName) {
    throw "MSIX の Identity Name が想定と異なります（期待: $msixName、実際: $($identity.Name)）"
}

if ($identity.Version -ne "$Version.0") {
    throw "MSIX の Identity Version が想定と異なります（期待: $Version.0、実際: $($identity.Version)）"
}

if ($identity.Publisher -ne $cert.Subject) {
    throw "MSIX の Publisher が arbor.cer の Subject と一致しません（Publisher: $($identity.Publisher)、Subject: $($cert.Subject)）"
}

$signature = Get-AuthenticodeSignature -LiteralPath $msixPath
if (-not $signature.SignerCertificate) {
    throw "MSIX が署名されていません（Status: $($signature.Status)）"
}

if ($signature.Status -in "NotSigned", "HashMismatch", "Incompatible") {
    throw "MSIX の署名が不正です。署名後に内容が書き換えられた可能性があります（Status: $($signature.Status)）"
}

if ($signature.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
    throw "MSIX の署名者が arbor.cer と異なります（署名者: $($signature.SignerCertificate.Thumbprint)、arbor.cer: $($cert.Thumbprint)）"
}

Write-Host "MSIX を検証しました（版: $($identity.Version)、署名者: $($cert.Subject)、署名: $($signature.Status)）"
