const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const renovate = process.argv[2] ?? path.dirname(fs.realpathSync(
  execFileSync('which', ['renovate-config-validator'], { encoding: 'utf8' }).trim(),
));
const { getConfig } = require(path.join(renovate, 'config/defaults.js'));
const { mergeChildConfig } = require(path.join(renovate, 'config/utils.js'));
const { resolveConfigPresets } = require(path.join(renovate, 'config/presets/index.js'));
const { applyPackageRules } = require(path.join(renovate, 'util/package-rules/index.js'));
const { getDatasourceFor, getDefaultVersioning } = require(path.join(renovate, 'modules/datasource/common.js'));
const { get: getVersioning } = require(path.join(renovate, 'modules/versioning/index.js'));
const { lookupUpdates } = require(path.join(renovate, 'workers/repository/process/lookup/index.js'));
const { filterInternalChecks } = require(path.join(renovate, 'workers/repository/process/lookup/filter-checks.js'));
const { flattenUpdates } = require(path.join(renovate, 'workers/repository/updates/flatten.js'));
const { branchifyUpgrades } = require(path.join(renovate, 'workers/repository/updates/branchify.js'));
const { sortBranches } = require(path.join(renovate, 'workers/repository/process/sort.js'));
const { Vulnerabilities } = require(path.join(renovate, 'workers/repository/process/vulnerabilities.js'));
const repo = path.resolve(__dirname, '..');
require(path.join(renovate, 'config/global.js')).GlobalConfig.set({ platform: 'github', localDir: repo });
const read = name => JSON.parse(fs.readFileSync(path.join(repo, name)));

function dependency(name, type = 'require', datasource = 'go') {
  return { depName: name, packageName: name, depType: type, datasource, currentValue: 'v1.0.0', currentVersion: 'v1.0.0' };
}

function update(type, security = {}) {
  const version = type === 'major' ? 'v2.0.0' : type === 'minor' ? 'v1.1.0' : 'v1.0.1';
  return { updateType: type, newVersion: version, newValue: version, newMajor: type === 'major' ? 2 : 1, ...security };
}

async function main() {
  const fixture = read('tests/fixtures/go-docker-automerge.json');
  const { config: recommended } = await resolveConfigPresets({ extends: ['config:recommended'] });
  async function compose(presets) {
    let config = mergeChildConfig(getConfig(), recommended);
    for (const preset of ['default', ...presets]) {
      config = mergeChildConfig(config, { ...read(`${preset}.json`), extends: [] });
    }
    return mergeChildConfig(config, { ...fixture, extends: [], semanticCommits: 'disabled' });
  }
  const presets = fixture.extends.slice(1).map(value => value.split(':')[1]);
  const config = await compose(presets);
  assert.equal(config.prConcurrentLimit, 0);
  assert.equal(config.prHourlyLimit, 5);
  assert.equal(config.osvVulnerabilityAlerts, true);
  assert.notEqual(config.vulnerabilityAlerts.enabled, false);
  const examples = [
    ['gomod', dependency('example.com/library'), 'patch', 'go-libraries', true],
    ['gomod', dependency('example.com/library'), 'minor', 'go-libraries', true],
    ['gomod', dependency('k8s.io/api'), 'minor', 'kubernetes-go-modules', false],
    ['gomod', dependency('sigs.k8s.io/controller-runtime'), 'patch', 'kubernetes-go-modules', true],
    ['gomod', dependency('github.com/aws/smithy-go'), 'minor', 'aws-go-modules', true],
    ['gomod', dependency('example.com/library'), 'digest', 'go-library-revisions', false],
    ['gomod', dependency('go', 'golang', 'golang-version'), 'patch', 'go-build-environment', true],
    ['gomod', dependency('go', 'toolchain', 'golang-version'), 'minor', 'go-toolchain', false],
    ['github-actions', dependency('actions/checkout', 'action', 'github-tags'), 'minor', 'github-actions', true],
    ['github-actions', dependency('actions/checkout', 'action', 'github-tags'), 'major', null, false],
    ['custom.regex', dependency('golangci/golangci-lint', undefined, 'github-releases'), 'patch', 'ci-tools', false],
    ['custom.regex', dependency('goreleaser/goreleaser', undefined, 'github-releases'), 'patch', 'go-build-environment', true],
    ['custom.regex', dependency('goreleaser/goreleaser', undefined, 'github-releases'), 'minor', 'ci-tools', false],
    ['dockerfile', dependency('registry.suse.com/bci/bci-base', 'final', 'docker'), 'patch', 'docker', true],
    ['docker-compose', dependency('registry.suse.com/bci/bci-base', undefined, 'docker'), 'pinDigest', 'docker', true],
    ['dockerfile', dependency('registry.suse.com/bci/bci-base', 'stage', 'docker'), 'digest', 'docker', true],
    ['dockerfile', dependency('registry.suse.com/bci/bci-base', 'final', 'docker'), 'minor', 'docker', false],
    ['dockerfile', dependency('docker/dockerfile', 'syntax', 'docker'), 'patch', 'dockerfile-frontend', false],
    ['custom.regex', dependency('registry.tooling.stackstate.io/quay/stackstate/goreleaser', undefined, 'docker'), 'digest', 'go-build-environment', true],
  ];
  const manual = await compose(['docker', 'go']);
  for (const [manager, dep, type, group, automerge] of examples) {
    const policy = await applyPackageRules({ ...config, ...dep, manager, ...update(type) });
    assert.equal(policy.groupSlug, group, dep.depName);
    assert.equal(policy.automerge, automerge, `${dep.depName} ${type}`);
    assert.equal(policy.rebaseWhen, automerge ? 'behind-base-branch' : 'conflicted', dep.depName);
    const withoutAutomerge = await applyPackageRules({ ...manual, ...dep, manager, ...update(type) });
    assert.equal(withoutAutomerge.automerge, false, dep.depName);
    assert.equal(withoutAutomerge.groupSlug, group, dep.depName);
    for (const security of [{ isVulnerabilityAlert: true }, { vulnerabilityFixVersion: 'v1.0.1' }]) {
      const alert = await applyPackageRules({ ...config, ...dep, manager, ...update(type, security) });
      assert.equal(alert.prPriority, 20, dep.depName);
      assert([null, '0 days'].includes(alert.minimumReleaseAge), dep.depName);
      assert.equal(alert.automerge, automerge, dep.depName);
    }
  }
  for (const preset of ['go', 'docker']) {
    const selection = await compose([preset]);
    assert(!selection.packageRules.some(rule => rule.automerge === true), preset);
    const action = await applyPackageRules({
      ...selection, ...dependency('actions/checkout', 'action', 'github-tags'), manager: 'github-actions', ...update('patch'),
    });
    assert.equal(action.minimumReleaseAge, '7 days');
    assert.equal(action.internalChecksFilter, 'strict');
  }
  for (const presets of [['go'], ['docker', 'go', 'automerge'], ['go', 'docker', 'automerge']]) {
    const selection = await compose(presets);
    for (const [newVersion, type, pending] of [['1.26.10', 'patch', false], ['1.27.3', 'minor', true]]) {
      const policy = await applyPackageRules({
        ...selection, ...dependency('go', undefined, 'golang-version'),
        manager: 'custom.regex', depType: undefined, packageFile: 'images/goreleaser/Dockerfile',
        currentValue: '1.26.9', currentVersion: '1.26.9',
        ...update(type), newValue: newVersion, newVersion,
      });
      const result = await filterInternalChecks(policy, getVersioning('semver'), type, [{
        version: newVersion, releaseTimestamp: new Date(Date.now() - 86400000).toISOString(),
      }]);
      assert.equal(result.pendingChecks, pending, `${presets} compiler ${type}`);
      assert.equal(policy.automerge, false);
    }
  }
  for (const [name, type, datasource, immediate, sourceUrl] of [
    ['example.com/library', 'require', 'go', false],
    ['actions/checkout', 'action', 'github-tags', false],
    ['go', 'golang', 'golang-version', true],
    ['registry.suse.com/bci/bci-base', 'final', 'docker', true],
    ['StackVista/stackstate-backup-cli', undefined, 'github-releases', true],
    ['StackVista/sts-toolbox', undefined, 'github-tags', true],
    ['stackvista/renovate-config/action', 'action', 'github-tags', true],
    ['github.com/StackVista/sts-toolbox', 'require', 'go', true],
    ['gitlab.com/stackvista/platform/library', 'require', 'go', true],
    ['example.com/owned-library', 'require', 'go', true, 'https://github.com/stackvista/library'],
    ['example.com/legacy-library', 'require', 'go', true, 'https://gitlab.com/stackvista/platform/library'],
    ['StackVista-other/tool', undefined, 'github-releases', false],
    ['github.com/StackVista-other/library', 'require', 'go', false],
    ['example.com/unowned-library', 'require', 'go', false, 'https://github.com/StackVista-other/library'],
    ['example.com/unowned-legacy-library', 'require', 'go', false, 'https://gitlab.com/stackvista-other/library'],
  ]) {
    const manager = datasource === 'docker' ? 'dockerfile' : type === 'action' ? 'github-actions'
      : datasource === 'go' || datasource === 'golang-version' ? 'gomod' : 'custom.regex';
    const policy = await applyPackageRules({ ...config, ...dependency(name, type, datasource), manager, sourceUrl, ...update('patch') });
    const versioning = getVersioning(policy.versioning ?? getDefaultVersioning(datasource));
    for (const age of [1, 8, undefined]) {
      const releaseTimestamp = age === undefined ? undefined : new Date(Date.now() - age * 86400000).toISOString();
      const result = await filterInternalChecks(policy, versioning, 'patch', [{ version: '1.0.1', releaseTimestamp }]);
      assert.equal(result.pendingChecks, !immediate && age !== 8, `${name} age=${age}`);
    }
  }
  for (const presets of [[], ['go'], ['docker', 'go', 'automerge'], ['go', 'docker', 'automerge'], ['node', 'java']]) {
    const selection = await compose(presets);
    for (const type of ['patch', 'minor', 'major', 'digest']) {
      const policy = await applyPackageRules({
        ...selection, ...dependency('StackVista/sts-toolbox', undefined, 'github-tags'), manager: 'custom.regex', ...update(type),
      });
      assert.equal(policy.minimumReleaseAge, '0 days', `${presets} ${type}`);
      assert.equal(policy.automerge, false, `${presets} ${type}`);
    }
    for (const name of [
      'quay.io/stackstate/tool', 'ghcr.io/stackvista/tool', 'stackstate/tool', 'docker.io/stackstate/tool',
      'registry.tooling.stackstate.io/quay/stackstate/tool', 'registry.tooling.stackstate.io/docker/stackstate/tool',
      'registry.tooling.stackstate.io/ghcr/stackvista/tool',
    ]) {
      const policy = await applyPackageRules({
        ...selection, ...dependency(name, 'final', 'docker'), manager: 'dockerfile', ...update('patch'),
      });
      assert.equal(policy.minimumReleaseAge, '0 days', `${presets} ${name}`);
    }
  }
  for (const name of [
    'quay.io/stackstate-other/tool', 'registry.tooling.stackstate.io/quay/prometheus/tool',
    'registry.tooling.stackstate.io/ghcr/stackvista-other/tool',
  ]) {
    const policy = await applyPackageRules({
      ...await compose(['go']), ...dependency(name, 'final', 'docker'), manager: 'dockerfile', ...update('patch'),
    });
    assert.equal(policy.minimumReleaseAge, '7 days', name);
  }
  getDatasourceFor('go').getReleases = async () => ({
    releases: [
      ['v1.0.0', '1.18.0'], ['v1.0.1', '1.25.0'], ['v1.1.0', '1.26.7'], ['v1.2.0', '1.27.0'],
    ].map(([version, go]) => ({ version, constraints: { '%goMod': [go] }, releaseTimestamp: '2020-01-01T00:00:00Z' })),
  });
  for (const depType of ['require', 'indirect', 'replace']) {
    const dep = dependency(`example.com/${depType}`, depType);
    const policy = await applyPackageRules({ ...config, ...dep, manager: 'gomod', packageFile: 'go.mod' });
    assert.equal(policy.enabled, true);
    const { val, err } = (await lookupUpdates(policy)).unwrap();
    assert.equal(err, undefined);
    assert.deepEqual(val.updates.map(value => value.newVersion).sort(), ['v1.0.1', 'v1.1.0']);
    const flattened = await flattenUpdates(config, { gomod: [{ packageFile: 'go.mod', deps: [{ ...dep, updates: val.updates }] }] });
    assert.equal(flattened.length, depType === 'indirect' ? 0 : 2);
    if (depType !== 'indirect') {
      assert.deepEqual(flattened.map(value => value.branchName).sort(), ['renovate/go-libraries', 'renovate/patch-go-libraries']);
    }
  }
  const families = [
    ['k8s.io/api', 'k8s.io/apimachinery', 'kubernetes-go-modules'],
    ['github.com/aws/aws-sdk-go-v2', 'github.com/aws/smithy-go', 'aws-go-modules'],
    ['github.com/Azure/azure-sdk-for-go/sdk/azcore', 'github.com/Azure/azure-sdk-for-go/sdk/azidentity', 'azure-go-modules'],
    ['go.opentelemetry.io/otel', 'go.opentelemetry.io/otel/trace', 'opentelemetry-go-modules'],
    ['golang.org/x/net', 'golang.org/x/sys', 'golang-x-go-modules'],
  ];
  const modules = { gomod: [{ packageFile: 'go.mod', deps: [
    ...families.flatMap(([first, second]) => [first, second]).map(name => ({ ...dependency(name), updates: [update('major')] })),
    { ...dependency('example.com/library'), updates: [update('patch'), update('minor'), update('major')] },
  ] }] };
  const { branches } = await branchifyUpgrades({ ...config, errors: [], warnings: [] }, modules);
  for (const [, , group] of families) {
    const branch = branches.find(value => value.branchName === `renovate/major-${group}`);
    assert.equal(branch.upgrades.length, 2, group);
    assert.equal(branch.automerge, false, group);
    assert.deepEqual(branch.labels, ['dependencies/major']);
  }
  sortBranches(branches);
  assert.equal(branches[0].updateType, 'patch');
  assert.equal(branches.at(-1).updateType, 'major');
  const osv = new Vulnerabilities({ getVulnerabilities: async (ecosystem, name) => [{
    id: 'GO-2099-0001', affected: [{ package: { ecosystem, name },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }],
  }] });
  for (const [name, depType] of [['example.com/indirect', 'indirect'], ['k8s.io/api', 'require']]) {
    const securityConfig = { ...config, packageRules: [...config.packageRules] };
    const packageFiles = { gomod: [{ packageFile: 'go.mod', deps: [{
      ...dependency(name, depType), updates: ['patch', 'minor', 'major'].map(type => update(type)),
    }] }] };
    await osv.appendVulnerabilityPackageRules(securityConfig, packageFiles);
    const alerts = await flattenUpdates(securityConfig, packageFiles);
    assert.equal(alerts.length, 3);
    for (const alert of alerts) {
      assert.equal(alert.isVulnerabilityAlert, true);
      assert.equal(alert.prPriority, 20);
      assert.equal(alert.minimumReleaseAge, null);
      assert.deepEqual(alert.labels, ['security']);
      assert.deepEqual([...new Set(alert.addLabels ?? [])], alert.updateType === 'major' ? ['dependencies/major'] : []);
      assert.equal(alert.automerge, alert.updateType === 'patch' || (alert.updateType === 'minor' && depType === 'indirect'));
    }
    const noMajors = {
      ...config,
      packageRules: [...config.packageRules, { matchUpdateTypes: ['major'], enabled: false }],
    };
    await osv.appendVulnerabilityPackageRules(noMajors, packageFiles);
    const allowedAlerts = await flattenUpdates(noMajors, packageFiles);
    assert.deepEqual(allowedAlerts.map(alert => alert.updateType).sort(), ['minor', 'patch']);
    assert(allowedAlerts.every(alert => alert.isVulnerabilityAlert));
  }
  const ordinaryIndirect = await flattenUpdates(config, { gomod: [{ packageFile: 'go.mod', deps: [{
    ...dependency('example.com/indirect', 'indirect'),
    updates: ['major', 'minor', 'patch', 'digest', 'pin', 'pinDigest', 'rollback', 'replacement'].map(type => update(type)),
  }] }] });
  assert.deepEqual(ordinaryIndirect, []);
  for (const security of [{ isVulnerabilityAlert: true }, { vulnerabilityFixVersion: 'v1.0.1' }]) {
    const alerts = await flattenUpdates(config, { gomod: [{ packageFile: 'go.mod', deps: [{
      ...dependency('example.com/indirect', 'indirect'), updates: [update('patch', security)],
    }] }] });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].minimumReleaseAge, null);
    assert.equal(alerts[0].prPriority, 20);
  }
  const environment = await branchifyUpgrades({ ...config, errors: [], warnings: [] }, {
    gomod: [{ packageFile: 'go.mod', deps: [{
      ...dependency('go', 'golang', 'golang-version'), currentValue: '1.26.8', currentVersion: '1.26.8',
      updates: [{ ...update('patch'), newValue: '1.26.9', newVersion: '1.26.9' }],
    }] }],
    'custom.regex': [{ packageFile: 'Makefile', deps: [{
      ...dependency('registry.tooling.stackstate.io/quay/stackstate/goreleaser', undefined, 'docker'),
      currentValue: '2.18.0-so11', currentVersion: '2.18.0-so11', updates: [update('digest')],
    }] }],
  });
  assert.equal(environment.branches.length, 1);
  assert.equal(environment.branches[0].branchName, 'renovate/go-build-environment');
  assert.equal(environment.branches[0].automerge, true);
  const reversed = await compose(['go', 'docker', 'automerge']);
  const builderPolicy = await applyPackageRules({
    ...reversed, ...dependency('quay.io/stackstate/goreleaser', undefined, 'docker'),
    manager: 'dockerfile', ...update('patch'),
  });
  assert.equal(builderPolicy.groupSlug, 'go-build-environment');
  assert.equal(builderPolicy.automerge, true);
  const dockerFiles = types => ({ dockerfile: [{ packageFile: 'Dockerfile', deps: types.map((type, index) => ({
    ...dependency(`registry.suse.com/bci/image-${index}`, 'final', 'docker'), updates: [update(type)],
  })) }] });
  for (const [types, expected] of [[['patch', 'digest', 'pinDigest'], true], [['patch', 'minor'], false]]) {
    const result = await branchifyUpgrades({ ...config, errors: [], warnings: [] }, dockerFiles(types));
    assert.equal(result.branches.length, 1);
    assert.equal(result.branches[0].automerge, expected);
  }
  const bci = await applyPackageRules({ ...config, ...dependency('registry.suse.com/bci/bci-base', 'final', 'docker'), manager: 'dockerfile' });
  assert.equal(bci.pinDigests, true);
  assert.equal(bci.versioning, 'loose');
  assert.equal(getVersioning(bci.versioning).getMajor('15.7.35.2'), 15);
  const builder = await applyPackageRules({
    ...config, ...dependency('quay.io/stackstate/goreleaser', undefined, 'docker'), manager: 'custom.regex',
  });
  assert(getVersioning(builder.versioning).isValid('2.18.0-so11'));
  console.log('PASS: manual and optional automerge compositions, family groups, Go bounds, advisory-only indirect updates, release age, labels and mixed image groups');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
