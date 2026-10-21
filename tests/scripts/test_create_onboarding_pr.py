import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/deploy/create-onboarding-pr.sh"
MOCK_GH = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    print("1")
    sys.exit(0)
if not args or args[0] != "api":
    sys.exit("Unexpected gh command")
endpoint = args[1]
prefix = "repos/example/consumer/"
if endpoint == prefix + "git/ref/heads/release":
    print("a" * 40)
elif endpoint == prefix + "git/commits/" + "a" * 40:
    print("base-tree")
elif endpoint.startswith(prefix + "contents/"):
    file = endpoint.removeprefix(prefix + "contents/")
    sys.exit(0 if file in json.loads(os.environ["MOCK_DEPENDABOT_FILES"]) else 1)
elif endpoint == prefix + "git/blobs":
    print("generated-blob")
elif endpoint == prefix + "git/trees":
    payload = Path(args[args.index("--input") + 1]).read_text()
    Path(os.environ["MOCK_TREE_PAYLOAD"]).write_text(payload)
    print("generated-tree")
elif endpoint == prefix + "git/commits":
    print("generated-commit")
elif endpoint == prefix + "git/ref/heads/chore/onboard-renovate":
    sys.exit(1)
elif endpoint == prefix + "git/refs":
    pass
else:
    sys.exit("Unexpected API endpoint")
"""


class OnboardingPrTests(unittest.TestCase):
    def test_submitted_tree_removes_every_existing_dependabot_config(self):
        for files in [
            [".github/dependabot.yaml"],
            [".github/dependabot.yml"],
            [".github/dependabot.yml", ".github/dependabot.yaml"],
            [],
        ]:
            with self.subTest(files=files), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / "target"
                (target / ".github/workflows").mkdir(parents=True)
                (target / "renovate.json").write_text("{}")
                (target / ".github/workflows/renovate.yml").write_text("jobs: {}")
                binary = root / "bin"
                binary.mkdir()
                mock = binary / "gh"
                mock.write_text(MOCK_GH)
                mock.chmod(0o755)
                payload = root / "tree.json"
                env = {
                    **os.environ,
                    "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "MOCK_DEPENDABOT_FILES": json.dumps(files),
                    "MOCK_TREE_PAYLOAD": str(payload),
                }
                run = subprocess.run(
                    ["bash", str(SCRIPT), str(target), "example/consumer", "release", "go"],
                    env=env, text=True, capture_output=True, timeout=30,
                )
                self.assertEqual(run.returncode, 0, run.stderr)
                submitted = json.loads(payload.read_text())
                self.assertEqual(submitted["base_tree"], "base-tree")
                deletions = [entry for entry in submitted["tree"] if entry["sha"] is None]
                self.assertEqual({entry["path"] for entry in deletions}, set(files))
                self.assertEqual(len(deletions), len(files))
                for entry in deletions:
                    self.assertEqual(entry["type"], "blob")
                    self.assertEqual(entry["mode"], "100644")
                generated = [entry["path"] for entry in submitted["tree"] if entry["sha"] is not None]
                self.assertEqual(generated, ["renovate.json", ".github/workflows/renovate.yml"])


if __name__ == "__main__":
    unittest.main()
