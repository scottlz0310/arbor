# MSIX の署名用の Secrets（SIGNING_CERTIFICATE_BASE64 / SIGNING_CERTIFICATE_PASSWORD）を扱う関数の集まり。
# New-SigningCertificate.ps1（生成と登録）と Register-SigningSecrets.ps1（バックアップからの復元）が、
# dot-source して使う。単独では実行しない。
#
# 署名用の Secrets は、リポジトリの Secrets ではなく、Environment のシークレットに置く。
# 同一リポジトリの PR は、ワークフロー自体を書き換えて、リポジトリの Secrets を読める。Environment のデプロイを
# main に限定すると、PR のワークフローからは読めない。外部（gh・bw）への呼び出しは、テストで差し替えられる。

$ArborSigningSecretNames = @("SIGNING_CERTIFICATE_BASE64", "SIGNING_CERTIFICATE_PASSWORD")

function Test-ArborBitwardenUnlocked {
    param([scriptblock]$StatusStep)

    $json = if ($null -ne $StatusStep) { & $StatusStep } else { & bw status 2>$null }
    try {
        return ($json | ConvertFrom-Json).status -eq "unlocked"
    } catch {
        return $false
    }
}

function Test-ArborBitwardenItemExists {
    param(
        [Parameter(Mandatory)][string]$Name,
        [scriptblock]$ListStep
    )

    $json = if ($null -ne $ListStep) { & $ListStep -Name $Name } else { & bw list items --search $Name }
    $items = @($json | ConvertFrom-Json) | Where-Object { $_.name -eq $Name }
    return @($items).Count -gt 0
}

# Bitwarden の secure note から、パスワードを取り出す（画面には出さない）。
function Get-ArborSigningPassword {
    param(
        [Parameter(Mandatory)][string]$ItemName,
        [scriptblock]$GetStep
    )

    $json = if ($null -ne $GetStep) { & $GetStep -Name $ItemName } else { & bw get item $ItemName }
    if ($LASTEXITCODE -ne 0 -and $null -eq $GetStep) { throw "Bitwarden の項目を取得できません: $ItemName" }
    $password = ($json | ConvertFrom-Json).notes
    if ([string]::IsNullOrWhiteSpace($password)) { throw "Bitwarden の項目にパスワードがありません: $ItemName" }
    return $password
}

# Environment を作り（無ければ）、デプロイできるブランチを $Branch だけに限定する。何度実行しても同じ状態になる。
# 外部への書き込みなので、呼ぶ前に、Get-ArborSigningEnvironmentState と Assert-ArborSigningEnvironmentPlan で、
# 読み取りだけで衝突を判定しておく（衝突で中止するときに、既存の Environment を書き換えないため）。
function Initialize-ArborSigningEnvironment {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)]$State,
        [scriptblock]$EnvironmentStep
    )

    if ($null -ne $EnvironmentStep) {
        $null = & $EnvironmentStep -Repo $Repo -Environment $Environment -Branch $Branch -State $State
        return
    }

    $base = "repos/$Repo/environments/$Environment"
    # 既に、カスタムのポリシーで、想定どおりに設定されている Environment には、書き込まない
    if (-not $State.Exists -or -not $State.CustomPolicies) {
        '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
            & gh api -X PUT $base --input - --silent
        if ($LASTEXITCODE -ne 0) { throw "Environment を作れません: $Environment（終了コード: $LASTEXITCODE。リポジトリの管理者権限と gh auth status を確認してください）" }
    }
    if (@($State.Policies) -notcontains "branch:$Branch") {
        "{`"name`":`"$Branch`",`"type`":`"branch`"}" | & gh api -X POST "$base/deployment-branch-policies" --input - --silent
        if ($LASTEXITCODE -ne 0) { throw "デプロイできるブランチを登録できません: $Branch（終了コード: $LASTEXITCODE）" }
    }
}

# Environment の現在の状態を、読み取りだけで取得する（書き込まない）。無ければ Exists = $false。
# 戻り値: Exists, CustomPolicies（カスタムのブランチ / タグのポリシーか）, Policies（"branch:main" など）, SecretNames。
function Get-ArborSigningEnvironmentState {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Environment,
        [scriptblock]$StateStep,
        [scriptblock]$SecretListStep
    )

    if ($null -ne $StateStep) { return & $StateStep -Repo $Repo -Environment $Environment }

    $base = "repos/$Repo/environments/$Environment"
    $output = & gh api $base 2>&1
    if ($LASTEXITCODE -ne 0) {
        if (($output | Out-String) -match 'HTTP 404') {
            return [PSCustomObject]@{ Exists = $false; CustomPolicies = $false; Policies = @(); SecretNames = @() }
        }
        throw "Environment の状態を取得できません: $Environment（終了コード: $LASTEXITCODE。$(($output | Out-String).Trim())）"
    }
    $environmentInfo = ($output | Out-String) | ConvertFrom-Json
    $custom = [bool]($environmentInfo.deployment_branch_policy -and $environmentInfo.deployment_branch_policy.custom_branch_policies)

    $policies = @()
    if ($custom) {
        $listed = @(& gh api "$base/deployment-branch-policies" --jq '.branch_policies[] | "\(.type):\(.name)"')
        if ($LASTEXITCODE -ne 0) { throw "Environment のデプロイのポリシーを取得できません: $Environment（終了コード: $LASTEXITCODE）" }
        $policies = @($listed | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }

    return [PSCustomObject]@{
        Exists         = $true
        CustomPolicies = $custom
        Policies       = $policies
        SecretNames    = @(Get-ArborExistingSecretNames -Repo $Repo -Environment $Environment -ListStep $SecretListStep)
    }
}

# 状態（読み取りだけで取得したもの）から、外部へ書き込む前に、衝突を判定する。書き込む前に、すべて済ませる。
#  - 既存の Environment のデプロイ制限が、想定（カスタム）と異なる: -Force なしでは、書き換えない
#  - 想定外のブランチ / タグのポリシーがある: 黙って消さない（-Force でも）
#  - 同名のシークレットがある: -Force なしでは、上書きしない
function Assert-ArborSigningEnvironmentPlan {
    param(
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)]$State,
        [switch]$Force
    )

    if ($State.Exists -and -not $State.CustomPolicies -and -not $Force) {
        throw "Environment「$Environment」のデプロイ制限が、想定（カスタム。$Branch のみ）と異なります。書き換えると、既存の署名処理のデプロイの可否が変わります（手で確認するか、-Force）"
    }
    $unexpected = @(@($State.Policies) | Where-Object { $_ -ne "branch:$Branch" })
    if ($unexpected.Count -gt 0) {
        throw "Environment「$Environment」に、想定外のデプロイのポリシーがあります: $($unexpected -join ', ')（$Branch だけに限定するため、手で確認して削除してください）"
    }
    if (-not $Force) {
        $existing = @(@($State.SecretNames) | Where-Object { $ArborSigningSecretNames -contains $_ })
        if ($existing.Count -gt 0) {
            throw "Environment「$Environment」に同名のシークレットがあります: $($existing -join ', ')（上書きするには -Force）"
        }
    }
}

function Get-ArborExistingSecretNames {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Environment,
        [scriptblock]$ListStep
    )

    if ($null -ne $ListStep) { return @(& $ListStep -Repo $Repo -Environment $Environment) }
    $names = & gh secret list --repo $Repo --env $Environment --json name --jq ".[].name"
    if ($LASTEXITCODE -ne 0) { throw "Environment「$Environment」の Secrets の一覧を取得できません（終了コード: $LASTEXITCODE）。gh auth status を確認してください" }
    return @($names | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# 署名用の Secrets を、Environment に登録する。値は標準入力で渡す（引数・ログに出さない）。
function Register-ArborSigningSecrets {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string]$Base64,
        [Parameter(Mandatory)][string]$Password,
        [scriptblock]$SetStep
    )

    $values = [ordered]@{
        SIGNING_CERTIFICATE_BASE64   = $Base64
        SIGNING_CERTIFICATE_PASSWORD = $Password
    }
    foreach ($name in $values.Keys) {
        if ($null -ne $SetStep) {
            $null = & $SetStep -Repo $Repo -Environment $Environment -Name $name -Value $values[$name]
            continue
        }
        $values[$name] | & gh secret set $name --repo $Repo --env $Environment
        if ($LASTEXITCODE -ne 0) { throw "Secret $name の登録に失敗しました（終了コード: $LASTEXITCODE）" }
    }
}
