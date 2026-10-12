# Renovate auto-approval

This action approves PRs from `renovate-update-app[bot]` when that App has enabled native GitHub automerge.
It requires GitHub-verified Renovate commits and pins each new approval to the inspected head commit.
It does not inspect changed files or repeat CI checks.
GitHub branch protection and rulesets control merging.

Use the action in a scheduled or manually triggered job on the trusted default branch.
Pin the action to a reviewed commit SHA.
The caller needs `contents: read` and `pull-requests: read` permissions.
The runner needs Python 3 and the GitHub CLI; GitHub-hosted Ubuntu runners provide both.
No caller checkout is required.

Pass the dedicated approval App credentials through `app-client-id` and `app-private-key`.
Install that App on the caller repository with Contents write, Pull requests write and Metadata read access.
The action requests a token with only Pull requests write permission, scoped to that repository.
The installation needs write access so GitHub counts its reviews.
Keep the approval App separate from Renovate.

Example step:

```yaml
- name: Approve verified Renovate PRs
  uses: StackVista/renovate-config/.github/actions/auto-approve-renovate@FULL_COMMIT_SHA
  with:
    app-client-id: ${{ vars.RENOVATE_APPROVAL_GH_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.RENOVATE_APPROVAL_GH_APP_PRIVATE_KEY }}
```

The caller owns scheduling, concurrency and its default-branch guard.
The action bundles the approval policy and needs no token to fetch code from another repository.
Private action access and organization action policy must allow the caller to use `StackVista/renovate-config`.
