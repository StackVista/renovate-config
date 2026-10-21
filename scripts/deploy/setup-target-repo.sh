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

RENOVATE_CONFIG_SHA="${3:-$(git -C "$CONFIG_DIR" rev-parse HEAD)}"
if [[ ! "$RENOVATE_CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Config revision must be a full commit SHA" >&2
  exit 1
fi
CONFIG_TAG="$(git -C "$CONFIG_DIR" describe --tags --exact-match "$RENOVATE_CONFIG_SHA" 2>/dev/null || true)"
REVISION_LABEL=""
if [[ "$CONFIG_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  REVISION_LABEL=" # ${CONFIG_TAG}"
fi

mkdir -p "$TARGET_DIR/.github/workflows"
sed -E "s|StackVista/renovate-config/.github/workflows/renovate.yml@[^[:space:]]+([[:blank:]]+#.*)?|StackVista/renovate-config/.github/workflows/renovate.yml@${RENOVATE_CONFIG_SHA}${REVISION_LABEL}|g" \
  "$CALLER_TEMPLATE" > "$TARGET_DIR/.github/workflows/renovate.yml"
echo "Copied workflow caller to $TARGET_DIR/.github/workflows/renovate.yml (pinned to ${RENOVATE_CONFIG_SHA})"

for file in .github/dependabot.yml .github/dependabot.yaml; do
  if [ -f "$TARGET_DIR/$file" ]; then
    rm -f "$TARGET_DIR/$file"
    echo "Removed $file"
  fi
done
