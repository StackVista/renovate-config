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

- **No release-age delay** — `minimumReleaseAge: "0 days"` disables waiting and lets Renovate clear existing pending stability checks on its next run. Using `null` can leave those old checks pending. Consumers can override the shared policy explicitly.
- **Human merges by default** — automatic merging is disabled; review and relevant CI determine readiness. Explicit consumer overrides remain possible. Any future automatic-merge policy needs its own safeguards.
- **Vulnerability alerts** — enabled without a release-age delay; the separate CVE process is unchanged.
- **Patch + minor grouping** — all non-security patch and minor updates batched into one PR
- **Rate limits** — max 10 concurrent PRs, 5 per hour
- **OSV vulnerability alerts** — enabled
- **Regex custom manager** — picks up version variables annotated with `# renovate:` comments in Dockerfiles, Makefiles, shell scripts, and workflow YAML. Two constraints apply:
  1. The annotation comment must be on the line immediately before the variable assignment.
  2. The variable name must contain `_VERSION` or `_version` (with underscore prefix — e.g. `MY_TOOL_VERSION`, `go_version`).

  Annotation syntax:
  ```
  # renovate: datasource=<datasource> depName=<depName> [packageName=<name>] [versioning=<scheme>] [extractVersion=<pattern>]
  <VAR_NAME containing _VERSION or _version>=<currentValue>
  ```

  `datasource` and `depName` are required. The optional fields:
  - `packageName` — when the registry package name differs from `depName`
  - `versioning` — version scheme to use (e.g. `semver`, `docker`, `regex`); defaults to datasource default
  - `extractVersion` — regex to extract the version string from the upstream tag

  Examples:

  ```dockerfile
  # Dockerfile — github-releases datasource
  # renovate: datasource=github-releases depName=cli/cli
  ARG GH_CLI_VERSION=2.49.0

  # shell script or Makefile — with explicit versioning scheme
  # renovate: datasource=docker depName=golang versioning=docker
  GO_VERSION=1.22.3

  # GitHub Actions workflow — packageName differs from depName
  # renovate: datasource=github-releases depName=aquasecurity/trivy packageName=aquasecurity/trivy
  TRIVY_VERSION: "0.50.1"
  ```

  > **Common mistake:** a variable named `MYTOOLVERSION` (no underscore before `VERSION`) will not be matched. Always use `MY_TOOL_VERSION` or `my_tool_version`.

  This manager is included in `default.json` and is active automatically in any repo extending `local>StackVista/renovate-config` — no per-repo setup required. It covers Dockerfiles, Makefiles, `scripts/*.sh`, and `.github/**/*.yml`. If your repo has version variables in other file types (e.g. `versions.yaml`, `*.mk`), add a `customManagers` entry to your `renovate.json` targeting those paths.

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

### Prevent major updates for a specific dependency

The shared preset allows patch and minor updates. To block major version bumps for a dependency that requires manual migration:

```json
{
  "packageRules": [
    {
      "matchDepNames": ["k8s.io/client-go"],
      "matchUpdateTypes": ["major"],
      "enabled": false
    }
  ]
}
```

To block major updates for an entire manager (e.g. all Go modules):

```json
{
  "packageRules": [
    {
      "matchManagers": ["gomod"],
      "matchUpdateTypes": ["major"],
      "enabled": false
    }
  ]
}
```

### Exclude a dependency from all updates

```json
{
  "packageRules": [
    {
      "matchDepNames": ["k8s.io/client-go"],
      "enabled": false
    }
  ]
}
```

### Pin to an exact version (ignore all updates)

Same as excluding, but the intent is to stay on a specific version intentionally. Add a comment in `renovate.json` so future maintainers understand why:

```json
{
  "packageRules": [
    {
      "matchDepNames": ["github.com/some/lib"],
      "enabled": false,
      "description": "Pinned at v1.2.3 — v2 requires API migration tracked in STAC-XXXXX"
    }
  ]
}
```

### Allow minor updates for a specific package

The shared preset groups patch and minor together. To explicitly allow minor updates for a package where you are comfortable with it (this is already the default behaviour, but useful to document alongside `matchUpdateTypes`):

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

### Dependency appears in the wrong PR group

Renovate's grouping rules are applied in order; the last matching rule wins. If a dependency lands in the wrong group (e.g. it gets grouped with security patches but it is not a CVE), add an explicit rule that overrides the group for that package:

```json
{
  "packageRules": [
    {
      "matchDepNames": ["github.com/some/noisy-lib"],
      "groupName": "all patch and minor dependencies",
      "groupSlug": "all-patch-minor"
    }
  ]
}
```

To completely remove a dependency from all grouping (it gets its own PR):

```json
{
  "packageRules": [
    {
      "matchDepNames": ["github.com/some/lib"],
      "groupName": null
    }
  ]
}
```

### Regex custom manager not picking up a variable

Check these in order:

1. **Variable name** — must contain `_VERSION` or `_version` with an underscore (e.g. `GO_VERSION`, `tool_version`). `GOVERSION` will not match.
2. **File type** — the manager covers Dockerfiles, `Makefile`, `scripts/*.sh`, and `.github/**/*.yml`. Variables in other files (e.g. `versions.yaml`) need an additional `customManagers` entry in `renovate.json`.
3. **Line adjacency** — the `# renovate:` annotation must be on the line directly above the variable assignment with no blank lines between them.
4. **Datasource name** — use the exact Renovate datasource identifier (e.g. `github-releases`, `docker`, `pypi`, `npm`). An invalid datasource causes Renovate to silently skip the match.

Use dry-run mode to diagnose without creating PRs.

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
