# .github/workflows/release.yml の構造を検査する。release.yml は、リリース準備 PR のマージでしか動かないため、
# 壊れても、次のリリースまで気づけない（v0.3.0 の公開で、権限の誤りが、公開の直前に見つかった）。
# 壊れやすい依存関係と、Windows の配布（MSIX だけ）の取り決めを、ここで固定する。
BeforeAll {
    $workflowPath = (Resolve-Path "$PSScriptRoot/../.github/workflows/release.yml").Path
    $lines = Get-Content -LiteralPath $workflowPath

    $jobsLine = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^jobs:\s*$') { $jobsLine = $i; break }
    }
    if ($jobsLine -eq 0) { throw "jobs: が見つかりません" }

    $jobs = [ordered]@{}
    $currentName = $null
    $current = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines[($jobsLine + 1)..($lines.Count - 1)]) {
        if ($line -match '^  ([A-Za-z0-9_-]+):\s*$') {
            if ($currentName) { $jobs[$currentName] = $current -join "`n" }
            $currentName = $Matches[1]
            $current = [System.Collections.Generic.List[string]]::new()
        }
        $current.Add($line)
    }
    if ($currentName) { $jobs[$currentName] = $current -join "`n" }

    function Get-Needs {
        param([string]$Job)
        $text = $jobs[$Job]
        if ($text -match '(?m)^    needs: \[([^\]]*)\]') { return @($Matches[1] -split ',' | ForEach-Object { $_.Trim() }) }
        if ($text -match '(?m)^    needs: (\S+)\s*$') { return @($Matches[1]) }
        return @()
    }
}

Describe ".github/workflows/release.yml" {
    It "ジョブが、draft → build-tauri・msix-build → msix-sign → attach-msix → publish-updater-manifest → verify → finalize の順に揃っている" {
        @($jobs.Keys) | Should -Be @("draft", "build-tauri", "msix-build", "msix-sign", "attach-msix", "publish-updater-manifest", "verify", "finalize")
    }

    It "build-tauri は、macOS と Linux だけ（Windows は、msi / NSIS ではなく MSIX で配布する）" {
        $jobs["build-tauri"] | Should -Match 'platform: macos-latest'
        $jobs["build-tauri"] | Should -Match 'platform: ubuntu-latest'
        $jobs["build-tauri"] | Should -Not -Match 'windows-latest'
        $jobs["build-tauri"] | Should -Not -Match 'msvc'
    }

    It "msix-build は、build-exe.yml（再利用ワークフロー）を呼び、draft のコミットを渡す。Secrets は、渡さない" {
        $jobs["msix-build"] | Should -Match '(?m)^    uses: \./\.github/workflows/build-exe\.yml\s*$'
        $jobs["msix-build"] | Should -Match 'ref: \$\{\{ needs\.draft\.outputs\.target_sha \}\}'
        $jobs["msix-build"] | Should -Not -Match 'secrets'
    }

    It "msix-sign は、再利用ワークフローではなく、直接のジョブで、Environment msix-signing を持ち、draft のコミットとタグで署名する" {
        # 再利用ワークフローの中では、Environment のシークレットが secrets に渡らない（v0.4.0 のリリースで、実際に失敗した）
        $jobs["msix-sign"] | Should -Not -Match '(?m)^    uses:'
        $jobs["msix-sign"] | Should -Match '(?m)^    runs-on: windows-latest\s*$'
        $jobs["msix-sign"] | Should -Match '(?m)^    environment: msix-signing\s*$'
        Get-Needs "msix-sign" | Should -Contain "msix-build"
        $jobs["msix-sign"] | Should -Match 'ref: \$\{\{ needs\.draft\.outputs\.target_sha \}\}'
        $jobs["msix-sign"] | Should -Match '(?m)^      - uses: \./\.github/actions/package-msix-signed\s*$'
        $jobs["msix-sign"] | Should -Match 'tag: \$\{\{ needs\.draft\.outputs\.tag_name \}\}'
        $jobs["msix-sign"] | Should -Match 'pfx-base64: \$\{\{ secrets\.SIGNING_CERTIFICATE_BASE64 \}\}'
        $jobs["msix-sign"] | Should -Match 'pfx-password: \$\{\{ secrets\.SIGNING_CERTIFICATE_PASSWORD \}\}'
    }

    It "attach-msix は、msix-sign の後で、決まった 5 つのファイルだけを添付する" {
        Get-Needs "attach-msix" | Should -Contain "msix-sign"
        foreach ($name in "arbor_x64.msix", "arbor.appinstaller", "arbor.cer", "install.ps1", "checksums-msix.txt") {
            $jobs["attach-msix"] | Should -Match ([regex]::Escape($name))
        }
        $jobs["attach-msix"] | Should -Match '(?m)^      contents: write\s*$' -Because "draft の Release への添付には、write が要る"
    }

    It "verify は、macOS / Linux の添付（updater の manifest を含む）と、MSIX の添付の、両方の後に動く" {
        $needs = Get-Needs "verify"
        $needs | Should -Contain "publish-updater-manifest"
        $needs | Should -Contain "attach-msix"
        $jobs["verify"] | Should -Match '(?m)^      contents: write\s*$' -Because "draft の Release を読むには、write が要る（v0.3.0 で、実際に失敗した）"
    }

    It "finalize は、verify が成功したときだけ動く" {
        $jobs["finalize"] | Should -Match "needs\.verify\.result == 'success'"
    }

    It "updater の manifest に、Windows のエントリを含めない（Windows は、.appinstaller で更新する）" {
        $jobs["publish-updater-manifest"] | Should -Not -Match 'windows-x86_64'
        $jobs["publish-updater-manifest"] | Should -Match 'darwin-aarch64'
        $jobs["publish-updater-manifest"] | Should -Match 'linux-x86_64'
    }
}
