#!/usr/bin/env bash
set -euo pipefail

# Validate Renovate preset and test fixture configs using renovate-config-validator.
# Requires renovate to be installed (npm install -g renovate).
# Usage: scripts/validate-presets.sh

cd "$(git rev-parse --show-toplevel)"

if ! command -v renovate-config-validator &> /dev/null; then
  echo "renovate-config-validator not found. Install with: npm install -g renovate"
  exit 1
fi

echo "Validating Renovate presets..."

errors=0
for f in *.json files/release-updates.json; do
  echo "  $f"
  renovate-config-validator "$f" || errors=$((errors + 1))
done

if [ -d tests/fixtures ]; then
  echo "Validating test fixtures..."
  for f in tests/fixtures/*.json; do
    [ -f "$f" ] || continue
    echo "  $f"
    renovate-config-validator "$f" || errors=$((errors + 1))
  done
fi

if [ "$errors" -gt 0 ]; then
  echo "FAIL: $errors config(s) failed validation."
  exit 1
fi

echo "All configs valid."
