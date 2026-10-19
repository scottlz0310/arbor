# scripts/verify-release-assets.sh（draft の Release の成果物の検証。公開の前の関門）を検査する。
# `gh` を、フィクスチャのディレクトリを読むシェルスクリプトで差し替え、PATH の先頭に置く（実際の Release には触れない）。
# bash・jq・sha256sum が使える環境（Git Bash、Linux、macOS）で動かす。無ければ、skip する。
BeforeAll {
    $script:bash = (Get-Command bash -ErrorAction SilentlyContinue)?.Source
    $script:jq = (Get-Command jq -ErrorAction SilentlyContinue)?.Source
    $script:canRun = [bool]($script:bash -and $script:jq)
    $script:verifyScript = (Resolve-Path "$PSScriptRoot/../scripts/verify-release-assets.sh").Path

    # フィクスチャ（正常な Release）を作る。各テストは、これを壊して使う。
    function New-ReleaseFixture {
        param([string]$Tag = "v0.4.0", [hashtable]$Overrides = @{}, [string[]]$Omit = @(), [string[]]$Extra = @())

        $root = Join-Path $TestDrive "fx-$([guid]::NewGuid().ToString('N'))"
        $files = Join-Path $root "files"
        New-Item -ItemType Directory -Force $files | Out-Null
        $version = $Tag.TrimStart('v')

        $content = @{
            "arbor_x64.msix"         = "msix-bytes"
            "arbor.cer"              = "cer-bytes"
            "install.ps1"            = "install-script"
            "arbor.appinstaller"     = @"
<?xml version="1.0" encoding="utf-8"?>
<AppInstaller
    xmlns="http://schemas.microsoft.com/appx/appinstaller/2018"
    Uri="https://github.com/scottlz0310/arbor/releases/latest/download/arbor.appinstaller"
    Version="$version.0">
  <MainPackage
      Name="scottlz0310.arbor"
      Publisher="CN=scottlz0310"
      Version="$version.0"
      ProcessorArchitecture="x64"
      Uri="https://github.com/scottlz0310/arbor/releases/download/$Tag/arbor_x64.msix" />
</AppInstaller>
"@
            "arbor_${version}_aarch64.dmg"                   = "dmg"
            "arbor_aarch64.app.tar.gz"                       = "app-tar"
            "arbor_aarch64.app.tar.gz.sig"                   = "sig-mac"
            "arbor_${version}_amd64.AppImage"                = "appimage"
            "arbor_${version}_amd64.deb"                     = "deb"
            "arbor_${version}_amd64.AppImage.tar.gz"         = "appimage-tar"
            "arbor_${version}_amd64.AppImage.tar.gz.sig"     = "sig-linux"
        }
        $platforms = [ordered]@{
            "darwin-aarch64" = @{ url = "https://github.com/o/r/releases/download/$Tag/arbor_aarch64.app.tar.gz"; signature = "s" }
            "linux-x86_64"   = @{ url = "https://github.com/o/r/releases/download/$Tag/arbor_${version}_amd64.AppImage.tar.gz"; signature = "s" }
        }
        $content["latest.json"] = (@{ version = $version; notes = ""; pub_date = "2026-10-20T00:00:00Z"; platforms = $platforms } | ConvertTo-Json -Depth 5)

        # checksums-msix.txt は、4 つのファイルの checksum（LF）
        $sums = foreach ($name in "arbor_x64.msix", "arbor.appinstaller", "arbor.cer", "install.ps1") {
            $bytes = [Text.Encoding]::UTF8.GetBytes([string]$content[$name])
            $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData($bytes)).Replace("-", "").ToLowerInvariant()
            "$hash  $name"
        }
        $content["checksums-msix.txt"] = ($sums -join "`n") + "`n"

        foreach ($key in $Overrides.Keys) { $content[$key] = $Overrides[$key] }
        foreach ($name in $Omit) { $content.Remove($name) }
        foreach ($name in $Extra) { $content[$name] = "extra" }

        foreach ($name in $content.Keys) {
            [IO.File]::WriteAllBytes((Join-Path $files $name), [Text.Encoding]::UTF8.GetBytes([string]$content[$name]))
        }
        $names = @($content.Keys | Sort-Object)
        $assetsJson = @{ isDraft = $true; assets = @($names | ForEach-Object { @{ name = $_ } }) } | ConvertTo-Json -Depth 4 -Compress
        [IO.File]::WriteAllText((Join-Path $root "release.json"), $assetsJson)

        # 偽の gh: `gh release view <tag> --json ...` は release.json を返し、`gh release download <tag> --pattern P --dir D` は
        # files/ のファイルを D へ写す。FAKE_GH_FAIL=view のときは、view が失敗する。
        $ghDir = Join-Path $root "bin"
        New-Item -ItemType Directory -Force $ghDir | Out-Null
        $fake = @'
#!/usr/bin/env bash
fixture="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$1" == "release" && "$2" == "view" ]]; then
  if [[ "${FAKE_GH_FAIL:-}" == "view" ]]; then echo "release not found" >&2; exit 1; fi
  cat "$fixture/release.json"; exit 0
fi
if [[ "$1" == "release" && "$2" == "download" ]]; then
  pattern=""; dir=""
  shift 3
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "$fixture/files/$pattern" ]]; then cp "$fixture/files/$pattern" "$dir/$pattern"; exit 0; fi
  echo "no assets match $pattern" >&2; exit 1
fi
echo "unexpected gh call: $*" >&2; exit 99
'@
        [IO.File]::WriteAllText((Join-Path $ghDir "gh"), ($fake -replace "`r`n", "`n"))
        return [PSCustomObject]@{ Root = $root; BinDir = $ghDir }
    }

    function Invoke-Verify {
        param($Fixture, [string]$Tag = "v0.4.0", [hashtable]$Environment = @{})

        $oldPath = $env:PATH
        # bash の出力（UTF-8 の日本語）を、文字化けさせずに受け取る
        $oldEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        try {
            # 偽の gh を、PATH の先頭に置く。bash から見えるよう、実行ビットを付けた上で、POSIX 形式のパスで渡す
            $binPosix = (& $script:bash -c "cygpath -u '$($Fixture.BinDir)' 2>/dev/null || echo '$($Fixture.BinDir)'").Trim()
            & $script:bash -c "chmod +x '$binPosix/gh'" | Out-Null
            foreach ($key in $Environment.Keys) { Set-Item "Env:$key" $Environment[$key] }
            $verifyPosix = (& $script:bash -c "cygpath -u '$script:verifyScript' 2>/dev/null || echo '$script:verifyScript'").Trim()
            $output = & $script:bash -c "PATH='$binPosix':`"`$PATH`" bash '$verifyPosix' $Tag 2>&1"
            return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
        } finally {
            [Console]::OutputEncoding = $oldEncoding
            $env:PATH = $oldPath
            foreach ($key in $Environment.Keys) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
        }
    }
}

Describe "scripts/verify-release-assets.sh" -Skip:(-not ((Get-Command bash -ErrorAction SilentlyContinue) -and (Get-Command jq -ErrorAction SilentlyContinue))) {
    It "正常な Release（macOS / Linux / Windows の MSIX 一式）は、成功する" {
        $fixture = New-ReleaseFixture

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Be 0 -Because $result.Output
        $result.Output | Should -Match "検証に成功しました: v0.4.0"
    }

    It "必要な成果物が 1 つ欠けると、失敗する" -TestCases @(
        @{ Missing = "arbor_x64.msix" },
        @{ Missing = "arbor.appinstaller" },
        @{ Missing = "arbor.cer" },
        @{ Missing = "install.ps1" },
        @{ Missing = "checksums-msix.txt" },
        @{ Missing = "latest.json" },
        @{ Missing = "arbor_0.4.0_aarch64.dmg" },
        @{ Missing = "arbor_0.4.0_amd64.deb" },
        @{ Missing = "arbor_aarch64.app.tar.gz.sig" },
        @{ Missing = "arbor_0.4.0_amd64.AppImage.tar.gz.sig" }
    ) {
        param($Missing)
        $fixture = New-ReleaseFixture -Omit @($Missing)

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match "成果物がありません"
    }

    It "旧い Windows のインストーラ（msi / setup.exe）が混ざっていると、失敗する" -TestCases @(
        @{ Extra = "arbor_0.4.0_x64_en-US.msi" },
        @{ Extra = "arbor_0.4.0_x64-setup.exe" },
        @{ Extra = "arbor_0.4.0_x64_en-US.msi.zip.sig" }
    ) {
        param($Extra)
        $fixture = New-ReleaseFixture -Extra @($Extra)

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match "公開してはいけない成果物"
    }

    It "latest.json の不整合（版・プラットフォーム・URL）は、失敗する" -TestCases @(
        @{ Name = "版がタグと違う"; Json = { param($p) @{ version = "0.3.9"; platforms = $p } }; Message = "一致しません" },
        @{ Name = "Windows のエントリが残っている"; Json = { param($p) $p["windows-x86_64"] = @{ url = "https://x/arbor.msi.zip"; signature = "s" }; @{ version = "0.4.0"; platforms = $p } }; Message = "2 つではありません" },
        @{ Name = "プラットフォームが 1 つ足りない"; Json = { param($p) $p.Remove("linux-x86_64"); @{ version = "0.4.0"; platforms = $p } }; Message = "2 つではありません" },
        @{ Name = "URL が、Release に無い成果物を指す"; Json = { param($p) $p["darwin-aarch64"].url = "https://x/releases/download/v0.4.0/missing.tar.gz"; @{ version = "0.4.0"; platforms = $p } }; Message = "Release に無い成果物" }
    ) {
        param($Name, $Json, $Message)
        $platforms = [ordered]@{
            "darwin-aarch64" = @{ url = "https://x/releases/download/v0.4.0/arbor_aarch64.app.tar.gz"; signature = "s" }
            "linux-x86_64"   = @{ url = "https://x/releases/download/v0.4.0/arbor_0.4.0_amd64.AppImage.tar.gz"; signature = "s" }
        }
        $latest = (& $Json $platforms | ConvertTo-Json -Depth 5)
        $fixture = New-ReleaseFixture -Overrides @{ "latest.json" = $latest }

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0 -Because $Name
        $result.Output | Should -Match $Message
    }

    It "MSIX の checksum が一致しない（添付の間に壊れた）と、失敗する" {
        $fixture = New-ReleaseFixture
        [IO.File]::WriteAllText((Join-Path $fixture.Root "files/arbor_x64.msix"), "tampered")

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match "checksum が一致しません"
    }

    It "checksums-msix.txt が、4 つのファイルを挙げていないと、失敗する" {
        $fixture = New-ReleaseFixture
        $path = Join-Path $fixture.Root "files/checksums-msix.txt"
        $lines = (Get-Content -Raw $path) -split "`n" | Where-Object { $_ -and $_ -notmatch "install.ps1" }
        [IO.File]::WriteAllText($path, ($lines -join "`n") + "`n")

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match "記載がありません: install.ps1"
    }

    It ".appinstaller の不整合は、失敗する" -TestCases @(
        @{ Name = "版がタグと違う"; Replace = @("0.4.0.0", "0.3.9.0"); Message = "Version が" },
        @{ Name = "MainPackage の URI が別のタグを指す"; Replace = @("/releases/download/v0.4.0/", "/releases/download/v0.3.9/"); Message = "MainPackage の URI" },
        @{ Name = "Publisher が違う"; Replace = @('Publisher="CN=scottlz0310"', 'Publisher="CN=someone"'); Message = "Publisher" },
        @{ Name = "Name が違う"; Replace = @('Name="scottlz0310.arbor"', 'Name="other.app"'); Message = "Name" }
    ) {
        param($Name, $Replace, $Message)
        $fixture = New-ReleaseFixture
        # appinstaller を変えると checksum も変わるため、checksums-msix.txt を、変更後の内容で作り直す
        $filesDir = Join-Path $fixture.Root "files"
        $appinstaller = (Get-Content -Raw (Join-Path $filesDir "arbor.appinstaller")).Replace($Replace[0], $Replace[1])
        [IO.File]::WriteAllText((Join-Path $filesDir "arbor.appinstaller"), $appinstaller)
        $sums = foreach ($file in "arbor_x64.msix", "arbor.appinstaller", "arbor.cer", "install.ps1") {
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $filesDir $file)).Hash.ToLowerInvariant()
            "$hash  $file"
        }
        [IO.File]::WriteAllText((Join-Path $filesDir "checksums-msix.txt"), ($sums -join "`n") + "`n")

        $result = Invoke-Verify -Fixture $fixture

        $result.ExitCode | Should -Not -Be 0 -Because $Name
        $result.Output | Should -Match $Message
    }

    It "Release を読めない（draft が見えない権限など）と、失敗し、原因を示す" {
        $fixture = New-ReleaseFixture

        $result = Invoke-Verify -Fixture $fixture -Environment @{ FAKE_GH_FAIL = "view" }

        $result.ExitCode | Should -Not -Be 0
        $result.Output | Should -Match "Release を読めません"
    }

    It "タグの形式が不正なら、gh を呼ぶ前に、終了コード 2 で失敗する" -TestCases @(
        @{ Tag = "bad" }, @{ Tag = "0.4.0" }, @{ Tag = "v0.4" }, @{ Tag = "v0.4.0-rc.1" }
    ) {
        param($Tag)
        $fixture = New-ReleaseFixture

        $result = Invoke-Verify -Fixture $fixture -Tag $Tag

        $result.ExitCode | Should -Be 2
        $result.Output | Should -Match "v1.2.3 の形"
    }
}
