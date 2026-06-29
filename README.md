# renovate-config

Shared Renovate Bot presets and a reusable GitHub Actions workflow for automated dependency updates across all StackVista repositories.

## Contents

| File | Purpose |
|------|---------|
| `default.json` | Org-wide default preset (extends by all repos) |
| `go.json` | Go module dependencies and toolchain preset |
| `docker.json` | Docker base image preset |
| `node.json` | Node/npm ecosystem preset |
| `java.json` | Java/Maven/Gradle/SBT preset |
| `files/renovate-caller.yml` | Caller workflow template copied to target repos |
| `.github/workflows/renovate.yml` | Reusable workflow called by all repos |
| `.github/workflows/deploy.yml` | One-click onboarding for new repos |
| `.github/workflows/self-renovate.yml` | Keeps this repo's own deps updated |

## Installing Renovate into a Repository

1. Add the target repository to the **`renovate-update-app`** GitHub App installation (Settings → Developer settings → GitHub Apps → `renovate-update-app` → Repository access).
2. Go to **Actions → Deploy Renovate to repo** in this repository.
3. Click **Run workflow** and fill in:
   - **repository** — e.g. `StackVista/my-repo`
   - **ecosystems** — comma-separated preset names: `go`, `docker`, `node`, `java` (any combination)
   - **base_branch** — default branch of the target repo (default: `main`)
4. The workflow opens a PR (`chore/onboard-renovate`) in the target repo with `renovate.json` and `.github/workflows/renovate.yml` pre-configured.
5. Review and merge the PR. Renovate runs on its next scheduled trigger.

`RENOVATE_GH_APP_CLIENT_ID` (org variable) and `RENOVATE_GH_APP_PRIVATE_KEY` (org secret) are inherited automatically by all repos in the StackVista org — no per-repo setup is needed.

## Presets

### `default.json`

Applied to every repo. Inherits `config:recommended` and layers these policies:

- **14-day minimum release age** — new versions must be published for 14 days before Renovate proposes them
- **Security bypass** — vulnerability patches skip the 14-day wait and are grouped into a dedicated security PR
- **Patch + minor grouping** — all non-security patch and minor updates batched into one PR
- **Rate limits** — max 10 concurrent PRs, 5 per hour
- **OSV vulnerability alerts** — enabled
- **Regex custom manager** — picks up version variables annotated with `# renovate:` comments in Dockerfiles, Makefiles, shell scripts, and workflow YAML:

  ```dockerfile
  # renovate: datasource=github-releases depName=foo/bar
  ARG MY_TOOL_VERSION=1.2.3
  ```

### `go.json`

- Groups Go module dependencies, Go toolchain, and Go tool entries into separate PRs
- Runs `go mod tidy` after every update

### `docker.json`

- Groups all `FROM` line updates (Dockerfile and docker-compose) into one PR

### `node.json`

- Groups npm packages, NVM/nodenv/mise toolchain entries, and the `node` dep into separate PRs

### `java.json`

- Groups Maven, Gradle, and SBT dependencies into one PR

## Overriding Configuration

Add repo-specific overrides in `renovate.json` alongside the `extends` list. Renovate merges them in order: shared preset first, repo-level overrides win.

### Allow post-upgrade commands

Post-upgrade commands must be whitelisted in both places: `renovate.json` and the caller workflow.

`renovate.json`:
```json
{
  "extends": [
    "local>StackVista/renovate-config",
    "local>StackVista/renovate-config:go"
  ],
  "postUpgradeTasks": {
    "commands": ["bash tools/regen-mocks.sh '{{depName}}' '{{newVersion}}'"],
    "fileFilters": ["**/*.go"]
  }
}
```

`.github/workflows/renovate.yml` (the `with:` block):
```yaml
    uses: StackVista/renovate-config/.github/workflows/renovate.yml@<SHA> # main
    with:
      allowed_commands: >-
        ["^bash tools/regen-mocks\\.sh '.*' '.*'$"]
    secrets:
      RENOVATE_GH_APP_PRIVATE_KEY: ${{ secrets.RENOVATE_GH_APP_PRIVATE_KEY }}
```

### Authenticate a private Docker registry

Up to 5 registry slots are available. Credentials can come from secrets or (for the username) from workflow inputs.

`.github/workflows/renovate.yml`:
```yaml
    uses: StackVista/renovate-config/.github/workflows/renovate.yml@<SHA> # main
    with:
      docker_registry_1: registry.tooling.stackstate.io
      docker_registry_1_username: renovate-reader
    secrets:
      RENOVATE_GH_APP_PRIVATE_KEY: ${{ secrets.RENOVATE_GH_APP_PRIVATE_KEY }}
      DOCKER_REGISTRY_1_PASSWORD: ${{ secrets.REGISTRY_TOOLING_PASSWORD }}
```

### Exclude a dependency from updates

```json
{
  "extends": ["local>StackVista/renovate-config"],
  "packageRules": [
    {
      "matchDepNames": ["k8s.io/client-go"],
      "enabled": false
    }
  ]
}
```

### Allow minor updates for a specific package

```json
{
  "packageRules": [
    {
      "matchDepNames": ["golang.org/x/net"],
      "matchUpdateTypes": ["minor", "patch"]
    }
  ]
}
```

### Dry run (no PRs created)

Go to **Actions → Renovate** in the target repo, click **Run workflow**, and enable **Dry run**.

## Reusable Workflow Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `log_level` | string | `info` | Renovate log verbosity (`info`, `debug`) |
| `dry_run` | boolean | `false` | When true, Renovate analyses but creates no PRs |
| `allowed_commands` | string | `[]` | JSON array of regex patterns for permitted post-upgrade commands |
| `docker_registry_1..5` | string | `""` | Docker registry host for auth slot 1–5 |
| `docker_registry_N_username` | string | `""` | Username for slot N (overridden by `DOCKER_REGISTRY_N_USERNAME` secret if set) |

Required secret: `RENOVATE_GH_APP_PRIVATE_KEY`.
Optional secrets: `DOCKER_REGISTRY_N_PASSWORD` for slots 1–5.

## Zizmor Fix: Granting Access to this Repo

Zizmor fetches the content of referenced external workflow files to audit them. When a repo's workflow calls `StackVista/renovate-config/.github/workflows/renovate.yml`, Zizmor needs read access to this private repo. Without it, the audit fails.

Fix: generate a short-lived GitHub App token scoped to `renovate-config` and pass it as `GH_TOKEN`. The **`zizmor-gh-app`** GitHub App is already configured with the necessary permissions and credentials — `ZIZMOR_GH_APP_CLIENT_ID` (org variable) and `ZIZMOR_GH_APP_PRIVATE_KEY` (org secret) are available in all repos.

```yaml
name: Workflow Security Audit

on:
  pull_request:
    branches: [main]
    paths:
      - ".github/**"
      - "zizmor.yml"
  push:
    branches: [main]
    paths:
      - ".github/**"
      - "zizmor.yml"

concurrency:
  group: lint-workflows-${{ github.ref }}
  cancel-in-progress: true

jobs:
  zizmor:
    name: zizmor
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3
        id: app-token
        with:
          client-id: ${{ vars.ZIZMOR_GH_APP_CLIENT_ID }}
          private-key: ${{ secrets.ZIZMOR_GH_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: "renovate-config"
          permission-contents: read

      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Run zizmor security audit
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          pip install zizmor
          zizmor .
```

To allow Zizmor to read additional private repos, add their names to `repositories:` (comma-separated).

## Development

```bash
# Install Renovate (for config validation)
npm install -g renovate@latest

# Lint JSON syntax
make lint-json

# Validate presets with renovate-config-validator
make validate-presets

# Run unit tests for deployment scripts
make unit-test

# Run all checks
make test
```

Tests live in `tests/` — fixtures in `tests/fixtures/`, script unit tests in `tests/scripts/`.
