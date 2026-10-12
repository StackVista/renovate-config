import json
import os
import subprocess


BOT = "renovate-update-app[bot]"
PULLS_QUERY = """
query($owner: String!, $name: String!, $approvalBot: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, states: OPEN, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        isDraft
        author { __typename login }
        headRefOid
        headRepository { nameWithOwner }
        autoMergeRequest { enabledBy { __typename login } }
        reviews(last: 1, author: $approvalBot, states: [APPROVED, DISMISSED, CHANGES_REQUESTED]) {
          nodes {
            author { __typename login }
            state
            commit { oid }
            authorCanPushToRepository
          }
        }
      }
    }
  }
}
"""
COMMITS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(first: 100, after: $endCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          commit {
            oid
            committedViaWeb
            author { user { login } }
            signature { isValid wasSignedByGitHub signer { login } }
          }
        }
      }
    }
  }
}
"""


def gh(*args, approval=False, payload=None):
    env = os.environ.copy()
    if approval:
        env["GH_TOKEN"] = env["APPROVAL_TOKEN"]
    result = subprocess.run(
        ["gh", *args], env=env, input=json.dumps(payload) if payload else None,
        text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


def eligible(pr, repo):
    automerge = pr.get("autoMergeRequest") or {}
    return (
        pr["state"] == "OPEN"
        and not pr["isDraft"]
        and pr["author"]["login"] == BOT.removesuffix("[bot]")
        and pr["author"]["__typename"] == "Bot"
        and (pr.get("headRepository") or {}).get("nameWithOwner") == repo
        and (automerge.get("enabledBy") or {}).get("login") == BOT.removesuffix("[bot]")
        and (automerge.get("enabledBy") or {}).get("__typename") == "Bot"
    )


def renovate_commits(pr, repo):
    owner, name = repo.split("/")
    pages = gh(
        "api", "graphql", "--paginate", "--slurp",
        "-f", f"query={COMMITS_QUERY}", "-f", f"owner={owner}",
        "-f", f"name={name}", "-F", f"number={pr['number']}",
    )
    commits = []
    for page in pages:
        if page.get("errors"):
            raise RuntimeError("Commit provenance query failed")
        pull = page["data"]["repository"]["pullRequest"]
        if pull["headRefOid"] != pr["headRefOid"]:
            return False
        connection = pull["commits"]
        commits.extend(node["commit"] for node in connection["nodes"])
    if not commits or len(commits) != connection["totalCount"]:
        return False
    if pr["headRefOid"] not in {commit["oid"] for commit in commits}:
        return False
    # GitHub verifies bot signatures only for authenticated App commits without custom identities.
    return all(
        commit["committedViaWeb"]
        and (commit["author"]["user"] or {}).get("login") == BOT
        and (commit["signature"] or {}).get("isValid")
        and (commit["signature"] or {}).get("wasSignedByGitHub")
        and ((commit["signature"] or {}).get("signer") or {}).get("login") == "web-flow"
        for commit in commits
    )


def verify_reviewer_access(review):
    result = gh(
        "api", "graphql", "-f", f"id={review['node_id']}",
        "-f", "query=query($id: ID!) { node(id: $id) { ... on PullRequestReview { authorCanPushToRepository } } }",
    )
    if result.get("errors") or not result.get("data", {}).get("node"):
        raise RuntimeError("Could not verify approval App reviewer access")
    if not result["data"]["node"]["authorCanPushToRepository"]:
        raise RuntimeError("Approval App lacks repository write access required for approvals")


def approve(pr, repo, approval_bot):
    head = pr["headRefOid"]
    app_reviews = pr["reviews"]["nodes"]
    if app_reviews:
        latest = app_reviews[-1]
        if (
            latest["author"]["__typename"] != "Bot"
            or latest["author"]["login"] != approval_bot.removesuffix("[bot]")
        ):
            raise RuntimeError("Unexpected reviewer returned for approval App")
        if latest["state"] == "APPROVED" and (latest.get("commit") or {}).get("oid") == head:
            if not latest["authorCanPushToRepository"]:
                raise RuntimeError("Approval App lacks repository write access required for approvals")
            return
    if not renovate_commits(pr, repo):
        print(f"Skipped PR #{pr['number']}: commits are not verified Renovate commits")
        return
    review = gh(
        "api", f"repos/{repo}/pulls/{pr['number']}/reviews", "--method", "POST",
        "--input", "-", approval=True,
        payload={"event": "APPROVE", "commit_id": head,
                 "body": "Auto-approving verified Renovate commits with native automerge enabled."},
    )
    if (
        review["user"]["login"] != approval_bot
        or review["state"] != "APPROVED"
        or review["commit_id"] != head
    ):
        raise RuntimeError("Approval App did not approve the requested commit")
    verify_reviewer_access(review)
    print(f"Approved PR #{pr['number']} at {head}")


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    approval_bot = os.environ["APPROVAL_BOT"]
    if not approval_bot.endswith("[bot]") or approval_bot == BOT:
        raise RuntimeError("Approval requires a separate GitHub App")
    owner, name = repo.split("/")
    pages = gh(
        "api", "graphql", "--paginate", "--slurp",
        "-f", f"query={PULLS_QUERY}", "-f", f"owner={owner}",
        "-f", f"name={name}", "-f", f"approvalBot={approval_bot}",
    )
    failures = []
    for page in pages:
        if page.get("errors"):
            raise RuntimeError("Open PR query failed")
        for pr in page["data"]["repository"]["pullRequests"]["nodes"]:
            try:
                if eligible(pr, repo):
                    approve(pr, repo, approval_bot)
            except (subprocess.CalledProcessError, RuntimeError, KeyError, TypeError, ValueError) as error:
                reason = "GitHub API request failed" if isinstance(error, subprocess.CalledProcessError) else str(error)
                print(f"::error::Approval failed for PR #{pr['number']}: {reason}")
                failures.append(pr["number"])
    if failures:
        raise RuntimeError(f"Approval failed for PRs: {failures}")


if __name__ == "__main__":
    main()
