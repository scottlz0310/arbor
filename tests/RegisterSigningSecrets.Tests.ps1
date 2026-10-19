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
            [string[]]$ExistingSecrets = @()
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
        $environmentStep = {
            param([string]$Repo, [string]$Environment, [string]$Branch)
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
        # 開けることを確かめてから、Environment を整え、登録する
        $harness.State.Calls | Should -Be @(
            "bw-status", "bw-get", "pfx-open", "cer-read", "environment", "secret-list",
            "secret-set:SIGNING_CERTIFICATE_BASE64", "secret-set:SIGNING_CERTIFICATE_PASSWORD"
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
        @{ Name = "同名のシークレットがある（-Force なし）"; Message = "*同名のシークレット*"; Dir = { New-BackupDir }; Harness = @{ ExistingSecrets = @("SIGNING_CERTIFICATE_PASSWORD") } }
    ) {
        param($Name, $Message, $Dir, $Harness)
        $harnessParams = $Harness
        $harness = New-RestoreHarness @harnessParams
        $stepArgs = $harness.Args
        $dirPath = & $Dir

        { Invoke-ArborSigningSecretsRestore -BackupDir $dirPath @stepArgs } | Should -Throw $Message

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
        $harness = New-RestoreHarness -ExistingSecrets @("SIGNING_CERTIFICATE_BASE64")
        $stepArgs = $harness.Args
        $dir = New-BackupDir

        Invoke-ArborSigningSecretsRestore -BackupDir $dir -Force @stepArgs | Out-Null

        $harness.State.Secrets.Keys | Should -HaveCount 2
    }
}

# `gh` を、関数で差し替える（関数は、外部コマンドより先に解決される）。引数と、標準入力で渡された本文を記録する。
Describe "Initialize-ArborSigningEnvironment（gh api）" {
    BeforeEach {
        $script:ghCalls = [System.Collections.Generic.List[string]]::new()
        $script:ghBodies = [System.Collections.Generic.List[string]]::new()
        $script:policies = @()
        $script:putFails = $false
        function global:gh {
            $argsText = $args -join " "
            $script:ghCalls.Add($argsText)
            $body = @($input) -join ""
            if ($body) { $script:ghBodies.Add($body) }
            if ($argsText -match "-X PUT") {
                $global:LASTEXITCODE = if ($script:putFails) { 1 } else { 0 }
                return
            }
            if ($argsText -match "deployment-branch-policies" -and $argsText -notmatch "-X POST") {
                $global:LASTEXITCODE = 0
                return $script:policies
            }
            $global:LASTEXITCODE = 0
        }
    }

    AfterEach {
        Remove-Item Function:\global:gh -ErrorAction SilentlyContinue
    }

    It "Environment を、デプロイできるブランチを限定して作り、main を登録する" {
        Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main"

        $script:ghCalls | Should -Contain "api -X PUT repos/o/r/environments/msix-signing --input - --silent"
        ($script:ghBodies | Where-Object { $_ -match '"custom_branch_policies":true' -and $_ -match '"protected_branches":false' }) | Should -Not -BeNullOrEmpty
        ($script:ghCalls | Where-Object { $_ -match "-X POST repos/o/r/environments/msix-signing/deployment-branch-policies" }) | Should -HaveCount 1
        ($script:ghBodies | Where-Object { $_ -eq '{"name":"main","type":"branch"}' }) | Should -HaveCount 1
    }

    It "main が登録済みなら、もう一度登録しない（何度実行しても同じ）" {
        $script:policies = @("branch:main")

        Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main"

        ($script:ghCalls | Where-Object { $_ -match "-X POST" }) | Should -BeNullOrEmpty
    }

    It "想定外のポリシー（別のブランチ・タグ）があれば、黙って消さず、失敗する" -TestCases @(
        @{ Existing = @("branch:main", "branch:dev") },
        @{ Existing = @("tag:v*") }
    ) {
        param($Existing)
        $script:policies = $Existing

        { Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" } | Should -Throw "*想定外*"

        ($script:ghCalls | Where-Object { $_ -match "-X POST|-X DELETE" }) | Should -BeNullOrEmpty
    }

    It "Environment を作れなければ（権限不足など）、失敗する" {
        $script:putFails = $true

        { Initialize-ArborSigningEnvironment -Repo "o/r" -Environment "msix-signing" -Branch "main" } | Should -Throw "*作れません*"
    }
}
