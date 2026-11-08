#!/usr/bin/env bash
# Count commits since the last version tag and print the build number.
# Usage: bash scripts/build-number.sh
# Output: the number of commits since the last vX.Y.Z tag.
# If HEAD is exactly on a tag, prints 0 (next commit is build 1).
# If no tag exists, prints 0.

set -euo pipefail

latest_tag=$(git describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null || true)

if [ -z "$latest_tag" ]; then
  echo "0"
  exit 0
fi

count=$(git rev-list --count "${latest_tag}..HEAD")

echo "$count"
