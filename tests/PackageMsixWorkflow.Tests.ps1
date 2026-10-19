# .github/workflows/package-msix.yml が、署名用の Secrets を、Environment（main のみ）の署名ジョブだけに渡すことを検査する。
# 同一リポジトリの PR は、ワークフロー自体を書き換えて、リポジトリの Secrets を読める。だから、署名用の Secrets は、
# リポジトリの Secrets ではなく、Environment のシークレットに置き、署名のジョブ（environment あり）を PR では動かさず、
# PR のジョブ（environment なし）には、署名用の Secrets を展開しない。
BeforeAll {
    $workflowPath = (Resolve-Path "$PSScriptRoot/../.github/workflows/package-msix.yml").Path
    $lines = Get-Content -LiteralPath $workflowPath

    # `jobs:` より前（トリガー、permissions など）が header。`jobs:` より後は、2 スペースで始まるキーごとに、ジョブを切り出す。
    $jobsLine = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^jobs:\s*$') { $jobsLine = $i; break }
    }
    if ($jobsLine -eq 0) { throw "jobs: が見つかりません" }
    $header = ($lines[0..$jobsLine]) -join "`n"

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

    # 「${{ secrets.X }}」という式の参照だけを数える（コメント中の語、ファイル名の一部に反応しない）
    $secretExpression = '\$\{\{\s*secrets\.'
    $signingSecret = '\$\{\{\s*secrets\.SIGNING_CERTIFICATE'
    $environmentName = 'msix-signing'
}

Describe ".github/workflows/package-msix.yml の Secrets の扱い" {
    It "ジョブが、期待どおりに分かれている（build / package-unsigned / package-signed）" {
        @($jobs.Keys) | Should -Be @("build", "package-unsigned", "package-signed")
    }

    It "トリガー・permissions など、ジョブの外には、Secrets を展開しない" {
        $header | Should -Not -Match $secretExpression
    }

    It "pull_request_target を使わない（PR の差分のコードに、Secrets を渡す経路を作らない）" {
        $header | Should -Not -Match 'pull_request_target'
    }

    It "再利用ワークフロー（workflow_call）にしない（Environment のシークレットが secrets に渡らないため。v0.4.0 で失敗した）" {
        # トリガーのキー（コメント中の語ではなく）
        $header | Should -Not -Match '(?m)^\s+workflow_call:'
    }

    It "署名用の Secrets を展開するジョブは、Environment を持ち、PR では動かず、直接のジョブ（uses ではなく、steps）である" {
        $using = @($jobs.Keys | Where-Object { $jobs[$_] -match $signingSecret })
        $using.Count | Should -BeGreaterThan 0 -Because "署名のジョブが無いと、このテストが意味を持たない"
        foreach ($name in $using) {
            $jobs[$name] | Should -Not -Match '(?m)^    uses:' -Because "$name は、再利用ワークフローの呼び出しではなく、直接のジョブ"
            $jobs[$name] | Should -Match '(?m)^    runs-on:' -Because "$name は、直接のジョブ"
            $jobs[$name] | Should -Match "(?m)^    environment: $environmentName\s*$" -Because "$name は、Environment を持つ"
            $jobs[$name] | Should -Match '(?m)^    if: \$\{\{ github\.event_name != ''pull_request'' \}\}\s*$' -Because "$name は、PR では動かさない"
        }
    }

    It "Environment を持たないジョブには、Secrets を展開しない（build・PR の未署名のジョブ）" {
        $noEnvironment = @($jobs.Keys | Where-Object { $jobs[$_] -notmatch '(?m)^    environment:' })
        $noEnvironment.Count | Should -BeGreaterThan 0
        foreach ($name in $noEnvironment) {
            $jobs[$name] | Should -Not -Match $secretExpression -Because "$name は、PR でも動くため"
        }
    }

    It "PR で動くジョブは、Environment を持たない" {
        $pr = @($jobs.Keys | Where-Object { $jobs[$_] -notmatch "(?m)^    if: .*github\.event_name != 'pull_request'" })
        foreach ($name in $pr) {
            $jobs[$name] | Should -Not -Match '(?m)^    environment:' -Because "$name は、PR で動く。Environment は main に限定しているため、PR では動けない"
        }
    }

    It "ワークフローの Environment の名前が、登録用のスクリプトの既定値と一致する" -TestCases @(
        @{ Script = "New-SigningCertificate.ps1" },
        @{ Script = "Register-SigningSecrets.ps1" }
    ) {
        param($Script)
        $text = Get-Content -Raw -LiteralPath (Resolve-Path "$PSScriptRoot/../packaging/msix/$Script")
        $text | Should -Match "\[string\]\`$Environment = ""$environmentName"""
    }
}
