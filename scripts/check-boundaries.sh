#!/usr/bin/env bash
set -euo pipefail

# Boundary guard: fails if any forbidden identifier appears in the runtime
# sources. Host- and provider-specific identifiers are deliberately NOT
# embedded here — a public copy of this script must not disclose them.
#
# The pattern comes from, in order:
#   1. $ACTOR0_BOUNDARY_PATTERN (environment)
#   2. .boundary-pattern (one regex, untracked; see .gitignore)
#   3. a generic default so CI still exercises the mechanism
pattern="${ACTOR0_BOUNDARY_PATTERN:-}"
if [ -z "$pattern" ] && [ -f .boundary-pattern ]; then
  pattern="$(tr -d '\r\n' < .boundary-pattern)"
fi
if [ -z "$pattern" ]; then
  pattern='HOST_PRODUCT_NAME'
fi

paths=(packages apps crates)
search_paths=()
for p in "${paths[@]}"; do
  [ -d "$p" ] && search_paths+=("$p")
done
if rg -n -i "$pattern" "${search_paths[@]}" --glob '!**/target/**' --glob '!**/.next/**'; then
  echo "boundary violation: excluded host/provider/proprietary identifier found" >&2
  exit 1
fi

echo "boundary check passed"
