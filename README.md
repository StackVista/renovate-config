# renovate-config

Shared Renovate Bot presets and a reusable GitHub Actions workflow for automated dependency updates across all StackVista repositories.

## Contents

| File | Purpose |
|------|---------|
| `default.json` | Org-wide default preset (extends by all repos) |
| `go.json` | Go module dependencies and toolchain preset |
| `docker.json` | Docker base image preset |
| `automerge.json` | Optional automatic merging after required checks and App approval |
| `node.json` | Node/npm ecosystem preset |
| `java.json` | Java/Maven/Gradle/SBT preset |
| `files/renovate-caller.yml` | Caller workflow template copied to target repos |
| `files/release-updates.json` | Consumer rule grouping preset tags with workflow and action pins |
| `.github/workflows/renovate.yml` | Reusable workflow called by all repos |
| `.github/workflows/deploy.yml` | One-click onboarding for new repos |
| `.github/workflows/self-renovate.yml` | Keeps this repo's own deps updated |
| [`.github/actions/auto-approve-renovate`](.github/actions/auto-approve-renovate/README.md) | Shared App approval for verified Renovate PRs |

## Installing Renovate into a Repository

The deploy workflow prepares consumer files; it does not provision App access or repository settings.
Pin shared presets to release tags using `github>`, for example `github>StackVista/renovate-config:go#v1.0.0`.
Pin reusable workflows and approval actions to the release's full commit SHA with the tag in the trailing comment.
Use a release tag when running the deploy workflow. Renovate's built-in `renovate-config` manager updates preset tags.
The generated consumer rule groups preset, workflow and approval-action updates in one PR that requires human review.
Untagged development checkouts use SHA preset references that require manual updates.

1. Add the target repository to the updater GitHub App installation.
2. Go to **Actions → Deploy Renovate to repo** in this repository.
3. Click **Run workflow** and fill in:
   - **repository** — e.g. `StackVista/my-repo`
   - **ecosystems** — comma-separated preset names: `go`, `docker`, `node`, `java` (any combination)
   - **base_branch** — default branch of the target repo (default: `main`)
4. The workflow opens a PR (`chore/onboard-renovate`) in the target repo with `renovate.json` and `.github/workflows/renovate.yml` pre-configured.
5. Configure the target repository and App access before merging the consumer PR. Renovate runs on its next scheduled trigger.

Check App installation access and the visibility of `RENOVATE_GH_APP_CLIENT_ID` and `RENOVATE_GH_APP_PRIVATE_KEY` for the target repository. The updater App needs commit-status write access and Dependabot-alert read access. Explicit token permission inputs must retain these grants.

## Presets

### `default.json`

Applied to every repo. Inherits `config:recommended` and layers these policies:

- **No release-age delay** — `minimumReleaseAge: "0 days"` disables waiting and lets Renovate clear existing pending stability checks on its next run. Using `null` can leave those old checks pending. Consumers can override the shared policy explicitly.
- **StackVista-owned dependencies** — repository URLs and package namespaces bypass release-age delays, including those inherited from ecosystem presets. This covers internal releases, actions, Go modules and images, including legacy GitLab sources and proxied images.
- **Human merges by default** — ecosystem presets do not enable automatic merging. Add `:automerge` separately after configuring required checks and the approval App.
- **Vulnerability alerts** — GitHub alerts use Renovate's enabled default and OSV is enabled explicitly. Known fixes bypass the release-age delay and have priority 20. Avoid forcing `vulnerabilityAlerts.enabled: true`, which overrides consumer disabling rules.
- **Grouping** — patch and minor updates share a fallback group. Ecosystem and GitHub Actions rules replace it with specific groups.
- **Priorities and labels** — patches have priority 10. Majors have priority -1 and use `dependencies/major` instead of `dependencies`. Security majors also keep `security`.
- **Rate limits** — no concurrent PR cap, with five new PRs per hour.
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

  This manager is included in `default.json` and is active automatically in any repo extending `github>StackVista/renovate-config#v1.0.0` — no per-repo setup required. It covers Dockerfiles, Makefiles, `scripts/*.sh`, and `.github/**/*.yml`. If your repo has version variables in other file types (e.g. `versions.yaml`, `*.mk`), add a `customManagers` entry to your `renovate.json` targeting those paths.

### `go.json`

- Separates library patches from minors. Kubernetes and AWS modules have family groups.
- Groups major migrations for Kubernetes, AWS, Azure, OpenTelemetry and `golang.org/x`. Other majors remain individual.
- Keeps indirect lookups enabled for advisories, but suppresses ordinary independent indirect updates.
- Waits seven days for third-party routine releases, including candidates with missing timestamps. StackVista-owned dependencies and known vulnerability fixes bypass this delay.
- Applies strict Go requirement filtering with range-aware `%goMod` constraints.
- Groups compiler patches with GoReleaser patches and GoReleaser or BCI Go builder-image refreshes, including registry proxy paths, without a release-age delay.
- Runs `go mod tidy` after updates.

Consumers must supply their approved compiler bounds. Keep toolchain downloads disabled in CI and check the compiler embedded in released binaries. Dependency-specific bounds, such as coupled kops/cloud modules or delegated kube-openapi revisions, remain local.

### `docker.json`

- Groups ordinary image inputs and pins Dockerfile and Compose manifest digests.
- Compares full SUSE BCI tags and numeric `-so` rebuild tags for the shared GoReleaser image.
- Separates Dockerfile frontend updates from base images.
- Applies no release-age delay to images.

Consumers retain full release tags and set approved operating-system and runtime bounds. Custom tag formats, registry credentials, checksums and post-upgrade commands remain local.

`docker-images` is an exception: it builds many independent images. Keep its per-image groups, release bounds, branch names and metadata/publication overrides in that repository.

### `automerge.json`

This preset opts into PR automerge through GitHub after required checks and App approval.
Eligible updates include library patches and minors, compiler patches, compatible GitHub Actions references, GoReleaser patches and image patch/digest/pinDigest updates.
Kubernetes minors, all majors, Go module revisions, other CI tools and Dockerfile frontends require human review.
Automatic groups refresh behind the base branch; manual groups rebase on conflicts.

Include the base preset, selected ecosystem presets, then `:automerge`.
Consumer overrides come last. For example:

```json
{
  "extends": [
    "github>StackVista/renovate-config#v1.0.0",
    "github>StackVista/renovate-config:docker#v1.0.0",
    "github>StackVista/renovate-config:go#v1.0.0",
    "github>StackVista/renovate-config:automerge#v1.0.0"
  ],
  "packageRules": [
    {
      "matchManagers": ["gomod"],
      "matchDepTypes": ["golang", "toolchain"],
      "allowedVersions": "/^1\\.26\\./"
    },
    {
      "matchManagers": ["gomod"],
      "matchDepTypes": ["require", "indirect", "replace"],
      "constraints": {"%goMod": "<1.27.0"}
    },
    {
      "matchDatasources": ["docker"],
      "matchPackageNames": ["registry.suse.com/bci/bci-base"],
      "allowedVersions": "/^15\\.7\\./"
    }
  ]
}
```

These bounds are examples. Choose the compiler and operating-system lines approved for the consumer.
Omit `:automerge` to retain human merges with the same selection and grouping policy.

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
    "github>StackVista/renovate-config#v1.0.0",
    "github>StackVista/renovate-config:go#v1.0.0"
  ],
  "postUpgradeTasks": {
    "commands": ["bash tools/regen-mocks.sh '{{depName}}' '{{newVersion}}'"],
    "fileFilters": ["**/*.go"]
  }
}
```

`.github/workflows/renovate.yml` (the `with:` block):
```yaml
    uses: StackVista/renovate-config/.github/workflows/renovate.yml@<SHA> # v1.0.0
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
    uses: StackVista/renovate-config/.github/workflows/renovate.yml@<SHA> # v1.0.0
    with:
      docker_registry_1: registry.example.com
      docker_registry_1_username: renovate-reader
    secrets:
      RENOVATE_GH_APP_PRIVATE_KEY: ${{ secrets.RENOVATE_GH_APP_PRIVATE_KEY }}
      DOCKER_REGISTRY_1_PASSWORD: ${{ secrets.PRIVATE_REGISTRY_PASSWORD }}
```

### Prevent major updates for a specific dependency

The shared preset allows major updates for human review. To block a dependency's major version bumps:

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

Go library patches and minors already have separate groups. A consumer can select both update types for a package-specific rule:

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

Renovate applies grouping rules in order; the last matching rule wins. To change a dependency's group, add a consumer rule:

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

Tests live in `tests/`: config fixtures, deployment script tests and `policy.cjs`.
The policy checks load local presets and use the installed Renovate engine for lookup, advisory rules and branch generation.
They cover manual and automerge compositions, compiler bounds, indirect filtering, release-age checks, family grouping and mixed image groups.
