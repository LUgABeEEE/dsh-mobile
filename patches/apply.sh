#!/usr/bin/env bash
# Apply the local dsh-mobile cache patches on top of upstream 0.8.1 (42cabbd).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${1:-$(git rev-parse --show-toplevel)}"
base="${2:-42cabbd}"

cd "$repo"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi
git rev-parse --verify "$base" >/dev/null || {
  echo "error: base commit $base not found (fetch upstream first: git fetch upstream)" >&2
  exit 1
}
git checkout -B local/cache-patch "$base" 2>/dev/null || git checkout "$base"
# 本机没有全局 git 身份（作者约定：不改 git config），这里显式给出，可用环境变量覆盖。
git -c user.name="${GIT_AUTHOR_NAME:-LUgABeEEE}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-LUgABeEEE@users.noreply.github.com}" \
    am "$here"/0*.patch
echo "applied: $(git log --oneline "$base"..HEAD | wc -l) commits on top of $base"
