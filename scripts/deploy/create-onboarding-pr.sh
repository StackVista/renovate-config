#!/usr/bin/env bash
set -euo pipefail

# Create an onboarding PR in a target repo that has been prepared by
# generate-renovate-config.sh and setup-target-repo.sh.
#
# Usage: scripts/create-onboarding-pr.sh <target-dir> <repository> <base-branch> <ecosystems>
#   target-dir   — path to the prepared target repo checkout
#   repository   — full repo name (e.g. StackVista/repo-name)
#   base-branch  — base branch for the PR (e.g. main)
#   ecosystems   — ecosystem list for the commit message

if [ $# -lt 4 ]; then
  echo "Usage: $0 <target-dir> <repository> <base-branch> <ecosystems>" >&2
  exit 1
fi

TARGET_DIR="$1"
REPOSITORY="$2"
BASE_BRANCH="$3"
ECOSYSTEMS="$4"

cd "$TARGET_DIR"

BRANCH="chore/onboard-renovate"
git checkout -b "$BRANCH"
git add renovate.json .github/workflows/renovate.yml
git rm -f --ignore-unmatch .github/dependabot.yml

if git diff --cached --quiet; then
  echo "No changes to commit — Renovate may already be configured."
  exit 0
fi

git config user.name "stackvista-renovate[bot]"
git config user.email "stackvista-renovate[bot]@users.noreply.github.com"
git commit -m "chore: onboard Renovate automated dependency updates

Adds shared Renovate config extending StackVista/renovate-config presets
and a caller workflow that runs on schedule.

Ecosystems: $ECOSYSTEMS"

git push origin "$BRANCH"

gh pr create \
  --repo "$REPOSITORY" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH" \
  --title "chore: onboard Renovate automated dependency updates" \
  --body "$(cat <<EOF
## Summary

- Adds \`renovate.json\` extending shared StackVista presets ($ECOSYSTEMS)
- Adds \`.github/workflows/renovate.yml\` caller workflow (runs every 6 hours)
- Removes \`dependabot.yml\` if present

Presets: \`local>StackVista/renovate-config\`, ecosystems: \`$ECOSYSTEMS\`

See [StackVista/renovate-config](https://github.com/StackVista/renovate-config) for preset details.
EOF
)"
