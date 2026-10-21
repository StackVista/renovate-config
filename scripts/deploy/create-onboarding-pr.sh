#!/usr/bin/env bash
set -euo pipefail

# Create an onboarding PR in a target repo that has been prepared by
# generate-renovate-config.sh and setup-target-repo.sh.
#
# Commits are created via the GitHub git data API so they are signed
# (verified) by GitHub — required when branch protection enforces signed commits.
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

BRANCH="chore/onboard-renovate"

# --- Get base branch commit SHA and tree SHA ---
BASE_SHA=$(gh api "repos/${REPOSITORY}/git/ref/heads/${BASE_BRANCH}" --jq '.object.sha')
BASE_TREE_SHA=$(gh api "repos/${REPOSITORY}/git/commits/${BASE_SHA}" --jq '.tree.sha')

# --- Create a blob for a local file and return its SHA ---
create_blob() {
  local file="$1"
  local content
  content=$(base64 -w 0 "$file")
  gh api "repos/${REPOSITORY}/git/blobs" \
    --method POST \
    --input <(jq -n --arg content "$content" '{encoding: "base64", content: $content}') \
    --jq '.sha'
}

RENOVATE_JSON_SHA=$(create_blob "${TARGET_DIR}/renovate.json")
RENOVATE_WF_SHA=$(create_blob "${TARGET_DIR}/.github/workflows/renovate.yml")

# --- Build tree entries ---
TREE_ENTRIES=$(jq -n \
  --arg rj "$RENOVATE_JSON_SHA" \
  --arg rw "$RENOVATE_WF_SHA" \
  '[
    {"path": "renovate.json",                     "mode": "100644", "type": "blob", "sha": $rj},
    {"path": ".github/workflows/renovate.yml",    "mode": "100644", "type": "blob", "sha": $rw}
  ]')

for file in .github/dependabot.yml .github/dependabot.yaml; do
  if gh api "repos/${REPOSITORY}/contents/${file}" --silent 2>/dev/null; then
    echo "Scheduling removal of ${file}"
    TREE_ENTRIES=$(jq -c --arg path "$file" \
      '. + [{"path": $path, "mode": "100644", "type": "blob", "sha": null}]' \
      <<< "$TREE_ENTRIES")
  fi
done

# --- Create tree ---
NEW_TREE_SHA=$(gh api "repos/${REPOSITORY}/git/trees" \
  --method POST \
  --input <(jq -n \
    --arg base_tree "$BASE_TREE_SHA" \
    --argjson tree "$TREE_ENTRIES" \
    '{base_tree: $base_tree, tree: $tree}') \
  --jq '.sha')

# --- Create signed commit via API ---
COMMIT_MESSAGE="chore: onboard Renovate automated dependency updates

Adds shared Renovate config extending StackVista/renovate-config presets
and a caller workflow that runs on schedule.

Ecosystems: ${ECOSYSTEMS}"

NEW_COMMIT_SHA=$(gh api "repos/${REPOSITORY}/git/commits" \
  --method POST \
  --input <(jq -n \
    --arg message "$COMMIT_MESSAGE" \
    --arg tree "$NEW_TREE_SHA" \
    --arg parent "$BASE_SHA" \
    '{message: $message, tree: $tree, parents: [$parent]}') \
  --jq '.sha')

# --- Create or update branch ref ---
if gh api "repos/${REPOSITORY}/git/ref/heads/${BRANCH}" --silent 2>/dev/null; then
  echo "Branch ${BRANCH} already exists — updating to new commit."
  gh api "repos/${REPOSITORY}/git/refs/heads/${BRANCH}" \
    --method PATCH \
    --field sha="$NEW_COMMIT_SHA" \
    --field force:=true
else
  gh api "repos/${REPOSITORY}/git/refs" \
    --method POST \
    --field "ref=refs/heads/${BRANCH}" \
    --field sha="$NEW_COMMIT_SHA"
fi

# --- Create PR (skip if one already exists for this branch) ---
EXISTING_PR=$(gh pr list --repo "$REPOSITORY" --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [[ -n "$EXISTING_PR" ]]; then
  echo "PR #${EXISTING_PR} already exists for branch ${BRANCH} — skipping PR creation."
  exit 0
fi

gh pr create \
  --repo "$REPOSITORY" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH" \
  --title "chore: onboard Renovate automated dependency updates" \
  --body "$(cat <<EOF
## Summary

- Adds \`renovate.json\` extending shared StackVista presets ($ECOSYSTEMS)
- Adds \`.github/workflows/renovate.yml\` caller workflow (runs every 6 hours)
- Removes Dependabot update configuration if present

Presets: \`local>StackVista/renovate-config\`, ecosystems: \`$ECOSYSTEMS\`

See [StackVista/renovate-config](https://github.com/StackVista/renovate-config) for preset details.
EOF
)"
