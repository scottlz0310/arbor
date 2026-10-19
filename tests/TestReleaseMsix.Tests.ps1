# scripts/Test-ReleaseMsix.ps1 が、破損・別版・未署名・署名者違いの MSIX を公開前に拒否することを固定する。
# 実際に Build-Msix.ps1 で署名した MSIX を使う（Windows SDK の makeappx / signtool が必要）。
BeforeDiscovery {
    function Find-SdkTool([string]$Name) {
        Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\$Name" -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }

    $script:canBuildMsix = $IsWindows -and (Find-SdkTool "makeappx.exe") -and (Find-SdkTool "signtool.exe")
}

Describe "Test-ReleaseMsix.ps1" -Skip:(-not $script:canBuildMsix) {
    BeforeAll {
        $script:verifyScript = (Resolve-Path "$PSScriptRoot/../scripts/Test-ReleaseMsix.ps1").Path
        $script:buildScript = (Resolve-Path "$PSScriptRoot/../packaging/msix/Build-Msix.ps1").Path
        $script:version = "0.11.0"
        $script:workRoot = Join-Path ([IO.Path]::GetTempPath()) "msix-tests-$([guid]::NewGuid())"
        $script:createdCertificates = [System.Collections.Generic.List[string]]::new()
        $script:password = "test-password-$([guid]::NewGuid())"
        New-Item -ItemType Directory $script:workRoot | Out-Null

        function New-TestSigningCertificate([string]$Subject, [string]$Name) {
            $cert = New-SelfSignedCertificate -Type Custom -Subject $Subject -KeyUsage DigitalSignature `
                -CertStoreLocation "Cert:\CurrentUser\My" `
                -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
            $script:createdCertificates.Add($cert.Thumbprint)

            $pfx = Join-Path $script:workRoot "$Name.pfx"
            $cer = Join-Path $script:workRoot "$Name.cer"
            $secure = ConvertTo-SecureString $script:password -AsPlainText -Force
            Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
            Export-Certificate -Cert $cert -FilePath $cer | Out-Null

            [PSCustomObject]@{ Pfx = $pfx; Cer = $cer }
        }

        function New-MsixDir([string]$Name, [string]$Tag, [string]$Pfx) {
            $dir = Join-Path $script:workRoot $Name
            $binary = Join-Path $script:workRoot "arbor.exe"
            Set-Content -LiteralPath $binary "dummy binary"

            $arguments = @{ BinaryPath = $binary; Tag = $Tag; OutDir = $dir }
            if ($Pfx) {
                $arguments.PfxPath = $Pfx
                $arguments.PfxPassword = $script:password
            }
            & $script:buildScript @arguments | Out-Null

            $dir
        }

        $script:signing = New-TestSigningCertificate "CN=scottlz0310" "signing"
        $script:otherSigning = New-TestSigningCertificate "CN=scottlz0310" "other-signing"
        $script:otherSubject = New-TestSigningCertificate "CN=someone-else" "other-subject"
    }

    AfterAll {
        foreach ($thumbprint in $script:createdCertificates) {
            Remove-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
        }
        Remove-Item $script:workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "署名済みの正しい MSIX を受理する" {
        $dir = New-MsixDir "good" "v$script:version" $script:signing.Pfx
        Copy-Item $script:signing.Cer (Join-Path $dir "arbor.cer") -Force

        { & $script:verifyScript -Dir $dir -Version $script:version } | Should -Not -Throw
    }

    It "<Name>" -ForEach @(
        @{
            Name     = "期待と異なる版を拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = New-MsixDir "wrong-version" "v0.12.0" $signing.Pfx; Copy-Item $signing.Cer (Join-Path $d "arbor.cer") -Force; $d }
            Expected = "*Identity Version*"
        }
        @{
            Name     = "署名後に内容を書き換えた MSIX を拒否する"
            Setup    = {
                param($signing, $other, $otherSubject)
                $d = New-MsixDir "tampered" "v0.11.0" $signing.Pfx
                Copy-Item $signing.Cer (Join-Path $d "arbor.cer") -Force
                $msix = Join-Path $d "arbor_x64.msix"
                $bytes = [IO.File]::ReadAllBytes($msix)
                $bytes[2000] = $bytes[2000] -bxor 0xFF
                [IO.File]::WriteAllBytes($msix, $bytes)
                $d
            }
            Expected = "*署名が不正*"
        }
        @{
            Name     = "未署名の MSIX を拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = New-MsixDir "unsigned" "v0.11.0" $null; Copy-Item $signing.Cer (Join-Path $d "arbor.cer") -Force; $d }
            Expected = "*署名されていません*"
        }
        @{
            Name     = "arbor.cer と異なる鍵で署名された MSIX を拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = New-MsixDir "other-key" "v0.11.0" $signing.Pfx; Copy-Item $other.Cer (Join-Path $d "arbor.cer") -Force; $d }
            Expected = "*署名者が arbor.cer と異なります*"
        }
        @{
            Name     = "Publisher と arbor.cer の Subject が異なる場合を拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = New-MsixDir "other-subject" "v0.11.0" $signing.Pfx; Copy-Item $otherSubject.Cer (Join-Path $d "arbor.cer") -Force; $d }
            Expected = "*Publisher が arbor.cer の Subject と一致しません*"
        }
        @{
            Name     = "MSIX ではないファイルを拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = Join-Path $script:workRoot "text-file"; New-Item -ItemType Directory $d | Out-Null; Set-Content (Join-Path $d "arbor_x64.msix") "not a package"; Copy-Item $signing.Cer (Join-Path $d "arbor.cer"); $d }
            Expected = "*"
        }
        @{
            Name     = "MSIX が欠落している場合を拒否する"
            Setup    = { param($signing, $other, $otherSubject) $d = Join-Path $script:workRoot "missing"; New-Item -ItemType Directory $d | Out-Null; Copy-Item $signing.Cer (Join-Path $d "arbor.cer"); $d }
            Expected = "*asset が無いか空です*"
        }
    ) {
        $dir = & $Setup $script:signing $script:otherSigning $script:otherSubject
        $checkVersion = $script:version

        { & $script:verifyScript -Dir $dir -Version $checkVersion } | Should -Throw -ExpectedMessage $Expected
    }
}
