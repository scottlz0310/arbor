# Pester 5+ ではトップレベル変数は It から見えないため、AST 解析と関数定義の読み込みを BeforeAll で行う
BeforeAll {
    # New-SigningCertificate.ps1 は、SigningSecrets.ps1 を dot-source する。どちらの関数も読み込む。
    foreach ($name in "SigningSecrets.ps1", "New-SigningCertificate.ps1") {
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
    # SigningSecrets.ps1 の変数（シークレット名）は、関数だけの読み込みでは入らないので、ここで同じ値を定義する
    $ArborSigningSecretNames = @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")

    # 外部（証明書ストア・bw・gh）に触れず、各工程の呼び出しを記録する
    function New-TestHarness {
        param(
            [bool]$BitwardenUnlocked = $true,
            [bool]$BitwardenItemExists = $false,
            [bool]$BitwardenCreateFails = $false,
            [string[]]$ExistingSecrets = @(),
            [bool]$EnvironmentExists = $false,
            [bool]$EnvironmentCustomPolicies = $true,
            [string[]]$EnvironmentPolicies = @()
        )

        $state = [PSCustomObject]@{
            Calls             = [System.Collections.Generic.List[string]]::new()
            Password          = $null
            BitwardenItemJson = $null
            Secrets           = @{}
            SecretEnvironment = $null
            EnvironmentArgs   = $null
        }

        $certificateStep = {
            param([string]$Subject, [int]$ValidYears, [string]$Password, [string]$PfxPath, [string]$CerPath)
            $state.Calls.Add("certificate")
            $state.Password = $Password
            [IO.File]::WriteAllBytes($PfxPath, [byte[]](1, 2, 3, 4))
            [IO.File]::WriteAllBytes($CerPath, [byte[]](5, 6))
            return [PSCustomObject]@{ Thumbprint = "AABBCC"; NotAfter = [datetime]"2031-10-19" }
        }.GetNewClosure()

        $bitwardenStatusStep = {
            $state.Calls.Add("bw-status")
            return (@{ status = $(if ($BitwardenUnlocked) { "unlocked" } else { "locked" }) } | ConvertTo-Json -Compress)
        }.GetNewClosure()

        $bitwardenListStep = {
            param([string]$Name)
            $state.Calls.Add("bw-list")
            if ($BitwardenItemExists) { return (@(@{ name = $Name }) | ConvertTo-Json -Compress -AsArray) }
            return "[]"
        }.GetNewClosure()

        $bitwardenCreateStep = {
            param([string]$ItemJson)
            $state.Calls.Add("bw-create")
            if ($BitwardenCreateFails) { throw "bw create failed" }
            $state.BitwardenItemJson = $ItemJson
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
            $state.EnvironmentArgs = "$Environment/$Branch"
        }.GetNewClosure()

        $secretListStep = {
            param([string]$Repo, [string]$Environment)
            $state.Calls.Add("secret-list")
            return $ExistingSecrets
        }.GetNewClosure()

        $secretSetStep = {
            param([string]$Repo, [string]$Environment, [string]$Name, [string]$Value)
            $state.Calls.Add("secret-set:$Name")
            $state.SecretEnvironment = $Environment
            $state.Secrets[$Name] = $Value
        }.GetNewClosure()

        return [PSCustomObject]@{
            State = $state
            Args  = @{
                CertificateStep     = $certificateStep
                BitwardenStatusStep = $bitwardenStatusStep
                BitwardenListStep   = $bitwardenListStep
                BitwardenCreateStep = $bitwardenCreateStep
                EnvironmentStateStep = $environmentStateStep
                EnvironmentStep     = $environmentStep
                SecretListStep      = $secretListStep
                SecretSetStep       = $secretSetStep
            }
        }
    }
}

Describe "packaging/msix/New-SigningCertificate.ps1" {
    It "pfx / cer を BackupDir に書き、パスワードを Bitwarden に保存し、Environment のシークレットを登録する" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert"

        $result = Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs

        $result.PfxPath | Should -Be (Join-Path $backup "arbor-signing.pfx")
        Test-Path $result.CerPath | Should -BeTrue
        # 事前確認は、読み取りだけ。外部への書き込み（Environment の作成・登録）は、生成と Bitwarden への保存のあと、最後
        $harness.State.Calls | Should -Be @(
            "bw-status", "bw-list", "environment-state", "certificate", "bw-create",
            "environment", "secret-set:SIGNING_CERTIFICATE_BASE64", "secret-set:SIGNING_CERTIFICATE_PASSWORD"
        )
        $harness.State.EnvironmentArgs | Should -Be "msix-signing/main"
        $harness.State.SecretEnvironment | Should -Be "msix-signing"
        [Convert]::FromBase64String($harness.State.Secrets["SIGNING_CERTIFICATE_BASE64"]) | Should -Be ([byte[]](1, 2, 3, 4))
        $harness.State.Secrets["SIGNING_CERTIFICATE_PASSWORD"] | Should -Be $harness.State.Password
        ($harness.State.BitwardenItemJson | ConvertFrom-Json).notes | Should -Be $harness.State.Password
    }

    It "Environment の名前とブランチを指定できる" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-envname"

        Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register -Environment "other-env" -Branch "release" @stepArgs | Out-Null

        $harness.State.EnvironmentArgs | Should -Be "other-env/release"
        $harness.State.SecretEnvironment | Should -Be "other-env"
    }

    It "パスワードを出力に含めない" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-output"

        $output = & {
            Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs
        } *>&1 | Out-String

        $output | Should -Not -BeNullOrEmpty
        $output.Contains($harness.State.Password) | Should -BeFalse
    }

    It "事前確認の失敗では、証明書を作らず、シークレットも登録しない" -TestCases @(
        @{ Name = "既存の pfx（-Force なし）"; Message = "*既に存在します*"; Setup = { param($backup) New-Item -ItemType Directory -Force $backup | Out-Null; [IO.File]::WriteAllText((Join-Path $backup "arbor-signing.pfx"), "old") }; Harness = @{} },
        @{ Name = "Bitwarden が未解錠"; Message = "*解錠されていません*"; Setup = {}; Harness = @{ BitwardenUnlocked = $false } },
        @{ Name = "Bitwarden に同名の項目"; Message = "*同名の項目*"; Setup = {}; Harness = @{ BitwardenItemExists = $true } },
        @{ Name = "Environment に同名のシークレット"; Message = "*同名のシークレット*"; Setup = {}; Harness = @{ EnvironmentExists = $true; ExistingSecrets = @("SIGNING_CERTIFICATE_BASE64") } },
        @{ Name = "既存の Environment のデプロイ制限が想定と異なる（保護ブランチのみ）"; Message = "*想定*異なります*"; Setup = {}; Harness = @{ EnvironmentExists = $true; EnvironmentCustomPolicies = $false } },
        @{ Name = "想定外のデプロイのポリシー（別のブランチ）がある"; Message = "*想定外のデプロイのポリシー*"; Setup = {}; Harness = @{ EnvironmentExists = $true; EnvironmentPolicies = @("branch:main", "branch:dev") } }
    ) {
        param($Name, $Message, $Setup, $Harness)
        $harnessParams = $Harness
        $harness = New-TestHarness @harnessParams
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-precheck-$([guid]::NewGuid().ToString('N'))"
        & $Setup $backup

        { Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs } | Should -Throw $Message

        $harness.State.Calls | Should -Not -Contain "certificate"
        # 外部への書き込み（Environment の作成・更新、シークレットの登録）は、1 件も行わない
        $harness.State.Calls | Should -Not -Contain "environment"
        ($harness.State.Calls | Where-Object { $_ -like "secret-set:*" }) | Should -BeNullOrEmpty
    }

    It "-Force なら、既存の pfx と同名のシークレットを上書きできる" {
        $harness = New-TestHarness -EnvironmentExists $true -ExistingSecrets @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-force"
        New-Item -ItemType Directory -Force $backup | Out-Null
        [IO.File]::WriteAllText((Join-Path $backup "arbor-signing.pfx"), "old")

        Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register -Force @stepArgs | Out-Null

        $harness.State.Calls | Should -Contain "certificate"
        $harness.State.Secrets.Keys | Should -HaveCount 2
    }

    It "Bitwarden への保存に失敗したら、シークレットを登録しない" {
        $harness = New-TestHarness -BitwardenCreateFails $true
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-bw-fail"

        { Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs } | Should -Throw "*bw create failed*"

        ($harness.State.Calls | Where-Object { $_ -like "secret-set:*" }) | Should -BeNullOrEmpty
    }

    It "-SkipBitwarden なら Bitwarden に触れない。-Register なしなら GitHub に触れない" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-skip"

        Invoke-ArborSigningCertificateSetup -BackupDir $backup -SkipBitwarden @stepArgs | Out-Null

        $harness.State.Calls | Should -Be @("certificate")
    }
}
