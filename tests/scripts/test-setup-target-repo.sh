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

assert_file_contains() {
  local test_name="$1" pattern="$2" path="$3"
  if grep -qF "$pattern" "$path"; then
    echo "  PASS: $test_name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $test_name — pattern not found in $path"
    echo "    pattern: $pattern"
    echo "    content: $(cat "$path")"
    fail=$((fail + 1))
  fi
}

# --- Setup: create a fake config dir with a git repo and the caller template ---
CONFIG_DIR="$TMPDIR_TEST/config"
mkdir -p "$CONFIG_DIR/files"
echo "fake-workflow-content" > "$CONFIG_DIR/files/renovate-caller.yml"
EXPECTED_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD)

# --- Test: copies workflow caller ---
echo "Test: copies workflow caller to target"
TARGET="$TMPDIR_TEST/target-basic"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_exists "workflow file created" "$TARGET/.github/workflows/renovate.yml"
CONTENT=$(cat "$TARGET/.github/workflows/renovate.yml")
assert_eq "workflow content matches template" "fake-workflow-content" "$CONTENT"

# --- Test: creates .github/workflows directory ---
echo "Test: creates directory structure"
TARGET="$TMPDIR_TEST/target-no-github"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_exists "directory and file created" "$TARGET/.github/workflows/renovate.yml"

# --- Test: removes dependabot.yml ---
echo "Test: removes dependabot.yml if present"
TARGET="$TMPDIR_TEST/target-dependabot"
mkdir -p "$TARGET/.github"
echo "dependabot-config" > "$TARGET/.github/dependabot.yml"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_not_exists "dependabot.yml removed" "$TARGET/.github/dependabot.yml"
assert_file_exists "workflow still created" "$TARGET/.github/workflows/renovate.yml"

# --- Test: no error when dependabot.yml absent ---
echo "Test: no error when dependabot.yml absent"
TARGET="$TMPDIR_TEST/target-no-dependabot"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_eq "exits successfully" "0" "$?"

# --- Test: idempotent — running twice overwrites cleanly ---
echo "Test: idempotent run"
TARGET="$TMPDIR_TEST/target-idempotent"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
"$SCRIPT" "$CONFIG_DIR" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_exists "workflow still present after second run" "$TARGET/.github/workflows/renovate.yml"
CONTENT=$(cat "$TARGET/.github/workflows/renovate.yml")
assert_eq "content unchanged after second run" "fake-workflow-content" "$CONTENT"

echo "Test: @main reference is pinned without an obsolete branch label"
CONFIG_DIR_PIN="$TMPDIR_TEST/config-pin"
mkdir -p "$CONFIG_DIR_PIN/files"
cat > "$CONFIG_DIR_PIN/files/renovate-caller.yml" << 'EOF'
uses: StackVista/renovate-config/.github/workflows/renovate.yml@main
EOF
PIN_SHA="$EXPECTED_SHA"
TARGET="$TMPDIR_TEST/target-pin"
mkdir -p "$TARGET"
"$SCRIPT" "$CONFIG_DIR_PIN" "$TARGET" "$PIN_SHA" > /dev/null
assert_file_contains "@main replaced with full SHA" \
  "StackVista/renovate-config/.github/workflows/renovate.yml@${PIN_SHA}" \
  "$TARGET/.github/workflows/renovate.yml"
assert_eq "untagged revision has no branch label" "0" \
  "$(grep -c '# main' "$TARGET/.github/workflows/renovate.yml" || true)"

echo "Test: release labels follow the selected revision"
CONFIG_DIR_TAG="$TMPDIR_TEST/config-tag"
mkdir -p "$CONFIG_DIR_TAG/files"
git -C "$CONFIG_DIR_TAG" init --quiet
git -C "$CONFIG_DIR_TAG" fetch --quiet --depth=1 "$SCRIPT_DIR" "$EXPECTED_SHA"
git -C "$CONFIG_DIR_TAG" tag v9.9.9 "$EXPECTED_SHA"
cp "$SCRIPT_DIR/files/renovate-caller.yml" "$CONFIG_DIR_TAG/files/renovate-caller.yml"
TARGET="$TMPDIR_TEST/target-tag"
"$SCRIPT" "$CONFIG_DIR_TAG" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_contains "tag label matches the pinned revision" \
  "StackVista/renovate-config/.github/workflows/renovate.yml@${EXPECTED_SHA} # v9.9.9" \
  "$TARGET/.github/workflows/renovate.yml"
OTHER_SHA=1111111111111111111111111111111111111111
"$SCRIPT" "$CONFIG_DIR_TAG" "$TARGET" "$OTHER_SHA" > /dev/null
assert_file_contains "explicit revision replaces the template pin" \
  "StackVista/renovate-config/.github/workflows/renovate.yml@${OTHER_SHA}" \
  "$TARGET/.github/workflows/renovate.yml"
assert_eq "untagged revision has no release label" "0" \
  "$(grep -c '# v[0-9]' "$TARGET/.github/workflows/renovate.yml" || true)"

echo "Test: deploy fetch restores tags missing from a shallow checkout"
CONFIG_DIR_SHALLOW="$TMPDIR_TEST/config-shallow"
mkdir -p "$CONFIG_DIR_SHALLOW/files"
git -C "$CONFIG_DIR_SHALLOW" init --quiet
git -C "$CONFIG_DIR_SHALLOW" remote add origin "$CONFIG_DIR_TAG"
git -C "$CONFIG_DIR_SHALLOW" fetch --quiet --no-tags --depth=1 origin "$EXPECTED_SHA"
cp "$SCRIPT_DIR/files/renovate-caller.yml" "$CONFIG_DIR_SHALLOW/files/renovate-caller.yml"
assert_eq "shallow checkout initially has no tags" "" \
  "$(git -C "$CONFIG_DIR_SHALLOW" tag --list)"
git -C "$CONFIG_DIR_SHALLOW" fetch --quiet --tags --depth=1 origin "$EXPECTED_SHA"
TARGET="$TMPDIR_TEST/target-shallow"
"$SCRIPT" "$CONFIG_DIR_SHALLOW" "$TARGET" "$EXPECTED_SHA" > /dev/null
assert_file_contains "fetched release tag labels the selected commit" \
  "StackVista/renovate-config/.github/workflows/renovate.yml@${EXPECTED_SHA} # v9.9.9" \
  "$TARGET/.github/workflows/renovate.yml"

echo "Test: actual checkout revision is the default"
TARGET="$TMPDIR_TEST/target-default-sha"
"$SCRIPT" "$SCRIPT_DIR" "$TARGET" > /dev/null
assert_file_contains "default revision comes from the config checkout" "$EXPECTED_SHA" "$TARGET/.github/workflows/renovate.yml"
echo "dependabot-config" > "$TARGET/.github/dependabot.yaml"
"$SCRIPT" "$SCRIPT_DIR" "$TARGET" > /dev/null
assert_file_not_exists "dependabot.yaml removed" "$TARGET/.github/dependabot.yaml"

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
