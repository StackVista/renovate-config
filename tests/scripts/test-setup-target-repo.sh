#!/usr/bin/env bash
set -euo pipefail

# Unit tests for scripts/setup-target-repo.sh

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$SCRIPT_DIR/scripts/deploy/setup-target-repo.sh"
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

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

assert_file_exists() {
  local test_name="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name — file not found: $path"
    fail=$((fail + 1))
  fi
}

assert_file_not_exists() {
  local test_name="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name — file should not exist: $path"
    fail=$((fail + 1))
  fi
}

# --- Setup: create a fake config dir with the caller template ---
CONFIG_DIR="$TMPDIR_TEST/config"
mkdir -p "$CONFIG_DIR/files"
echo "fake-workflow-content" > "$CONFIG_DIR/files/renovate-caller.yml"

# --- Test: copies workflow caller ---
echo "Test: copies workflow caller to target"
TARGET="$TMPDIR_TEST/target-basic"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
assert_file_exists "workflow file created" "$TARGET/.github/workflows/renovate.yml"
CONTENT=$(cat "$TARGET/.github/workflows/renovate.yml")
assert_eq "workflow content matches template" "fake-workflow-content" "$CONTENT"

# --- Test: creates .github/workflows directory ---
echo "Test: creates directory structure"
TARGET="$TMPDIR_TEST/target-no-github"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
assert_file_exists "directory and file created" "$TARGET/.github/workflows/renovate.yml"

# --- Test: removes dependabot.yml ---
echo "Test: removes dependabot.yml if present"
TARGET="$TMPDIR_TEST/target-dependabot"
mkdir -p "$TARGET/.github"
echo "dependabot-config" > "$TARGET/.github/dependabot.yml"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
assert_file_not_exists "dependabot.yml removed" "$TARGET/.github/dependabot.yml"
assert_file_exists "workflow still created" "$TARGET/.github/workflows/renovate.yml"

# --- Test: no error when dependabot.yml absent ---
echo "Test: no error when dependabot.yml absent"
TARGET="$TMPDIR_TEST/target-no-dependabot"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
assert_eq "exits successfully" "0" "$?"

# --- Test: idempotent — running twice overwrites cleanly ---
echo "Test: idempotent run"
TARGET="$TMPDIR_TEST/target-idempotent"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
"$SCRIPT" "$CONFIG_DIR" "$TARGET" > /dev/null
assert_file_exists "workflow still present after second run" "$TARGET/.github/workflows/renovate.yml"
CONTENT=$(cat "$TARGET/.github/workflows/renovate.yml")
assert_eq "content unchanged after second run" "fake-workflow-content" "$CONTENT"

# --- Test: missing config dir fails ---
echo "Test: missing caller template exits with error"
if "$SCRIPT" "$TMPDIR_TEST/nonexistent" "$TMPDIR_TEST/whatever" 2>/dev/null; then
  echo "  FAIL: should have exited with error"
  fail=$((fail + 1))
else
  echo "  PASS: exits with non-zero on missing template"
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
