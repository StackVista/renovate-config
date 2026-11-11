const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dist = process.argv[2] ?? path.dirname(fs.realpathSync(
  execFileSync('which', ['renovate-config-validator'], { encoding: 'utf8' }).trim(),
));
const load = file => require(path.join(dist, file));
const { getConfig } = load('config/defaults.js');
const { mergeChildConfig, getManagerConfig } = load('config/index.js');
const { resolveConfigPresets } = load('config/presets/index.js');
const { applyPackageRules } = load('util/package-rules/index.js');
const { getDatasourceFor } = load('modules/datasource/common.js');
const { lookupUpdates } = load('workers/repository/process/lookup/index.js');
const { branchifyUpgrades } = load('workers/repository/updates/branchify.js');
const { flattenUpdates } = load('workers/repository/updates/flatten.js');
const { doAutoReplace } = load('workers/repository/update/branch/auto-replace.js');
const { detectVulnerabilityAlerts } = load('workers/repository/init/vulnerability.js');
const { Vulnerabilities } = load('workers/repository/process/vulnerabilities.js');
const { setPlatformApi } = load('modules/platform/index.js');
const platformApis = load('modules/platform/api.js').default;
const sbt = load('modules/manager/sbt/index.js');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-java-'));
load('config/global.js').GlobalConfig.set({ platform: 'github', localDir: directory });
const read = name => JSON.parse(fs.readFileSync(path.join(root, `${name}.json`)));
const dep = (name, datasource = 'maven') => ({
  depName: name, packageName: name, datasource,
  versioning: load('modules/datasource/common.js').getDefaultVersioning(datasource),
  currentValue: '1.0.0', currentVersion: '1.0.0',
});
const update = type => ({
  updateType: type, newVersion: type === 'major' ? '2.0.0' : type === 'minor' ? '1.1.0' : '1.0.1',
  newValue: type === 'major' ? '2.0.0' : type === 'minor' ? '1.1.0' : '1.0.1',
  newMajor: type === 'major' ? 2 : 1,
  newMinor: type === 'minor' ? 1 : 0,
  newPatch: type === 'patch' ? 1 : 0,
});

async function main() {
  const { config: recommended } = await resolveConfigPresets({ extends: ['config:recommended'] });
  async function compose(names) {
    let config = mergeChildConfig(getConfig(), recommended);
    for (const name of ['default', 'java', ...names]) {
      config = mergeChildConfig(config, { ...read(name), extends: [] });
    }
    return mergeChildConfig(config, { semanticCommits: 'disabled', errors: [], warnings: [] });
  }
  const legacy = await compose([]);
  const config = await compose(['java-dashboard', 'java-automerge']);
  const patterns = getManagerConfig(config, 'sbt').managerFilePatterns;
  const matches = file => patterns.some(pattern => new RegExp(pattern.slice(1, -1)).test(file));
  for (const file of ['build.sbt', 'project/build.properties', 'project/Build.scala', 'project/src/main/scala/example/Dependencies.scala']) {
    assert(matches(file), `Missing file pattern for ${file}`);
  }
  assert(!matches('src/main/scala/example/App.scala'));

  const first = dep('com.fasterxml.jackson.core:jackson-core');
  const second = dep('com.fasterxml.jackson.core:jackson-databind');
  const unrelated = dep('commons-io:commons-io');
  getDatasourceFor('maven').getReleases = async () => ({
    releases: ['1.0.0', '1.0.1', '1.1.0', '2.0.0'].map(version => ({ version })),
  });
  getDatasourceFor('maven').postprocessRelease = async (_config, release) => release;
  const lookup = (await lookupUpdates(await applyPackageRules({ ...config, ...getManagerConfig(config, 'maven'), ...first, manager: 'maven' }))).unwrap();
  assert.equal(lookup.err, undefined);
  assert.deepEqual(lookup.val.updates.map(value => value.updateType).sort(), ['major', 'minor', 'patch']);
  const files = { maven: [{ packageFile: 'pom.xml', deps: [first, second, unrelated].map(value => ({
    ...value, updates: ['patch', 'minor', 'major'].map(update),
  })) }] };
  const { branches } = await branchifyUpgrades(config, files);
  assert.equal(branches.length, 7);
  assert.deepEqual(branches.filter(branch => branch.upgrades.length === 2).map(branch => branch.updateType).sort(), ['minor', 'patch']);
  for (const branch of branches) {
    assert.equal(branch.dependencyDashboardApproval, true);
    assert.equal(branch.automerge, branch.updateType !== 'major');
  }
  for (const type of ['patch', 'minor', 'major']) {
    const prior = await applyPackageRules({ ...legacy, ...first, manager: 'maven', ...update(type) });
    assert.equal(prior.automerge, false);
    assert.equal(prior.dependencyDashboardApproval, false);
  }
  for (const manager of ['npm', 'dockerfile', 'github-actions']) {
    const result = await applyPackageRules({ ...config, ...dep('example', 'npm'), manager, ...update('patch') });
    assert.equal(result.dependencyDashboardApproval, false);
    assert.equal(result.automerge, false);
  }

  for (const type of ['patch', 'minor', 'major']) {
    platformApis.set('github', { ...platformApis.get('github'), getVulnerabilityAlerts: async () => [{ security_vulnerability: {
      package: { ecosystem: 'maven', name: first.packageName },
      first_patched_version: { identifier: update(type).newVersion }, severity: 'high',
    }, security_advisory: { ghsa_id: 'GHSA-fixture', identifiers: [], severity: 'high', summary: 'fixture', description: '', references: [] } }] });
    setPlatformApi('github');
    const github = await detectVulnerabilityAlerts(config);
    const packages = { maven: [{ packageFile: 'pom.xml', deps: [{ ...first, updates: [update(type)] }] }] };
    const [alert] = await flattenUpdates(github, packages);
    assert.equal(alert.isVulnerabilityAlert, true);
    assert.equal(alert.dependencyDashboardApproval, false);
    assert.equal(alert.automerge, type !== 'major');
    assert.equal(alert.minimumReleaseAge, null);
    assert.equal(alert.prCreation, 'immediate');

    const osvConfig = { ...config, packageRules: [...config.packageRules] };
    const osv = new Vulnerabilities({ getVulnerabilities: async (ecosystem, name) => [{
      id: 'GHSA-fixture', affected: [{ package: { ecosystem, name },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: update(type).newVersion }] }] }],
    }] });
    await osv.appendVulnerabilityPackageRules(osvConfig, packages);
    const [osvAlert] = await flattenUpdates(osvConfig, packages);
    assert.equal(osvAlert.isVulnerabilityAlert, true);
    assert.equal(osvAlert.dependencyDashboardApproval, false);
    assert.equal(osvAlert.automerge, type !== 'major');
  }

  const file = 'project/src/main/scala/example/Dependencies.scala';
  const source = 'val jacksonVersion = "1.0.0"\nval core = "com.fasterxml.jackson.core" % "jackson-core" % jacksonVersion\nval bind = "com.fasterxml.jackson.core" % "jackson-databind" % jacksonVersion\n';
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), source);
  const extracted = await sbt.extractAllPackageFiles({}, [file]);
  assert.equal(extracted[0].deps.length, 2);
  extracted[0].deps.forEach(value => { value.updates = [update('patch')]; });
  const coupled = await branchifyUpgrades(config, { sbt: extracted });
  assert.equal(coupled.branches.length, 1);
  assert.equal(coupled.branches[0].upgrades.length, 2);
  let rewritten = source;
  for (const value of coupled.branches[0].upgrades) rewritten = await doAutoReplace(value, rewritten, false);
  assert.equal(rewritten, source.replace('"1.0.0"', '"1.0.1"'));
  console.log('PASS: JVM extraction/rewrites, independent families, ordinary dashboard/automerge and generated GitHub/OSV security patch/minor/major policy');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
