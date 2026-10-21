#!/usr/bin/env bash
set -euo pipefail

# Generate a renovate.json file from a comma-separated list of ecosystem presets.
#
# Usage: scripts/generate-renovate-config.sh <ecosystems> <output-file>
#   ecosystems   — comma-separated preset names (e.g. "go,docker,node")
#   output-file  — path to write the generated renovate.json

if [ $# -lt 2 ]; then
  echo "Usage: $0 <ecosystems> <output-file>" >&2
  exit 1
fi

ECOSYSTEMS="$1"
OUTPUT_FILE="$2"

CONFIG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_SHA="${3:-$(git -C "$CONFIG_DIR" rev-parse HEAD)}"
if [[ ! "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Config revision must be a full commit SHA" >&2
  exit 1
fi
CONFIG_TAG="$(git -C "$CONFIG_DIR" describe --tags --exact-match "$CONFIG_SHA" 2>/dev/null || true)"
CONFIG_REF="$CONFIG_SHA"
if [[ "$CONFIG_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  CONFIG_REF="$CONFIG_TAG"
fi
EXTENDS="\"github>StackVista/renovate-config#${CONFIG_REF}\""

IFS=',' read -ra PRESETS <<< "$ECOSYSTEMS"
for preset in "${PRESETS[@]}"; do
  preset=$(echo "$preset" | xargs) # trim whitespace
  if [ -n "$preset" ]; then
    if [[ ! "$preset" =~ ^(go|docker|node|java|automerge)$ ]]; then
      echo "Unknown ecosystem preset" >&2
      exit 1
    fi
    EXTENDS="$EXTENDS, \"github>StackVista/renovate-config:$preset#${CONFIG_REF}\""
  fi
done

cat > "$OUTPUT_FILE" << EOF
{
  "\$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [$EXTENDS]
}
EOF

jq --slurpfile updates "$CONFIG_DIR/files/release-updates.json" \
  '. + $updates[0]' "$OUTPUT_FILE" > "$OUTPUT_FILE.tmp"
mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"

echo "Generated $OUTPUT_FILE with ecosystems: $ECOSYSTEMS"
