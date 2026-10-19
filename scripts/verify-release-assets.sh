#!/usr/bin/env bash
# draft の Release の成果物を検証する（公開はしない）。読み取りだけを行う。
#
# 使い方: scripts/verify-release-assets.sh <タグ>   例: scripts/verify-release-assets.sh v0.4.0
#
# 検証する内容:
#   1. 必要な成果物が、すべてある
#      - macOS / Linux: インストーラ（dmg・AppImage・deb）、updater の署名（.sig）、latest.json
#      - Windows: MSIX 一式（arbor_x64.msix・arbor.appinstaller・arbor.cer・install.ps1・checksums-msix.txt）
#   2. 旧い Windows のインストーラ（msi・setup.exe）が、混ざっていない（Windows は MSIX だけで配布する。#324）
#   3. latest.json: 版がタグと一致する。プラットフォームが macOS と Linux の 2 つだけ。全 URL が、Release にある成果物を指す
#   4. MSIX 一式: checksum が、生成時に記録したものと一致する。.appinstaller の版と、MainPackage の URI が、タグと一致する
# MSIX の署名・Identity・Publisher は、scripts/Test-ReleaseMsix.ps1 が検証する（verify-release.yml の verify-msix）。
#
# CI（.github/workflows/verify-release.yml）と、手元の確認で、同じものを実行する。
# 環境: gh（対象の Release を読める認証）、jq、sha256sum が要る。GH_REPO（owner/repo）を指定するか、
# リポジトリの中で実行する。draft の Release は、書き込み権限のあるトークンにしか見えない。
set -euo pipefail

TAG="${1:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::タグを v1.2.3 の形で指定してください: '${TAG}'" >&2
  exit 2
fi
version="${TAG#v}"

# Windows の jq / gh は、行末に CR を付ける。比較の前に取り除く。
strip_cr() { tr -d '\r'; }

if ! release_json=$(gh release view "$TAG" --json assets,isDraft 2>&1); then
  echo "::error::Release を読めません（draft は、書き込み権限のあるトークンにしか見えません）: $TAG: $release_json" >&2
  exit 1
fi
assets=$(jq -r '.assets[].name' <<< "$release_json" | strip_cr)
is_draft=$(jq -r '.isDraft' <<< "$release_json" | strip_cr)

echo "Release $TAG（draft: $is_draft）の成果物:"
while IFS= read -r asset; do
  echo "  $asset"
done <<< "$assets"

fail=0
require() {
  local pattern="$1" label="$2"
  if grep -Eq "$pattern" <<< "$assets"; then
    echo "OK   $label"
  else
    echo "::error::成果物がありません（$label）: $pattern" >&2
    fail=1
  fi
}
forbid() {
  local pattern="$1" label="$2"
  if grep -Eq "$pattern" <<< "$assets"; then
    echo "::error::公開してはいけない成果物があります（$label）: $(grep -E "$pattern" <<< "$assets" | tr '\n' ' ')" >&2
    fail=1
  else
    echo "OK   $label が無い"
  fi
}

# 1. 必要な成果物
require '\.dmg$' 'macOS（dmg）'
require 'aarch64.*\.app\.tar\.gz\.sig$' 'updater の署名（macOS）'
require '\.AppImage$' 'Linux（AppImage）'
require '\.deb$' 'Linux（deb）'
require '\.AppImage\.tar\.gz\.sig$' 'updater の署名（Linux）'
require '^latest\.json$' 'updater の manifest（latest.json）'
require '^arbor_x64\.msix$' 'Windows の MSIX'
require '^arbor\.appinstaller$' 'Windows の .appinstaller'
require '^arbor\.cer$' 'Windows の公開証明書'
require '^install\.ps1$' 'Windows の install.ps1'
require '^checksums-msix\.txt$' 'MSIX の checksum（checksums-msix.txt）'

# 2. 旧い Windows のインストーラ
forbid '\.msi($|\.)|-setup\.exe($|\.)|\.nsis\.zip' 'Windows の msi / setup.exe（MSIX だけで配布する）'
if ((fail)); then
  exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# 3. latest.json を、Release から取り直して照合する。
gh release download "$TAG" --pattern latest.json --dir "$workdir"

manifest_version=$(jq -r '.version' "$workdir/latest.json" | strip_cr)
if [[ "$manifest_version" != "$version" ]]; then
  echo "::error::latest.json の版（$manifest_version）が、タグ（$TAG）と一致しません" >&2
  exit 1
fi
echo "OK   latest.json の版 = ${manifest_version}"

platforms=$(jq -r '.platforms | keys | sort | join(",")' "$workdir/latest.json" | strip_cr)
if [[ "$platforms" != "darwin-aarch64,linux-x86_64" ]]; then
  echo "::error::latest.json のプラットフォームが、darwin-aarch64 と linux-x86_64 の 2 つではありません（$platforms）。Windows は、MSIX の .appinstaller で更新するため、含めません" >&2
  exit 1
fi
echo "OK   latest.json のプラットフォーム = ${platforms}"

while IFS= read -r url; do
  url=$(strip_cr <<< "$url")
  name="${url##*/}"
  if ! grep -Fxq "$name" <<< "$assets"; then
    echo "::error::latest.json の URL が、Release に無い成果物を指しています: $url" >&2
    exit 1
  fi
  echo "OK   URL → $name"
done < <(jq -r '.platforms | to_entries[] | .value.url' "$workdir/latest.json")

# 4. MSIX 一式を、Release から取り直して照合する。
msix_dir="$workdir/msix"
mkdir -p "$msix_dir"
for name in arbor_x64.msix arbor.appinstaller arbor.cer install.ps1 checksums-msix.txt; do
  gh release download "$TAG" --pattern "$name" --dir "$msix_dir"
done

# checksums-msix.txt が、4 つのファイルをすべて挙げていて、実体と一致する（生成から添付の間に、壊れていない）。
for name in arbor_x64.msix arbor.appinstaller arbor.cer install.ps1; do
  if ! grep -Eq "^[0-9a-f]{64}  ${name//./\\.}\r?$" "$msix_dir/checksums-msix.txt"; then
    echo "::error::checksums-msix.txt に記載がありません: $name" >&2
    exit 1
  fi
done
if ! (cd "$msix_dir" && tr -d '\r' < checksums-msix.txt | sha256sum -c -); then
  echo "::error::MSIX 一式の checksum が一致しません（生成から添付の間に、変わった可能性があります）" >&2
  exit 1
fi
echo "OK   MSIX 一式の checksum"

# .appinstaller の版・MainPackage の URI・Name・Publisher。版は、MSIX の 4 要素（<版>.0）で、
# AppInstaller と MainPackage の両方が、同じ値であること。
appinstaller="$msix_dir/arbor.appinstaller"
versions=$(grep -o 'Version="[^"]*"' "$appinstaller" | strip_cr | sort -u)
if [[ "$versions" != "Version=\"${version}.0\"" ]]; then
  echo "::error::arbor.appinstaller の Version が、${version}.0 だけではありません: $(tr '\n' ' ' <<< "$versions")" >&2
  exit 1
fi
if ! grep -Fq "/releases/download/${TAG}/arbor_x64.msix\"" "$appinstaller"; then
  echo "::error::arbor.appinstaller の MainPackage の URI が、${TAG} の arbor_x64.msix を指していません" >&2
  exit 1
fi
if ! grep -Fq '/releases/latest/download/arbor.appinstaller"' "$appinstaller"; then
  echo "::error::arbor.appinstaller の更新元の URI が、最新の Release の arbor.appinstaller を指していません" >&2
  exit 1
fi
for attribute in 'Name="scottlz0310.arbor"' 'Publisher="CN=scottlz0310"'; do
  if ! grep -Fq "$attribute" "$appinstaller"; then
    echo "::error::arbor.appinstaller に ${attribute} がありません" >&2
    exit 1
  fi
done
echo "OK   arbor.appinstaller（版 ${version}.0、MainPackage の URI、Name、Publisher）"

echo "検証に成功しました: $TAG"
