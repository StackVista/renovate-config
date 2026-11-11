import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


class RegistryCredentialsTests(unittest.TestCase):
    def run_script(self, values):
        workflow = Path('.github/workflows/renovate.yml').read_text()
        script = textwrap.dedent(workflow.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0])
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('DOCKER_REGISTRY_', 'PACKAGE_REGISTRY_PROXY'))}
        environment.update({key: '' for slot in range(1, 6)
                            for key in [f'DOCKER_REGISTRY_{slot}_{field}' for field in ['HOST', 'USERNAME', 'PASSWORD']]})
        environment.update(dict.fromkeys(['PACKAGE_REGISTRY_PROXY', 'PACKAGE_REGISTRY_PROXY_USERNAME', 'PACKAGE_REGISTRY_PROXY_TOKEN'], ''))
        environment.update(values)
        with tempfile.NamedTemporaryFile() as output:
            environment['GITHUB_ENV'] = output.name
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script], env=environment, text=True, capture_output=True)
            content = Path(output.name).read_text()
        rules = json.loads(content.splitlines()[1]) if content else []
        return result, rules

    def test_no_credentials_preserves_existing_consumers(self):
        result, rules = self.run_script({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rules, [])

    def test_proxy_and_docker_rules_keep_distinct_host_types(self):
        result, rules = self.run_script({
            'DOCKER_REGISTRY_1_HOST': 'registry.example.com',
            'DOCKER_REGISTRY_1_USERNAME': 'docker-user',
            'DOCKER_REGISTRY_1_PASSWORD': 'docker-secret',
            'PACKAGE_REGISTRY_PROXY': 'https://packages.example.com/maven/',
            'PACKAGE_REGISTRY_PROXY_USERNAME': 'build-user',
            'PACKAGE_REGISTRY_PROXY_TOKEN': 'literal-$(false)-secret',
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([rule['hostType'] for rule in rules], ['docker', 'maven', 'sbt'])
        self.assertEqual(rules[1]['matchHost'], 'https://packages.example.com/maven/')
        self.assertEqual(rules[2]['password'], 'literal-$(false)-secret')
        self.assertNotIn('secret', result.stdout + result.stderr)

    def test_incomplete_proxy_configuration_fails_without_exposing_secret(self):
        result, rules = self.run_script({'PACKAGE_REGISTRY_PROXY_TOKEN': 'private-fixture'})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(rules, [])
        self.assertNotIn('private-fixture', result.stdout + result.stderr)
