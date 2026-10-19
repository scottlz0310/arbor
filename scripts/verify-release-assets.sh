#!/usr/bin/env bash
# draft の Release の成果物を検証する（公開はしない）。読み取りだけを行う。
#
# 使い方: scripts/verify-release-assets.sh <タグ>   例: scripts/verify-release-assets.sh v0.3.0
#
# 検証する内容: 必要な成果物（各 OS のインストーラ）が、すべてある。
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
if ((fail)); then
  exit 1
fi

echo "検証に成功しました: $TAG"
