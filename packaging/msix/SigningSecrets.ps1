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
# 想定外のブランチ / タグのポリシーが既にあるときは、黙って消さず、失敗する。
function Initialize-ArborSigningEnvironment {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string]$Branch,
        [scriptblock]$EnvironmentStep
    )

    if ($null -ne $EnvironmentStep) {
        $null = & $EnvironmentStep -Repo $Repo -Environment $Environment -Branch $Branch
        return
    }

    $base = "repos/$Repo/environments/$Environment"
    '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
        & gh api -X PUT $base --input - --silent
    if ($LASTEXITCODE -ne 0) { throw "Environment を作れません: $Environment（終了コード: $LASTEXITCODE。リポジトリの管理者権限と gh auth status を確認してください）" }

    $policies = @(& gh api "$base/deployment-branch-policies" --jq '.branch_policies[] | "\(.type):\(.name)"')
    if ($LASTEXITCODE -ne 0) { throw "Environment のデプロイのポリシーを取得できません: $Environment（終了コード: $LASTEXITCODE）" }
    $policies = @($policies | ForEach-Object { $_.Trim() } | Where-Object { $_ })

    $unexpected = @($policies | Where-Object { $_ -ne "branch:$Branch" })
    if ($unexpected.Count -gt 0) {
        throw "Environment「$Environment」に、想定外のデプロイのポリシーがあります: $($unexpected -join ', ')（main だけに限定するため、手で確認して削除してください）"
    }
    if ($policies -notcontains "branch:$Branch") {
        "{`"name`":`"$Branch`",`"type`":`"branch`"}" | & gh api -X POST "$base/deployment-branch-policies" --input - --silent
        if ($LASTEXITCODE -ne 0) { throw "デプロイできるブランチを登録できません: $Branch（終了コード: $LASTEXITCODE）" }
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
