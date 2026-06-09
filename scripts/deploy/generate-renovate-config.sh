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

EXTENDS='"local>StackVista/renovate-config"'

IFS=',' read -ra PRESETS <<< "$ECOSYSTEMS"
for preset in "${PRESETS[@]}"; do
  preset=$(echo "$preset" | xargs) # trim whitespace
  if [ -n "$preset" ]; then
    EXTENDS="$EXTENDS, \"local>StackVista/renovate-config:$preset\""
  fi
done

cat > "$OUTPUT_FILE" << EOF
{
  "\$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [$EXTENDS]
}
EOF

# Normalize with jq if available
if command -v jq &> /dev/null; then
  jq . "$OUTPUT_FILE" > "$OUTPUT_FILE.tmp" && mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"
fi

echo "Generated $OUTPUT_FILE with ecosystems: $ECOSYSTEMS"
