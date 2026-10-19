# Register-SigningSecrets.ps1（バックアップからの復元）と、SigningSecrets.ps1 の Environment の整備を検査する。
# 外部（bw・gh・pfx の読み込み）は、差し込み点か、`gh` の関数で差し替える。
BeforeAll {
    foreach ($name in "SigningSecrets.ps1", "Register-SigningSecrets.ps1") {
        $scriptPath = (Resolve-Path "$PSScriptRoot/../packaging/msix/$name").Path
        $tokens = $null
        $parseErrors = $null
        $scriptAst = [System.Management.Automation.Language.Parser]::ParseFile(
            $scriptPath,
            [ref]$tokens,
            [ref]$parseErrors
        )

        if ($parseErrors.Count -gt 0) {
            throw "$name の構文解析に失敗しました: $($parseErrors -join '; ')"
        }

        $functionAsts = $scriptAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
            },
            $true
        )
        foreach ($functionAst in $functionAsts) {
            Invoke-Expression $functionAst.Extent.Text
        }
    }
    $ArborSigningSecretNames = @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")

    function New-RestoreHarness {
        param(
            [bool]$BitwardenUnlocked = $true,
            [string]$PfxThumbprint = "AABBCC",
            [string]$CerThumbprint = "AABBCC",
            [string[]]$ExistingSecrets = @(),
            [bool]$EnvironmentExists = $false,
            [bool]$EnvironmentCustomPolicies = $true,
            [string[]]$EnvironmentPolicies = @()
        )

        $state = [PSCustomObject]@{
            Calls             = [System.Collections.Generic.List[string]]::new()
            Secrets           = @{}
            SecretEnvironment = $null
            PasswordUsed      = $null
        }

        $statusStep = {
            $state.Calls.Add("bw-status")
            return (@{ status = $(if ($BitwardenUnlocked) { "unlocked" } else { "locked" }) } | ConvertTo-Json -Compress)
        }.GetNewClosure()
        $getStep = {
            param([string]$Name)
            $state.Calls.Add("bw-get")
            return (@{ name = $Name; notes = "the-password" } | ConvertTo-Json -Compress)
        }.GetNewClosure()
        $pfxStep = {
            param([string]$PfxPath, [string]$Password)
            $state.Calls.Add("pfx-open")
            $state.PasswordUsed = $Password
            return $PfxThumbprint
        }.GetNewClosure()
        $cerStep = {
            param([string]$CerPath)
            $state.Calls.Add("cer-read")
            return $CerThumbprint
        }.GetNewClosure()
        # 読み取りだけ（外部へ書き込まない）
        $environmentStateStep = {
            param([string]$Repo, [string]$Environment)
            $state.Calls.Add("environment-state")
            return [PSCustomObject]@{
                Exists         = $EnvironmentExists
                CustomPolicies = $EnvironmentCustomPolicies
                Policies       = $EnvironmentPolicies
                SecretNames    = $ExistingSecrets
            }
        }.GetNewClosure()
        # 外部への書き込み（Environment の作成・更新）
        $environmentStep = {
            param([string]$Repo, [string]$Environment, [string]$Branch, [Alias("State")]$EnvState)
            $state.Calls.Add("environment")
        }.GetNewClosure()
        $listStep = {
            param([string]$Repo, [string]$Environment)
            $state.Calls.Add("secret-list")
            return $ExistingSecrets
        }.GetNewClosure()
        $setStep = {
            param([string]$Repo, [string]$Environment, [string]$Name, [string]$Value)
            $state.Calls.Add("secret-set:$Name")
            $state.SecretEnvironment = $Environment
            $state.Secrets[$Name] = $Value
        }.GetNewClosure()

        return [PSCustomObject]@{
            State = $state
            Args  = @{
                BitwardenStatusStep = $statusStep
                BitwardenGetStep    = $getStep
                PfxThumbprintStep   = $pfxStep
                CerThumbprintStep   = $cerStep
                EnvironmentStateStep = $environmentStateStep
                EnvironmentStep     = $environmentStep
                SecretListStep      = $listStep
                SecretSetStep       = $setStep
            }
        }
    }

    function New-BackupDir {
        param([switch]$WithCer, [switch]$NoPfx)
        $dir = Join-Path $TestDrive "backup-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Force $dir | Out-Null
        if (-not $NoPfx) { [IO.File]::WriteAllBytes((Join-Path $dir "arbor-signing.pfx"), [byte[]](9, 8, 7)) }
        if ($WithCer) { [IO.File]::WriteAllBytes((Join-Path $dir "arbor.cer"), [byte[]](5, 6)) }
        return $dir
    }
}

Describe "packaging/msix/Register-SigningSecrets.ps1" {
    It "バックアップから、Bitwarden のパスワードで、Environment のシークレットを登録する" {
        $harness = New-RestoreHarness
        $stepArgs = $harness.Args
        $dir = New-BackupDir -WithCer

        $result = Invoke-ArborSigningSecretsRestore -BackupDir $dir @stepArgs

        $result.Thumbprint | Should -Be "AABBCC"
        # 開けること・Environment の衝突を、読み取りだけで確かめてから、最後に、Environment を整え、登録する
        $harness.State.Calls | Should -Be @(
            "bw-status", "bw-get", "pfx-open", "cer-read", "environment-state",
            "environment", "secret-set:SIGNING_CERTIFICATE_BASE64", "secret-set:SIGNING_CERTIFICATE_PASSWORD"
        )
        $harness.State.SecretEnvironment | Should -Be "msix-signing"
        [Convert]::FromBase64String($harness.State.Secrets["SIGNING_CERTIFICATE_BASE64"]) | Should -Be ([byte[]](9, 8, 7))
        $harness.State.Secrets["SIGNING_CERTIFICATE_PASSWORD"] | Should -Be "the-password"
    }

    It "パスワードを出力に含めない" {
        $harness = New-RestoreHarness
        $stepArgs = $harness.Args
        $dir = New-BackupDir

        $output = & { Invoke-ArborSigningSecretsRestore -BackupDir $dir @stepArgs } *>&1 | Out-String

        $output | Should -Not -BeNullOrEmpty
        $output.Contains("the-password") | Should -BeFalse
    }

    It "事前確認・検証の失敗では、Environment も作らず、シークレットも登録しない" -TestCases @(
        @{ Name = "pfx が無い"; Message = "*pfx がありません*"; Dir = { New-BackupDir -NoPfx }; Harness = @{} },
        @{ Name = "Bitwarden が未解錠"; Message = "*解錠されていません*"; Dir = { New-BackupDir }; Harness = @{ BitwardenUnlocked = $false } },
        @{ Name = "pfx と cer が別の証明書"; Message = "*一致しません*"; Dir = { New-BackupDir -WithCer }; Harness = @{ CerThumbprint = "DDEEFF" } },
        @{ Name = "同名のシークレットがある（-Force なし）"; Message = "*同名のシークレット*"; Dir = { New-BackupDir }; Harness = @{ EnvironmentExists = $true; ExistingSecrets = @("SIGNING_CERTIFICATE_PASSWORD") } },
        @{ Name = "既存の Environment のデプロイ制限が想定と異なる（保護ブランチのみ。-Force なし）"; Message = "*想定*異なります*"; Dir = { New-BackupDir }; Harness = @{ EnvironmentExists = $true; EnvironmentCustomPolicies = $false } },
        @{ Name = "想定外のデプロイのポリシー（別のブランチ）がある"; Message = "*想定外のデプロイのポリシー*"; Dir = { New-BackupDir }; Harness = @{ EnvironmentExists = $true; EnvironmentPolicies = @("branch:main", "tag:v*") } }
    ) {
        param($Name, $Message, $Dir, $Harness)
        $harnessParams = $Harness
        $harness = New-RestoreHarness @harnessParams
        $stepArgs = $harness.Args
        $dirPath = & $Dir

        { Invoke-ArborSigningSecretsRestore -BackupDir $dirPath @stepArgs } | Should -Throw $Message

        # 外部への書き込み（Environment の作成・更新、シークレットの登録）は、1 件も行わない
        $harness.State.Calls | Should -Not -Contain "environment"
        ($harness.State.Calls | Where-Object { $_ -like "secret-set:*" }) | Should -BeNullOrEmpty
    }

    It "pfx を開けない（パスワードが違う）なら、Environment を作る前に失敗する" {
        $harness = New-RestoreHarness
        $args2 = $harness.Args
        $args2.PfxThumbprintStep = { param($PfxPath, $Password) throw "pfx を、Bitwarden のパスワードで開けません" }
        $dir = New-BackupDir

        { Invoke-ArborSigningSecretsRestore -BackupDir $dir @args2 } | Should -Throw "*開けません*"

        $harness.State.Calls | Should -Not -Contain "environment"
    }

    It "-Force なら、同名のシークレットを上書きできる" {
        $harness = New-RestoreHarness -EnvironmentExists $true -ExistingSecrets @("SIGNING_CERTIFICATE_BASE64")
        $stepArgs = $harness.Args
        $dir = New-BackupDir

        Invoke-ArborSigningSecretsRestore -BackupDir $dir -Force @stepArgs | Out-Null

        $harness.State.Secrets.Keys | Should -HaveCount 2
    }

    It "-Force なら、デプロイ制限が想定と異なる既存の Environment を、書き換えられる（想定外のポリシーは、-Force でも消さない）" {
        $harness = New-RestoreHarness -EnvironmentExists $true -EnvironmentCustomPolicies $false
        $stepArgs = $harness.Args
        $dir = New-BackupDir

        Invoke-ArborSigningSecretsRestore -BackupDir $dir -Force @stepArgs | Out-Null
        $harness.State.Calls | Should -Contain "environment"

        $harness2 = New-RestoreHarness -EnvironmentExists $true -EnvironmentPolicies @("branch:main", "branch:dev")
        $stepArgs2 = $harness2.Args
        { Invoke-ArborSigningSecretsRestore -BackupDir $dir -Force @stepArgs2 } | Should -Throw "*想定外のデプロイのポリシー*"
        $harness2.State.Calls | Should -Not -Contain "environment"
    }
}

Describe "Assert-ArborSigningEnvironmentPlan（読み取りだけで衝突を判定する）" {
    BeforeAll {
        function New-State {
            param([bool]$Exists = $true, [bool]$Custom = $true, [string[]]$Policies = @("branch:main"), [string[]]$Secrets = @())
            return [PSCustomObject]@{ Exists = $Exists; CustomPolicies = $Custom; Policies = $Policies; SecretNames = $Secrets }
        }
    }

    It "衝突が無ければ通る（Environment が無い、想定どおりの Environment）" -TestCases @(
        @{ State = { New-State -Exists $false -Custom $false -Policies @() } },
        @{ State = { New-State } },
        @{ State = { New-State -Policies @() } }
    ) {
        param($State)
        { Assert-ArborSigningEnvironmentPlan -Environment "msix-signing" -Branch "main" -State (& $State) } | Should -Not -Throw
    }

    It "衝突があれば、失敗する" -TestCases @(
        @{ Name = "デプロイ制限が想定と異なる（-Force なし）"; State = { New-State -Custom $false -Policies @() }; Message = "*想定*異なります*"; Force = $false },
        @{ Name = "想定外のブランチのポリシー（-Force でも）"; State = { New-State -Policies @("branch:main", "branch:dev") }; Message = "*想定外のデプロイのポリシー*"; Force = $true },
        @{ Name = "想定外のタグのポリシー"; State = { New-State -Policies @("tag:v*") }; Message = "*想定外のデプロイのポリシー*"; Force = $false },
        @{ Name = "同名のシークレット（-Force なし）"; State = { New-State -Secrets @("SIGNING_CERTIFICATE_BASE64") }; Message = "*同名のシークレット*"; Force = $false }
    ) {
        param($Name, $State, $Message, $Force)
        { Assert-ArborSigningEnvironmentPlan -Environment "msix-signing" -Branch "main" -State (& $State) -Force:$Force } | Should -Throw $Message
    }

    It "-Force なら、同名のシークレットと、想定と異なるデプロイ制限は、上書きしてよい" {
        $state = New-State -Custom $false -Policies @() -Secrets @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")
        { Assert-ArborSigningEnvironmentPlan -Environment "msix-signing" -Branch "main" -State $state -Force } | Should -Not -Throw
    }
}

# `gh` を、関数で差し替える（関数は、外部コマンドより先に解決される）。引数と、標準入力で渡された本文を記録する。
Describe "Environment の状態の取得と整備（gh api）" {
    BeforeEach {
        $script:ghCalls = [System.Collections.Generic.List[string]]::new()
        $script:ghBodies = [System.Collections.Generic.List[string]]::new()
        $script:envJson = $null          # $null = 404（Environment が無い）
        $script:policies = @()
        $script:secretNames = @()
        $script:putFails = $false
        $script:getFails = $false
        function global:gh {
            $argsText = $args -join " "
            $script:ghCalls.Add($argsText)
            $body = @($input) -join ""
            if ($body) { $script:ghBodies.Add($body) }
            $global:LASTEXITCODE = 0
            if ($argsText -match "-X PUT") {
                if ($script:putFails) { $global:LASTEXITCODE = 1 }
                return
            }
            if ($argsText -match "-X POST") { return }
            if ($argsText -match "^api repos/o/r/environments/msix-signing/deployment-branch-policies") { return $script:policies }
            if ($argsText -match "^api repos/o/r/environments/msix-signing$") {
                if ($script:getFails) { $global:LASTEXITCODE = 1; return "gh: Forbidden (HTTP 403)" }
                if ($null -eq $script:envJson) { $global:LASTEXITCODE = 1; return "gh: Not Found (HTTP 404)" }
                return $script:envJson
            }
            if ($argsText -match "^secret list") { return $script:secretNames }
        }
    }

    AfterEach {
        Remove-Item Function:\global:gh -ErrorAction SilentlyContinue
    }

    Context "Get-ArborSigningEnvironmentState（読み取りだけ）" {
        It "Environment が無ければ（404）、Exists = false。書き込まない" {
            $state = Get-ArborSigningEnvironmentState -Repo "o/r" -Environment "msix-signing"

            $state.Exists | Should -BeFalse
            ($script:ghCalls | Where-Object { $_ -match "-X (PUT|POST|DELETE)" }) | Should -BeNullOrEmpty
        }

        It "カスタムのポリシーの Environment の、ポリシーとシークレットを読む" {
            $script:envJson = '{"name":"msix-signing","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
            $script:policies = @("branch:main")
            $script:secretNames = @("SIGNING_CERTIFICATE_BASE64")

            $state = Get-ArborSigningEnvironmentState -Repo "o/r" -Environment "msix-signing"

            $state.Exists | Should -BeTrue
            $state.CustomPolicies | Should -BeTrue
            $state.Policies | Should -Be @("branch:main")
            $state.SecretNames | Should -Be @("SIGNING_CERTIFICATE_BASE64")
            ($script:ghCalls | Where-Object { $_ -match "-X (PUT|POST|DELETE)" }) | Should -BeNullOrEmpty
        }

        It "保護ブランチのみ（カスタムでない）の Environment は、CustomPolicies = false" {
            $script:envJson = '{"name":"msix-signing","deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}'

            $state = Get-ArborSigningEnvironmentState -Repo "o/r" -Environment "msix-signing"

            $state.Exists | Should -BeTrue
            $state.CustomPolicies | Should -BeFalse
            $state.Policies | Should -HaveCount 0
        }

        It "404 以外のエラー（権限不足など）は、無いものとして扱わず、失敗する" {
            $script:getFails = $true

            { Get-ArborSigningEnvironmentState -Repo "o/r" -Environment "msix-signing" } | Should -Throw "*取得できません*"
        }
    }

    Context "Initialize-ArborSigningEnvironment（書き込み）" {
        It "Environment が無ければ、デプロイできるブランチを限定して作り、main を登録する" {
            $state = [PSCustomObject]@{ Exists = $false; CustomPolicies = $false; Policies = @(); SecretNames = @() }

            Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" -State $state

            $script:ghCalls | Should -Contain "api -X PUT repos/o/r/environments/msix-signing --input - --silent"
            ($script:ghBodies | Where-Object { $_ -match '"custom_branch_policies":true' -and $_ -match '"protected_branches":false' }) | Should -Not -BeNullOrEmpty
            ($script:ghCalls | Where-Object { $_ -match "-X POST repos/o/r/environments/msix-signing/deployment-branch-policies" }) | Should -HaveCount 1
            ($script:ghBodies | Where-Object { $_ -eq '{"name":"main","type":"branch"}' }) | Should -HaveCount 1
        }

        It "想定どおりの Environment（カスタム、main 登録済み）には、何も書き込まない（何度実行しても同じ）" {
            $state = [PSCustomObject]@{ Exists = $true; CustomPolicies = $true; Policies = @("branch:main"); SecretNames = @() }

            Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" -State $state

            ($script:ghCalls | Where-Object { $_ -match "-X (PUT|POST|DELETE)" }) | Should -BeNullOrEmpty
        }

        It "カスタムで、main が未登録なら、main だけを登録する（Environment は更新しない）" {
            $state = [PSCustomObject]@{ Exists = $true; CustomPolicies = $true; Policies = @(); SecretNames = @() }

            Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" -State $state

            ($script:ghCalls | Where-Object { $_ -match "-X PUT" }) | Should -BeNullOrEmpty
            ($script:ghCalls | Where-Object { $_ -match "-X POST" }) | Should -HaveCount 1
        }

        It "Environment を作れなければ（権限不足など）、失敗する" {
            $script:putFails = $true
            $state = [PSCustomObject]@{ Exists = $false; CustomPolicies = $false; Policies = @(); SecretNames = @() }

            { Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" -State $state } | Should -Throw "*作れません*"
        }
    }
}
