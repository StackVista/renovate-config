#!/usr/bin/env bash
set -euo pipefail

# Prepare a target repo checkout for Renovate onboarding:
#   - copies the caller workflow template
#   - removes dependabot.yml if present
#
# Usage: scripts/setup-target-repo.sh <config-dir> <target-dir>
#   config-dir  — path to the renovate-config checkout (contains files/)
#   target-dir  — path to the target repo checkout

if [ $# -lt 2 ]; then
  echo "Usage: $0 <config-dir> <target-dir>" >&2
  exit 1
fi

CONFIG_DIR="$1"
TARGET_DIR="$2"

CALLER_TEMPLATE="$CONFIG_DIR/files/renovate-caller.yml"
if [ ! -f "$CALLER_TEMPLATE" ]; then
  echo "Error: caller template not found at $CALLER_TEMPLATE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR/.github/workflows"
cp "$CALLER_TEMPLATE" "$TARGET_DIR/.github/workflows/renovate.yml"
echo "Copied workflow caller to $TARGET_DIR/.github/workflows/renovate.yml"

if [ -f "$TARGET_DIR/.github/dependabot.yml" ]; then
  rm -f "$TARGET_DIR/.github/dependabot.yml"
  echo "Removed $TARGET_DIR/.github/dependabot.yml"
fi
