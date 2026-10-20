# Working in renovate-config

This repository owns shared Renovate presets, the reusable runner, the approval action and consumer file generation.
Preserve consumer overrides when changing shared behavior.
Use an issue-linked branch and PR for source changes, with signed commits and short subjects.
Keep secrets in environment variables; inspect credential names and references without printing their values.
Run local project tools through `mise exec --`.
Install missing tools through Mise.

The validation entry point is `make test`.
Existing policy tests use the Renovate engine; `RENOVATE_DIST` can identify its installed `dist` directory when a package-manager shim hides that path.
The runtime App token needs commit-status write access and Dependabot-alert read access.
Workflow `GITHUB_TOKEN` permissions do not grant App permissions.
