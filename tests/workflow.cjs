const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const dist = process.argv[2] ?? path.dirname(fs.realpathSync(
  execFileSync('which', ['renovate-config-validator'], { encoding: 'utf8' }).trim(),
));
const load = file => require(path.join(dist, file));
const { parse } = createRequire(path.join(dist, '../package.json'))('yaml');
const { GlobalConfig } = load('config/global.js');
const hostRules = load('util/host-rules.js');
const { GithubHttp } = load('util/http/github.js');
const { getGitEnvironmentVariables } = load('util/git/auth.js');
const { getRemoteUrlWithToken } = load('util/git/url.js');
const workflow = parse(fs.readFileSync('.github/workflows/renovate.yml', 'utf8'));
const steps = workflow.jobs.renovate.steps;
const updater = steps.find(step => step.id === 'app-token');
const reader = steps.find(step => step.id === 'read-token');
assert.equal(updater.with.repositories, '${{ github.event.repository.name }}');
assert.equal(reader.with.owner, '${{ github.repository_owner }}');
assert.equal(reader.with.repositories.trim(), '${{ github.event.repository.name }}\n${{ inputs.dependency_read_repositories }}');
assert.deepEqual(Object.fromEntries(Object.entries(reader.with).filter(([key]) => key.startsWith('permission-'))), {
  'permission-contents': 'read',
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-workflow-'));
try {
  const configure = steps.find(step => step.name === 'Configure dependency lookup credentials');
  const envFile = path.join(directory, 'environment');
  const env = Object.fromEntries(Object.keys(configure.env).map(key => [key, '']));
  const configureRules = (caller, repositories, registry = {}) => {
    fs.writeFileSync(envFile, '');
    execFileSync('bash', ['-e', '-c', configure.run], {
      env: { ...process.env, ...env, GITHUB_ENV: envFile, GITHUB_READ_TOKEN: 'fixture-reader', GITHUB_WRITE_TOKEN: 'fixture-updater', REPOSITORY_OWNER: 'StackVista', CALLING_REPOSITORY: caller, DEPENDENCY_READ_REPOSITORIES: repositories, ...registry },
    });
    return JSON.parse(fs.readFileSync(envFile, 'utf8').split('\n')[1]);
  };
  const rules = configureRules('sts-opentelemetry-collector', 'stackstate, sts-toolbox\n');
  GlobalConfig.set({ platform: 'github' });
  hostRules.add({ hostType: 'github', matchHost: 'https://api.github.com/', token: 'fixture-updater' });
  rules.forEach(rule => hostRules.add(rule));
  const tokenFor = (hostType, url, options = {}) => {
    const request = { ...options };
    new GithubHttp(hostType).processOptions(new URL(url), request);
    return request.token;
  };
  for (const repository of ['StackVista/docker-images', 'StackVista/sts-opentelemetry-collector']) {
    for (const endpoint of ['pulls', 'issues', 'commits', 'dependabot/alerts']) {
      assert.equal(tokenFor('github', `https://api.github.com/repos/${repository}/${endpoint}`), 'fixture-updater');
    }
    assert.equal(tokenFor('github', `https://api.github.com/repos/${repository}/pulls`, { method: 'POST' }), 'fixture-updater');
    assert.equal(tokenFor('github', 'https://api.github.com/graphql', { method: 'POST', readOnly: true, repository }), 'fixture-updater');
  }
  for (const hostType of ['github-tags', 'github-releases', 'github-changelog']) {
    assert.equal(tokenFor(hostType, 'https://api.github.com/repos/StackVista/sts-toolbox/tags'), 'fixture-reader');
    assert.equal(tokenFor(hostType, 'https://api.github.com/graphql', { method: 'POST', readOnly: true, repository: 'StackVista/sts-toolbox' }), 'fixture-reader');
  }
  assert(getRemoteUrlWithToken('https://github.com/StackVista/stackstate', 'git-refs').includes('fixture-reader'));
  const remoteToken = (hostTypes, repository) => {
    const gitEnv = getGitEnvironmentVariables({}, hostTypes);
    execFileSync('git', ['init', '--quiet', directory]);
    execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', `https://github.com/StackVista/${repository}`]);
    return execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', env: { ...process.env, ...gitEnv },
    });
  };
  assert(remoteToken([], 'sts-opentelemetry-collector').includes('fixture-updater'));
  assert(remoteToken(['git-refs'], 'stackstate').includes('fixture-reader'));
  assert(remoteToken(['go'], 'sts-toolbox').includes('fixture-reader'));
  hostRules.clear();
  configureRules('stackstate-cli', 'stackstate\nstackstate-cli').forEach(rule => hostRules.add(rule));
  assert(remoteToken([], 'stackstate-cli').includes('fixture-updater'));
  assert(remoteToken(['go'], 'stackstate').includes('fixture-reader'));
  const defaults = configureRules('sts-toolbox', '');
  assert.equal(defaults.filter(rule => rule.hostType === 'github').length, 1);
  const registry = configureRules('docker-images', 'sts-toolbox', {
    DOCKER_REGISTRY_1_HOST: 'quay.io', DOCKER_REGISTRY_1_USERNAME: 'fixture-user', DOCKER_REGISTRY_1_PASSWORD: 'fixture-password',
  });
  assert.deepEqual(registry.find(rule => rule.hostType === 'docker'), {
    hostType: 'docker', matchHost: 'quay.io', username: 'fixture-user', password: 'fixture-password',
  });
  console.log('Repository-write scope, private dependency reads and platform HTTP/Git authentication passed.');
} finally {
  hostRules.clear();
  fs.rmSync(directory, { recursive: true, force: true });
}
