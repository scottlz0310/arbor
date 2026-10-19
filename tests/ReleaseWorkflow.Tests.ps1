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
    It "ジョブが、draft → build-tauri・msix → attach-msix → publish-updater-manifest → verify → finalize の順に揃っている" {
        @($jobs.Keys) | Should -Be @("draft", "build-tauri", "msix", "attach-msix", "publish-updater-manifest", "verify", "finalize")
    }

    It "build-tauri は、macOS と Linux だけ（Windows は、msi / NSIS ではなく MSIX で配布する）" {
        $jobs["build-tauri"] | Should -Match 'platform: macos-latest'
        $jobs["build-tauri"] | Should -Match 'platform: ubuntu-latest'
        $jobs["build-tauri"] | Should -Not -Match 'windows-latest'
        $jobs["build-tauri"] | Should -Not -Match 'msvc'
    }

    It "msix は、package-msix.yml を呼び、draft のコミットとタグを渡す。Secrets は、渡さない（署名用の値は、Environment にある）" {
        $jobs["msix"] | Should -Match '(?m)^    uses: \./\.github/workflows/package-msix\.yml\s*$'
        $jobs["msix"] | Should -Match 'ref: \$\{\{ needs\.draft\.outputs\.target_sha \}\}'
        $jobs["msix"] | Should -Match 'tag: \$\{\{ needs\.draft\.outputs\.tag_name \}\}'
        $jobs["msix"] | Should -Not -Match 'secrets:'
        $jobs["msix"] | Should -Not -Match 'secrets\.'
    }

    It "attach-msix は、msix の後で、決まった 5 つのファイルだけを添付する" {
        Get-Needs "attach-msix" | Should -Contain "msix"
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
