#!/usr/bin/env bash
# Remove the local cache patches. Default: reset to upstream 0.8.1 (42cabbd).
set -euo pipefail
repo="${1:-$(git rev-parse --show-toplevel)}"
base="${2:-42cabbd}"
cd "$repo"
echo "this will discard ALL working-tree and committed changes since $base in this checkout"
read -r -p "type the branch name to confirm ($(git branch --show-current)): " ok
[[ "$ok" == "$(git branch --show-current)" ]] || { echo "aborted"; exit 1; }
git reset --hard "$base"
git clean -fd apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile apps/mobile/android/app/src/test/java/io/github/sayach/dshmobile
echo "rolled back to $base"
