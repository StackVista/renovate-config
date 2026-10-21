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
const regex = load('modules/manager/custom/regex/index.js');
const actions = load('modules/manager/github-actions/index.js');
const repo = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(repo, file)));
const updater = read('files/release-updates.json');
const manager = updater.customManagers[0];
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

  for (const prefix of ['local', 'github']) {
    const config = {
      description: 'Renovate release v1.0.0',
      extends: ['', ':go', ':automerge'].map(name => `${prefix}>StackVista/renovate-config${name}#${oldSha}`),
      packageRules: [{
        matchPackageNames: ['unrelated'],
        allowedVersions: 'v1.0.0',
        extends: [`github>StackVista/renovate-config:docker#${oldSha}`, `github>other/preset#${oldSha}`],
      }],
    };
    const content = JSON.stringify(config, null, 2) + '\n';
    const files = { regex: [{ ...await regex.extractPackageFile(content, 'renovate.json', manager), packageFile: 'renovate.json' }],
      'github-actions': await Promise.all([
        '.github/workflows/renovate.yml',
        '.github/actions/auto-approve-renovate',
      ].map(async (target, index) => {
        const content = `name: Test\non: push\njobs:\n  test:\n    uses: StackVista/renovate-config/${target}@${oldSha} # v1.0.0\n`;
        const packageFile = `.github/workflows/consumer-${index}.yml`;
        return { ...await actions.extractPackageFile(content, packageFile), packageFile, content };
      })),
    };
    for (const [manager, packages] of Object.entries(files)) {
      for (const file of packages) {
        assert.equal(file.deps.length, 1);
        for (const dep of file.deps) {
          dep.packageName ??= dep.depName;
          const config = await applyPackageRules({
            ...policy, ...dep, manager, packageFile: file.packageFile,
          });
          const { val, err } = (await lookupUpdates(config)).unwrap();
          assert.equal(err, undefined);
          assert.equal(val.updates.length, 1);
          assert.equal(val.updates[0].newDigest, newSha);
          dep.updates = val.updates;
        }
      }
    }
    const { branches } = await branchifyUpgrades({ ...policy, errors: [], warnings: [] }, files);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].upgrades.length, 3);
    assert.equal(branches[0].automerge, false);
    for (const upgrade of branches[0].upgrades) {
      const before = upgrade.packageFile === 'renovate.json' ? content
        : files['github-actions'].find(file => file.packageFile === upgrade.packageFile).content;
      const after = await doAutoReplace(upgrade, before, false);
      if (upgrade.packageFile === 'renovate.json') {
        const expected = structuredClone(config);
        expected.description = 'Renovate release v1.1.0';
        expected.extends = expected.extends.map(ref => ref.replace(oldSha, newSha));
        expected.packageRules[0].extends[0] = expected.packageRules[0].extends[0].replace(oldSha, newSha);
        assert.deepEqual(JSON.parse(after), expected);
      } else {
        assert(after.includes(`@${newSha} # v1.1.0`));
      }
    }
  }
  const paused = mergeChildConfig(policy, {
    packageRules: [
      { matchPackageNames: ['*'], enabled: false },
      { ...updater.packageRules[0], enabled: true },
    ],
  });
  for (const manager of ['regex', 'github-actions']) {
    for (const packageName of ['StackVista/renovate-config', 'StackVista/other']) {
      for (const updateType of ['patch', 'minor', 'major', 'digest']) {
        const result = await applyPackageRules({ ...paused, manager, packageName, updateType });
        assert.equal(result.enabled, packageName === 'StackVista/renovate-config');
      }
    }
  }
  assert.equal(await regex.extractPackageFile('{}', 'renovate.json', manager), null);
  const yaml = load('util/yaml.js').parseSingleYaml(fs.readFileSync(path.join(repo, '.github/workflows/deploy.yml'), 'utf8'));
  assert.equal(yaml.jobs.deploy.steps[0].with['fetch-depth'], 0);
  console.log('PASS: released SHA pins, nested presets, grouped workflow/action updates and deployment tag fetching');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
