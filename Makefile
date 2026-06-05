.PHONY: lint-json validate-presets unit-test test

# Lint JSON syntax of all preset and test fixture files
lint-json:
	@scripts/validate/lint-json.sh

# Validate presets and test fixtures using renovate-config-validator
validate-presets:
	@scripts/validate/validate-presets.sh

# Run unit tests for scripts
unit-test:
	@echo "Running unit tests..."
	@tests/scripts/test-generate-renovate-config.sh
	@tests/scripts/test-setup-target-repo.sh
	@echo ""
	@echo "All unit tests passed."

# Run all checks
test: lint-json validate-presets unit-test
