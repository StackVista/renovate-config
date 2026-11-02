#!/usr/bin/env bash
set -euo pipefail

# Validate JSON syntax of all preset and test fixture files.
# Usage: scripts/validate-json.sh

cd "$(git rev-parse --show-toplevel)"

echo "Validating JSON syntax..."

errors=0
for f in *.json; do
  echo "  $f"
  python3 -m json.tool "$f" > /dev/null || errors=$((errors + 1))
done

if [ -d tests/fixtures ]; then
  for f in tests/fixtures/*.json; do
    [ -f "$f" ] || continue
    echo "  $f"
    python3 -m json.tool "$f" > /dev/null || errors=$((errors + 1))
  done
fi

if [ "$errors" -gt 0 ]; then
  echo "FAIL: $errors file(s) with invalid JSON."
  exit 1
fi

echo "All JSON files valid."
