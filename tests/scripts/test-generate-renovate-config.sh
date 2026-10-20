#!/usr/bin/env bash
set -euo pipefail

# Unit tests for scripts/generate-renovate-config.sh

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$SCRIPT_DIR/scripts/deploy/generate-renovate-config.sh"
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

CONFIG_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD)

pass=0
fail=0

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name"
    echo "    expected to contain: $needle"
    echo "    actual: $haystack"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name"
    echo "    expected NOT to contain: $needle"
    echo "    actual: $haystack"
    fail=$((fail + 1))
  fi
}

# --- Test: single ecosystem ---
echo "Test: single ecosystem (go)"
OUT="$TMPDIR_TEST/single.json"
"$SCRIPT" "go" "$OUT" > /dev/null
CONTENT=$(cat "$OUT")
assert_contains "includes default preset" "github>StackVista/renovate-config#${CONFIG_SHA}" "$CONTENT"
assert_contains "includes go preset" "github>StackVista/renovate-config:go#${CONFIG_SHA}" "$CONTENT"
assert_not_contains "no docker preset" "renovate-config:docker" "$CONTENT"
assert_not_contains "automerge requires explicit selection" "renovate-config:automerge" "$CONTENT"
assert_contains "has schema" 'renovate-schema.json' "$CONTENT"
# Verify valid JSON
python3 -m json.tool "$OUT" > /dev/null 2>&1
assert_eq "output is valid JSON" "0" "$?"

# --- Test: multiple ecosystems ---
echo "Test: multiple ecosystems (go,docker,node)"
OUT="$TMPDIR_TEST/multi.json"
"$SCRIPT" "go,docker,node" "$OUT" > /dev/null
CONTENT=$(cat "$OUT")
assert_contains "includes go preset" "renovate-config:go" "$CONTENT"
assert_contains "includes docker preset" "renovate-config:docker" "$CONTENT"
assert_contains "includes node preset" "renovate-config:node" "$CONTENT"
python3 -m json.tool "$OUT" > /dev/null 2>&1
assert_eq "output is valid JSON" "0" "$?"

echo "Test: optional automerge preserves preset order"
OUT="$TMPDIR_TEST/automerge.json"
"$SCRIPT" "docker,go,automerge" "$OUT" > /dev/null
EXTENDS=$(python3 -c "import json; print(','.join(json.load(open('$OUT'))['extends']))")
assert_eq "selected presets retain order" \
  "github>StackVista/renovate-config#${CONFIG_SHA},github>StackVista/renovate-config:docker#${CONFIG_SHA},github>StackVista/renovate-config:go#${CONFIG_SHA},github>StackVista/renovate-config:automerge#${CONFIG_SHA}" "$EXTENDS"

# --- Test: ecosystems with whitespace ---
echo "Test: ecosystems with whitespace"
OUT="$TMPDIR_TEST/whitespace.json"
"$SCRIPT" "go , docker , node" "$OUT" > /dev/null
CONTENT=$(cat "$OUT")
assert_contains "includes go preset (trimmed)" "renovate-config:go" "$CONTENT"
assert_contains "includes docker preset (trimmed)" "renovate-config:docker" "$CONTENT"
assert_contains "includes node preset (trimmed)" "renovate-config:node" "$CONTENT"
assert_not_contains "no leading space in preset name" "renovate-config: go" "$CONTENT"

# --- Test: single ecosystem (docker) ---
echo "Test: single ecosystem (docker)"
OUT="$TMPDIR_TEST/docker.json"
"$SCRIPT" "docker" "$OUT" > /dev/null
CONTENT=$(cat "$OUT")
assert_contains "includes docker preset" "renovate-config:docker" "$CONTENT"
assert_not_contains "no go preset" "renovate-config:go" "$CONTENT"

# --- Test: default preset always present ---
echo "Test: default preset always included"
OUT="$TMPDIR_TEST/default-check.json"
"$SCRIPT" "java" "$OUT" > /dev/null
CONTENT=$(cat "$OUT")
# The first extends entry should be the bare default (no colon suffix)
FIRST_EXTEND=$(python3 -c "import json; print(json.load(open('$OUT'))['extends'][0])")
assert_eq "first extend is default preset" "github>StackVista/renovate-config#${CONFIG_SHA}" "$FIRST_EXTEND"

echo "Test: explicit revision pins every preset"
EXPLICIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
"$SCRIPT" "go,docker,automerge" "$TMPDIR_TEST/explicit.json" "$EXPLICIT_SHA" > /dev/null
python3 - "$TMPDIR_TEST/explicit.json" "$EXPLICIT_SHA" <<'PYTEST'
import json
import sys
refs = json.load(open(sys.argv[1]))['extends']
assert len(refs) == 4
assert all(ref.endswith('#' + sys.argv[2]) for ref in refs)
PYTEST
assert_eq "all presets use the explicit revision" "0" "$?"
for value in main short; do
  if "$SCRIPT" "go" "$TMPDIR_TEST/invalid.json" "$value" 2>/dev/null; then
    fail=$((fail + 1))
  else
    pass=$((pass + 1))
  fi
done
if "$SCRIPT" "unknown" "$TMPDIR_TEST/invalid.json" "$EXPLICIT_SHA" 2>/dev/null; then
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# --- Test: missing arguments ---
echo "Test: missing arguments exits with error"
if "$SCRIPT" 2>/dev/null; then
  echo "  FAIL: should have exited with error"
  fail=$((fail + 1))
else
  echo "  PASS: exits with non-zero on missing args"
  pass=$((pass + 1))
fi

# --- Summary ---
echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
