import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "approver", Path(__file__).with_name("approve-renovate.py")
)
approver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(approver)


def pull(number=279):
    return {
        "number": number, "state": "OPEN", "isDraft": False,
        "author": {"login": "renovate-update-app", "__typename": "Bot"},
        "headRefOid": "head",
        "headRepository": {"nameWithOwner": "StackVista/docker-images"},
        "autoMergeRequest": {"enabledBy": {"login": "renovate-update-app", "__typename": "Bot"}},
        "reviews": {"nodes": []},
    }


def commit(sha="head"):
    return {
        "oid": sha, "committedViaWeb": True,
        "author": {"user": {"login": approver.BOT}},
        "signature": {"isValid": True, "wasSignedByGitHub": True,
                      "signer": {"login": "web-flow"}},
    }


def commit_page(commits, head="head", total=None):
    return {"data": {"repository": {"pullRequest": {
        "headRefOid": head,
        "commits": {"totalCount": len(commits) if total is None else total,
                    "nodes": [{"commit": item} for item in commits]},
    }}}}


class ApprovalPolicyTest(unittest.TestCase):
    def test_listing_and_approval_use_the_caller_repository(self):
        for repo in ["StackVista/docker-images", "StackVista/stackstate"]:
            pr = pull()
            pr["headRepository"]["nameWithOwner"] = repo

            def fake_gh(*args, approval=False, payload=None):
                if f"query={approver.PULLS_QUERY}" in args:
                    owner, name = repo.split("/")
                    self.assertIn(f"owner={owner}", args)
                    self.assertIn(f"name={name}", args)
                    return [{"data": {"repository": {"pullRequests": {"nodes": [pr]}}}}]
                if f"query={approver.COMMITS_QUERY}" in args:
                    return [commit_page([commit()])]
                if "id=review-id" in args:
                    return {"data": {"node": {"authorCanPushToRepository": True}}}
                self.assertEqual(args[1], f"repos/{repo}/pulls/279/reviews")
                self.assertTrue(approval)
                return {"user": {"login": "approval-app[bot]"}, "node_id": "review-id",
                        "state": "APPROVED", "commit_id": "head"}

            with self.subTest(repo=repo), patch.dict(os.environ, {
                "GITHUB_REPOSITORY": repo, "APPROVAL_BOT": "approval-app[bot]",
            }), patch.object(approver, "gh", side_effect=fake_gh):
                approver.main()
            self.assertFalse(approver.eligible(pr, "Other/repository"))

    def test_exact_bot_and_native_automerge_with_null_metadata(self):
        pr = pull()
        self.assertTrue(approver.eligible(pr, "StackVista/docker-images"))
        for section, field, value in [
            ("author", "login", "someone"),
            ("author", "login", "other-app"),
            ("author", "__typename", "User"),
            ("autoMergeRequest", "enabledBy", {"login": "someone", "__typename": "Bot"}),
            ("autoMergeRequest", "enabledBy", {"login": "renovate-update-app", "__typename": "User"}),
            ("autoMergeRequest", "enabledBy", None),
        ]:
            changed = copy.deepcopy(pr)
            changed[section][field] = value
            self.assertFalse(approver.eligible(changed, "StackVista/docker-images"))
        for field, value in [("isDraft", True), ("state", "CLOSED"), ("autoMergeRequest", None),
                             ("headRepository", None),
                             ("headRepository", {"nameWithOwner": "someone/docker-images"})]:
            self.assertFalse(approver.eligible({**pr, field: value}, "StackVista/docker-images"))

    def test_forged_bot_author_or_human_commits_are_not_approved(self):
        valid = commit()
        invalid = []
        for field, value in [("committedViaWeb", False), ("signature", None),
                             ("author", {"user": {"login": "human"}}),
                             ("author", {"user": None})]:
            invalid.append({**valid, field: value})
        for field, value in [("isValid", False), ("wasSignedByGitHub", False),
                             ("signer", {"login": "human"}), ("signer", None)]:
            invalid.append({**valid, "signature": {**valid["signature"], field: value}})
        for unsafe in invalid:
            with self.subTest(commit=unsafe), patch.object(
                approver, "gh", return_value=[commit_page([unsafe, valid])]
            ):
                self.assertFalse(approver.renovate_commits(pull(), "StackVista/docker-images"))

    def test_complete_commit_provenance_and_matching_head_are_required(self):
        pages = [commit_page([commit("earlier")], total=2),
                 commit_page([commit()], total=2)]
        with patch.object(approver, "gh", return_value=pages) as gh:
            self.assertTrue(approver.renovate_commits(pull(), "StackVista/docker-images"))
            self.assertIn("--paginate", gh.call_args.args)
        for pages in [[], [commit_page([])], [commit_page([commit()], total=2)],
                      [commit_page([commit()], head="changed")],
                      [commit_page([commit("other-head")])]]:
            with patch.object(approver, "gh", return_value=pages):
                self.assertFalse(approver.renovate_commits(pull(), "StackVista/docker-images"))
        with patch.object(approver, "gh", return_value=[{"errors": [{"message": "Unavailable"}]}]):
            with self.assertRaises(RuntimeError):
                approver.renovate_commits(pull(), "StackVista/docker-images")

    def test_review_uses_verified_commit_and_avoids_duplicate_approval(self):
        for existing, expected in [([], 1),
                                   ([{"node_id": "review-id", "state": "APPROVED", "commit_id": "head"}], 0),
                                   ([{"state": "APPROVED", "commit_id": "old-head"}], 1),
                                   ([{"state": "APPROVED", "commit_id": None}], 1),
                                   ([{"state": "DISMISSED", "commit_id": "head"}], 1)]:
            posted = []

            def fake_gh(*args, approval=False, payload=None):
                endpoint = args[1]
                if args[:2] == ("api", "graphql"):
                    if "id=review-id" in args:
                        return {"data": {"node": {"authorCanPushToRepository": True}}}
                    return [commit_page([commit()])]
                if endpoint.endswith("/reviews"):
                    self.assertTrue(approval)
                    self.assertEqual(payload["commit_id"], "head")
                    posted.append(payload)
                    return {"user": {"login": "approval-app[bot]"},
                            "node_id": "review-id", "state": "APPROVED", "commit_id": "head"}
                self.fail(f"Unexpected request (no file, CI or redundant PR reads allowed): {args}")

            with patch.object(approver, "gh", side_effect=fake_gh):
                pr = pull()
                pr["reviews"]["nodes"] = [
                    {"state": review["state"], "commit": {"oid": review["commit_id"]} if review["commit_id"] else None,
                     "author": {"login": "approval-app", "__typename": "Bot"},
                     "authorCanPushToRepository": True}
                    for review in existing
                ]
                approver.approve(pr, "StackVista/docker-images", "approval-app[bot]")
            self.assertEqual(len(posted), expected)

    def test_one_failed_pr_does_not_block_the_next_and_fails_the_run(self):
        approved = []

        def fake_gh(*args, approval=False, payload=None):
            if f"query={approver.PULLS_QUERY}" in args:
                return [{"data": {"repository": {"pullRequests": {"nodes": [pull(1), pull(2)]}}}}]
            if args[:2] == ("api", "graphql"):
                if "id=review-id" in args:
                    return {"data": {"node": {"authorCanPushToRepository": True}}}
                if "number=1" in args:
                    raise subprocess.CalledProcessError(1, ["gh"])
                if "number=2" in args:
                    return [commit_page([commit()])]
                self.fail(f"Unexpected graphql request: {args}")
            if args[1].endswith("/reviews"):
                if payload is None:
                    return [[]]
                approved.append(args[1])
                return {"user": {"login": "approval-app[bot]"},
                        "node_id": "review-id", "state": "APPROVED", "commit_id": "head"}
            self.fail(f"Unexpected request: {args}")

        with patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "StackVista/docker-images",
            "APPROVAL_BOT": "approval-app[bot]",
        }), patch.object(approver, "gh", side_effect=fake_gh):
            with self.assertRaisesRegex(RuntimeError, r"Approval failed for PRs: \[1\]"):
                approver.main()
        self.assertEqual(approved, ["repos/StackVista/docker-images/pulls/2/reviews"])

    def test_approved_prs_share_one_listing_call_and_do_not_revalidate_heads(self):
        pulls = [pull(1), pull(2)]
        for pr in pulls:
            pr["reviews"]["nodes"] = [{
                "author": {"login": "approval-app", "__typename": "Bot"},
                "state": "APPROVED", "commit": {"oid": "head"},
                "authorCanPushToRepository": True,
            }]
        with patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "StackVista/docker-images",
            "APPROVAL_BOT": "approval-app[bot]",
        }), patch.object(approver, "gh", return_value=[{
            "data": {"repository": {"pullRequests": {"nodes": pulls}}},
        }]) as gh:
            approver.main()
            gh.assert_called_once()
            self.assertIn(f"query={approver.PULLS_QUERY}", gh.call_args.args)

    def test_reviewer_without_write_access_is_reported(self):
        for result in [
            {"data": {"node": {"authorCanPushToRepository": False}}},
            {"errors": [{"message": "Unavailable"}]},
            {"data": {"node": None}},
        ]:
            with patch.object(approver, "gh", return_value=result):
                with self.assertRaises(RuntimeError):
                    approver.verify_reviewer_access({"node_id": "review-id"})

    def test_renovate_cannot_approve_its_own_pr(self):
        with patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "StackVista/docker-images",
            "APPROVAL_BOT": approver.BOT,
        }), patch.object(approver, "gh") as gh:
            with self.assertRaises(RuntimeError):
                approver.main()
            gh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
