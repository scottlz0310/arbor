# .github/workflows/package-msix.yml が、署名用の Secrets を、署名するステップだけに展開することを検査する。
# 同一リポジトリの PR では、Secrets が使える。署名しない PR のステップに展開すると、PR 側のスクリプト
# （Build-Msix.ps1 や、その子プロセス）から、署名用のパスワードを読み取れてしまう。
BeforeAll {
    $workflowPath = (Resolve-Path "$PSScriptRoot/../.github/workflows/package-msix.yml").Path
    $lines = Get-Content -LiteralPath $workflowPath

    # `steps:` より前（トリガー、ジョブの env など）が header。`steps:` より後は、「      - 」で始まる行から、
    # 次の同じ行の直前までを、1 つのステップとして切り出す（トリガーの paths の「      - 」と区別するため）。
    $stepsLine = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^    steps:\s*$') { $stepsLine = $i; break }
    }
    if ($stepsLine -eq 0) { throw "steps: が見つかりません" }
    $header = ($lines[0..$stepsLine]) -join "`n"

    $steps = [System.Collections.Generic.List[string]]::new()
    $current = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines[($stepsLine + 1)..($lines.Count - 1)]) {
        if ($line -match '^      - ' -and $current.Count -gt 0) {
            $steps.Add($current -join "`n")
            $current = [System.Collections.Generic.List[string]]::new()
        }
        $current.Add($line)
    }
    $steps.Add($current -join "`n")

    $secretPattern = 'secrets\.SIGNING_CERTIFICATE'
}

Describe ".github/workflows/package-msix.yml の Secrets の扱い" {
    It "ジョブの env・トリガーなど、ステップの外には、署名用の Secrets を展開しない" {
        $header | Should -Not -Match $secretPattern
    }

    It "署名用の Secrets を展開するステップは、すべて SIGN == 'true' のときだけ動く" {
        $using = @($steps | Where-Object { $_ -match $secretPattern })
        $using.Count | Should -BeGreaterThan 0 -Because "署名のステップが無いと、このテストが意味を持たない"
        foreach ($step in $using) {
            $step | Should -Match '(?m)^\s+if: \$\{\{ env\.SIGN == ''true'' \}\}\s*$'
        }
    }

    It "署名しない（SIGN != 'true'）ステップには、署名用の Secrets を展開しない" {
        $unsigned = @($steps | Where-Object { $_ -match 'env\.SIGN != ''true''' })
        $unsigned.Count | Should -BeGreaterThan 0
        foreach ($step in $unsigned) {
            $step | Should -Not -Match $secretPattern
        }
    }

    It "PR では署名しない（SIGN は pull_request のとき false）" {
        $header | Should -Match 'SIGN: \$\{\{ github\.event_name != ''pull_request'' \}\}'
    }
}
