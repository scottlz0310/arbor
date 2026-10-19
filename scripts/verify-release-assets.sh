#!/usr/bin/env bash
# draft の Release の成果物を検証する（公開はしない）。読み取りだけを行う。
#
# 使い方: scripts/verify-release-assets.sh <タグ>   例: scripts/verify-release-assets.sh v0.3.0
#
# 検証する内容:
#   1. 必要な成果物が、すべてある（インストーラ・updater の署名・latest.json）
#   2. latest.json の版が、タグと一致する
#   3. latest.json の全 URL が、Release にある成果物を指す
#
# CI（.github/workflows/verify-release.yml）と、手元の確認で、同じものを実行する。
# 環境: gh（対象の Release を読める認証）と jq が要る。GH_REPO（owner/repo）を指定するか、
# リポジトリの中で実行する。draft の Release は、書き込み権限のあるトークンにしか見えない。
set -euo pipefail

TAG="${1:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::タグを v1.2.3 の形で指定してください: '${TAG}'" >&2
  exit 2
fi

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
require '\.msi$' 'Windows のインストーラ（msi）'
require '-setup\.exe$' 'Windows のセットアップ'
require '\.dmg$' 'macOS（dmg）'
require '\.AppImage$' 'Linux（AppImage）'
require '\.deb$' 'Linux（deb）'
require '\.msi\.zip\.sig$' 'updater の署名（Windows）'
require 'aarch64.*\.app\.tar\.gz\.sig$' 'updater の署名（macOS）'
require '\.AppImage\.tar\.gz\.sig$' 'updater の署名（Linux）'
require '^latest\.json$' 'updater の manifest（latest.json）'
if ((fail)); then
  exit 1
fi

# latest.json を、Release から取り直して照合する。
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
gh release download "$TAG" --pattern latest.json --dir "$workdir"

version=$(jq -r '.version' "$workdir/latest.json" | strip_cr)
if [[ "$version" != "${TAG#v}" ]]; then
  echo "::error::latest.json の版（$version）が、タグ（$TAG）と一致しません" >&2
  exit 1
fi
echo "OK   latest.json の版 = ${version}"

platforms=0
while IFS= read -r url; do
  url=$(strip_cr <<< "$url")
  name="${url##*/}"
  if ! grep -Fxq "$name" <<< "$assets"; then
    echo "::error::latest.json の URL が、Release に無い成果物を指しています: $url" >&2
    exit 1
  fi
  echo "OK   URL → $name"
  platforms=$((platforms + 1))
done < <(jq -r '.platforms | to_entries[] | .value.url' "$workdir/latest.json")
if ((platforms != 3)); then
  echo "::error::latest.json のプラットフォームが 3 つではありません（$platforms）" >&2
  exit 1
fi

echo "検証に成功しました: $TAG"
