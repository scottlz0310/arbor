# Pester 5+ ではトップレベル変数は It から見えないため、AST 解析と関数定義の読み込みを BeforeAll で行う
BeforeAll {
    $scriptPath = (Resolve-Path "$PSScriptRoot/../packaging/msix/New-SigningCertificate.ps1").Path
    $tokens = $null
    $parseErrors = $null
    $scriptAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $scriptPath,
        [ref]$tokens,
        [ref]$parseErrors
    )

    if ($parseErrors.Count -gt 0) {
        throw "New-SigningCertificate.ps1 の構文解析に失敗しました: $($parseErrors -join '; ')"
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

    # 外部（証明書ストア・bw・gh）に触れず、各工程の呼び出しを記録する
    function New-TestHarness {
        param(
            [bool]$BitwardenUnlocked = $true,
            [bool]$BitwardenItemExists = $false,
            [bool]$BitwardenCreateFails = $false,
            [string[]]$ExistingSecrets = @()
        )

        $state = [PSCustomObject]@{
            Calls             = [System.Collections.Generic.List[string]]::new()
            Password          = $null
            BitwardenItemJson = $null
            Secrets           = @{}
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

        $secretListStep = {
            param([string]$Repo)
            $state.Calls.Add("secret-list")
            return $ExistingSecrets
        }.GetNewClosure()

        $secretSetStep = {
            param([string]$Repo, [string]$Name, [string]$Value)
            $state.Calls.Add("secret-set:$Name")
            $state.Secrets[$Name] = $Value
        }.GetNewClosure()

        return [PSCustomObject]@{
            State = $state
            Args  = @{
                CertificateStep     = $certificateStep
                BitwardenStatusStep = $bitwardenStatusStep
                BitwardenListStep   = $bitwardenListStep
                BitwardenCreateStep = $bitwardenCreateStep
                SecretListStep      = $secretListStep
                SecretSetStep       = $secretSetStep
            }
        }
    }
}

Describe "packaging/msix/New-SigningCertificate.ps1" {
    It "pfx / cer を BackupDir に書き、パスワードを Bitwarden に保存し、Secrets を登録する（標準入力相当の値で）" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert"

        $result = Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs

        $result.PfxPath | Should -Be (Join-Path $backup "arbor-signing.pfx")
        Test-Path $result.CerPath | Should -BeTrue
        $harness.State.Calls | Should -Be @(
            "bw-status", "bw-list", "secret-list", "certificate", "bw-create",
            "secret-set:SIGNING_CERTIFICATE_BASE64", "secret-set:SIGNING_CERTIFICATE_PASSWORD"
        )
        [Convert]::FromBase64String($harness.State.Secrets["SIGNING_CERTIFICATE_BASE64"]) | Should -Be ([byte[]](1, 2, 3, 4))
        $harness.State.Secrets["SIGNING_CERTIFICATE_PASSWORD"] | Should -Be $harness.State.Password
        ($harness.State.BitwardenItemJson | ConvertFrom-Json).notes | Should -Be $harness.State.Password
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

    It "事前確認の失敗では、証明書を作らず、Secrets も登録しない" -TestCases @(
        @{ Name = "既存の pfx（-Force なし）"; Message = "*既に存在します*"; Setup = { param($backup) New-Item -ItemType Directory -Force $backup | Out-Null; [IO.File]::WriteAllText((Join-Path $backup "arbor-signing.pfx"), "old") }; Harness = @{} },
        @{ Name = "Bitwarden が未解錠"; Message = "*解錠されていません*"; Setup = {}; Harness = @{ BitwardenUnlocked = $false } },
        @{ Name = "Bitwarden に同名の項目"; Message = "*同名の項目*"; Setup = {}; Harness = @{ BitwardenItemExists = $true } },
        @{ Name = "GitHub に同名の Secrets"; Message = "*同名の Secrets*"; Setup = {}; Harness = @{ ExistingSecrets = @("SIGNING_CERTIFICATE_BASE64") } }
    ) {
        param($Name, $Message, $Setup, $Harness)
        $harnessParams = $Harness
        $harness = New-TestHarness @harnessParams
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-precheck-$([guid]::NewGuid().ToString('N'))"
        & $Setup $backup

        { Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs } | Should -Throw $Message

        $harness.State.Calls | Should -Not -Contain "certificate"
        ($harness.State.Calls | Where-Object { $_ -like "secret-set:*" }) | Should -BeNullOrEmpty
    }

    It "-Force なら、既存の pfx と同名の Secrets を上書きできる" {
        $harness = New-TestHarness -ExistingSecrets @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-force"
        New-Item -ItemType Directory -Force $backup | Out-Null
        [IO.File]::WriteAllText((Join-Path $backup "arbor-signing.pfx"), "old")

        Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register -Force @stepArgs | Out-Null

        $harness.State.Calls | Should -Contain "certificate"
        $harness.State.Secrets.Keys | Should -HaveCount 2
    }

    It "Bitwarden への保存に失敗したら、Secrets を登録しない" {
        $harness = New-TestHarness -BitwardenCreateFails $true
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-bw-fail"

        { Invoke-ArborSigningCertificateSetup -BackupDir $backup -Register @stepArgs } | Should -Throw "*bw create failed*"

        ($harness.State.Calls | Where-Object { $_ -like "secret-set:*" }) | Should -BeNullOrEmpty
    }

    It "-SkipBitwarden なら Bitwarden に触れない。-Register なしなら Secrets に触れない" {
        $harness = New-TestHarness
        $stepArgs = $harness.Args
        $backup = Join-Path $TestDrive "cert-skip"

        Invoke-ArborSigningCertificateSetup -BackupDir $backup -SkipBitwarden @stepArgs | Out-Null

        $harness.State.Calls | Should -Be @("certificate")
    }
}
