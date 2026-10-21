const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const renovate = process.argv[2] ?? path.dirname(fs.realpathSync(
  execFileSync('which', ['renovate-config-validator'], { encoding: 'utf8' }).trim(),
));
const load = file => require(path.join(renovate, file));
const { getConfig } = load('config/defaults.js');
const { mergeChildConfig } = load('config/utils.js');
const { applyPackageRules } = load('util/package-rules/index.js');
const { getDatasourceFor } = load('modules/datasource/common.js');
const { lookupUpdates } = load('workers/repository/process/lookup/index.js');
const { branchifyUpgrades } = load('workers/repository/updates/branchify.js');
const { doAutoReplace } = load('workers/repository/update/branch/auto-replace.js');
const presets = load('modules/manager/renovate-config/index.js');
const actions = load('modules/manager/github-actions/index.js');
const repo = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(repo, file)));
const updater = read('files/release-updates.json');
const oldSha = '1'.repeat(40);
const newSha = '2'.repeat(40);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-release-'));
load('config/global.js').GlobalConfig.set({ platform: 'github', localDir: directory });

async function main() {
  const datasource = getDatasourceFor('github-tags');
  datasource.getReleases = async () => ({
    sourceUrl: 'https://github.com/StackVista/renovate-config',
    releases: [{ version: 'v1.0.0' }, { version: 'v1.1.0' }],
  });
  datasource.getDigest = async (_, version) => version === 'v1.1.0' ? newSha : oldSha;
  let policy = getConfig();
  for (const name of ['default', 'go', 'automerge']) {
    policy = mergeChildConfig(policy, { ...read(`${name}.json`), extends: [] });
  }
  policy = mergeChildConfig(policy, { ...updater, semanticCommits: 'disabled' });

  {
    const config = {
      extends: ['', ':go', ':automerge'].map(name => `github>StackVista/renovate-config${name}#v1.0.0`),
      packageRules: [{
        matchPackageNames: ['unrelated'],
        allowedVersions: 'v1.0.0',
        description: `Preserve unrelated ${oldSha} and v1.0.0`,
      }],
    };
    const content = JSON.stringify(config, null, 2) + '\n';
    const files = { 'renovate-config': [{ ...await presets.extractPackageFile(content, 'renovate.json'), packageFile: 'renovate.json' }],
      'github-actions': await Promise.all([
        '.github/workflows/renovate.yml',
        '.github/actions/auto-approve-renovate',
      ].map(async (target, index) => {
        const use = `StackVista/renovate-config/${target}@${oldSha} # v1.0.0`;
        const content = index === 0
          ? `name: Test\non: push\njobs:\n  test:\n    uses: ${use}\n`
          : `name: Test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${use}\n`;
        const packageFile = `.github/workflows/consumer-${index}.yml`;
        const extracted = await actions.extractPackageFile(content, packageFile);
        return { ...extracted, deps: extracted.deps.filter(dep => dep.depName === 'StackVista/renovate-config'), packageFile, content };
      })),
    };
    for (const [manager, packages] of Object.entries(files)) {
      for (const file of packages) {
        assert.equal(file.deps.length, manager === 'renovate-config' ? 3 : 1);
        for (const dep of file.deps) {
          dep.packageName ??= dep.depName;
          const config = await applyPackageRules({
            ...policy, ...dep, manager, packageFile: file.packageFile,
          });
          const { val, err } = (await lookupUpdates(config)).unwrap();
          assert.equal(err, undefined);
          assert.equal(val.updates.length, 1);
          assert.equal(val.updates[0].newVersion, 'v1.1.0');
          if (manager === 'github-actions') assert.equal(val.updates[0].newDigest, newSha);
          else assert.equal(val.updates[0].newDigest, undefined);
          dep.updates = val.updates;
        }
      }
    }
    const { branches } = await branchifyUpgrades({ ...policy, errors: [], warnings: [] }, files);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].upgrades.length, 5);
    assert.equal(branches[0].automerge, false);
    const contents = new Map([
      ['renovate.json', content],
      ...files['github-actions'].map(file => [file.packageFile, file.content]),
    ]);
    for (const upgrade of branches[0].upgrades) {
      const before = contents.get(upgrade.packageFile);
      contents.set(upgrade.packageFile, await doAutoReplace(upgrade, before, false));
    }
    const expected = structuredClone(config);
    expected.extends = expected.extends.map(ref => ref.replace('v1.0.0', 'v1.1.0'));
    assert.deepEqual(JSON.parse(contents.get('renovate.json')), expected);
    for (const file of files['github-actions']) {
      assert(contents.get(file.packageFile).includes(`@${newSha} # v1.1.0`));
    }
  }
  const paused = mergeChildConfig(policy, {
    packageRules: [
      { matchPackageNames: ['*'], enabled: false },
      { ...updater.packageRules[0], enabled: true },
    ],
  });
  for (const manager of ['renovate-config', 'github-actions']) {
    for (const packageName of ['StackVista/renovate-config', 'StackVista/other']) {
      for (const updateType of ['patch', 'minor', 'major', 'digest']) {
        const result = await applyPackageRules({ ...paused, manager, packageName, updateType });
        assert.equal(result.enabled, packageName === 'StackVista/renovate-config');
      }
    }
  }
  assert.equal(await presets.extractPackageFile('{}', 'renovate.json'), null);
  const local = await presets.extractPackageFile(JSON.stringify({ extends: ['local>StackVista/renovate-config#v1.0.0'] }), 'renovate.json');
  assert.equal(local.deps[0].skipReason, 'unsupported-datasource');
  const yaml = load('util/yaml.js').parseSingleYaml(fs.readFileSync(path.join(repo, '.github/workflows/deploy.yml'), 'utf8'));
  assert.equal(yaml.jobs.deploy.steps[0].with['fetch-depth'], 0);
  console.log('PASS: native preset tag updates, grouped workflow/action SHA updates and deployment tag fetching');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
