# 全ワークフローと複合アクションを横断して、署名用の Secrets の扱いを検査する。
#
# 教訓（v0.4.0 のリリース）: 署名のジョブを、再利用ワークフロー（workflow_call）にすると、Environment に紐づいたのに、
# Environment のシークレットが `secrets` に渡らず、空になった（直接実行の workflow_dispatch では、取れていた）。
# 再利用ワークフローの外（呼び出し元のワークフローの、直接のジョブ）で、署名用の Secrets を使う。
# release.yml は、リリース準備 PR のマージでしか動かず、この種の不具合は、リリースの本番まで気づけない。
BeforeAll {
    $repoRoot = (Resolve-Path "$PSScriptRoot/..").Path
    $workflowFiles = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot ".github/workflows") -Filter *.yml)
    $actionFiles = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot ".github/actions") -Recurse -Filter action.yml -ErrorAction SilentlyContinue)

    $signingSecret = '\$\{\{\s*secrets\.SIGNING_CERTIFICATE'
    $environmentName = 'msix-signing'

    # ワークフローを、ヘッダー（jobs: より前）と、ジョブごとの本文に分ける
    function Split-Workflow {
        param([string]$Path)
        $lines = Get-Content -LiteralPath $Path
        $jobsLine = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^jobs:\s*$') { $jobsLine = $i; break }
        }
        if ($jobsLine -lt 0) { return [PSCustomObject]@{ Header = ($lines -join "`n"); Jobs = [ordered]@{} } }
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
        return [PSCustomObject]@{ Header = ($lines[0..$jobsLine] -join "`n"); Jobs = $jobs }
    }

    $parsed = @{}
    foreach ($file in $workflowFiles) { $parsed[$file.Name] = Split-Workflow -Path $file.FullName }
}

Describe "ワークフロー全体の、署名用の Secrets の扱い" {
    It "検査の対象が、空でない（ワークフローと複合アクションを、見つけている）" {
        $workflowFiles.Count | Should -BeGreaterThan 3
        $actionFiles.Count | Should -BeGreaterThan 0
    }

    It "再利用ワークフロー（workflow_call）は、署名用の Secrets を参照せず、environment: msix-signing も使わない" {
        $reusable = @($workflowFiles | Where-Object { $parsed[$_.Name].Header -match '(?m)^\s+workflow_call:' })
        $reusable.Count | Should -BeGreaterThan 0 -Because "build-exe.yml・verify-release.yml が該当する"
        foreach ($file in $reusable) {
            $text = Get-Content -Raw -LiteralPath $file.FullName
            $text | Should -Not -Match $signingSecret -Because "$($file.Name) は再利用ワークフロー。Environment のシークレットは secrets に渡らず、空になる"
            $text | Should -Not -Match "(?m)^\s+environment: $environmentName" -Because "$($file.Name) は再利用ワークフロー。署名のジョブを、呼び出し元の直接のジョブにする"
        }
    }

    It "署名用の Secrets を参照するジョブは、どのワークフローでも、environment: msix-signing を持ち、直接のジョブである" {
        $found = 0
        foreach ($file in $workflowFiles) {
            foreach ($jobName in $parsed[$file.Name].Jobs.Keys) {
                $body = $parsed[$file.Name].Jobs[$jobName]
                if ($body -notmatch $signingSecret) { continue }
                $found++
                $body | Should -Match "(?m)^    environment: $environmentName\s*$" -Because "$($file.Name) の $jobName"
                $body | Should -Not -Match '(?m)^    uses:' -Because "$($file.Name) の $jobName は、直接のジョブ"
                $body | Should -Match '(?m)^    runs-on:' -Because "$($file.Name) の $jobName は、直接のジョブ"
            }
        }
        $found | Should -BeGreaterThan 1 -Because "package-msix.yml と release.yml の、署名のジョブ"
    }

    It "ジョブの外（トリガー・permissions・env）には、署名用の Secrets を展開しない" {
        foreach ($file in $workflowFiles) {
            $parsed[$file.Name].Header | Should -Not -Match $signingSecret -Because $file.Name
        }
    }

    It "複合アクションは、secrets を直接参照しない（複合アクションでは、secrets が使えない。入力で受け取る）" {
        foreach ($file in $actionFiles) {
            (Get-Content -Raw -LiteralPath $file.FullName) | Should -Not -Match '\$\{\{\s*secrets\.' -Because $file.FullName
        }
    }

    It "署名の複合アクション（package-msix-signed）を使うジョブは、environment: msix-signing を持ち、直接のジョブである" {
        $using = 0
        foreach ($file in $workflowFiles) {
            foreach ($jobName in $parsed[$file.Name].Jobs.Keys) {
                $body = $parsed[$file.Name].Jobs[$jobName]
                if ($body -notmatch 'uses: \./\.github/actions/package-msix-signed') { continue }
                $using++
                $body | Should -Match "(?m)^    environment: $environmentName\s*$" -Because "$($file.Name) の $jobName"
                $body | Should -Not -Match '(?m)^    uses:' -Because "$($file.Name) の $jobName は、直接のジョブ"
                $body | Should -Match 'pfx-base64: \$\{\{ secrets\.SIGNING_CERTIFICATE_BASE64 \}\}'
                $body | Should -Match 'pfx-password: \$\{\{ secrets\.SIGNING_CERTIFICATE_PASSWORD \}\}'
            }
        }
        $using | Should -BeGreaterThan 1 -Because "package-msix.yml と release.yml"
    }
}
