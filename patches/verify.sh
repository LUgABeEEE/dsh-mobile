#!/usr/bin/env bash
# Run the same checks used when this patch series was validated.
set -euo pipefail
repo="${1:-$(git rev-parse --show-toplevel)}"
cd "$repo"
echo "== tsc =="; npx tsc --noEmit
echo "== targeted vitest =="; npx vitest run tests/content-cache.test.ts tests/gateway.test.ts
echo "== docs =="; npm run check:docs
echo "== android (needs JDK17 + SDK36; skipped if absent) =="
if [[ -n "${ANDROID_HOME:-}" ]] && command -v java >/dev/null; then
  ( cd apps/mobile/android && ./gradlew --no-daemon -PirohNative=false :app:clean :app:testDebugUnitTest )
else
  echo "skipped: set ANDROID_HOME and put JDK 17 on PATH to run the Android lane"
fi
