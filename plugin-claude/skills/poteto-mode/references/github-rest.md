# GitHub REST fallback

Some hosts refuse GitHub GraphQL with HTTP 403 but allow REST. Claude cloud sessions are one: their proxy answers `GitHub GraphQL is not available from Claude Code sessions`. `gh pr`, `gh issue`, and `gh api graphql` need GraphQL, so they fail there. Keep using `gh pr` wherever it works. When one fails with that refusal, run the matching REST route through `gh api` instead. Inside a checkout, `gh api` fills `{owner}` and `{repo}` from the repository, as `gh pr` does.

| Step                      | `gh pr`                                                  | REST through `gh api`                                                                                              |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Open a ready PR           | `gh pr create --base B --head H --title T --body-file F` | `gh api repos/{owner}/{repo}/pulls -f base=B -f head=H -f title=T -F body=@F`                                      |
| Find a branch's PR        | `gh pr view` or `gh pr list --head H`                    | `gh api --method GET repos/{owner}/{repo}/pulls -F head={owner}:H -f state=all`                                    |
| Read state                | `gh pr view N --json state,mergedAt,baseRefName`         | `gh api repos/{owner}/{repo}/pulls/N --jq '{state, merged_at, base: .base.ref, head: .head.sha, mergeable_state}'` |
| Retarget                  | `gh pr edit N --base B`                                  | `gh api --method PATCH repos/{owner}/{repo}/pulls/N -f base=B`                                                     |
| Merge                     | `gh pr merge N --squash`                                 | `gh api --method PUT repos/{owner}/{repo}/pulls/N/merge -f merge_method=squash -f sha=S`                           |
| Read checks               | `gh pr checks N`                                         | `gh api repos/{owner}/{repo}/commits/S/check-runs` and `gh api repos/{owner}/{repo}/commits/S/status`              |
| Comment on the PR         | `gh pr comment N --body-file F`                          | `gh api repos/{owner}/{repo}/issues/N/comments -F body=@F`                                                         |
| Reply to a review comment | (already REST)                                           | `gh api --method POST repos/{owner}/{repo}/pulls/N/comments/C/replies -F body=@F`                                  |

`S` is the head SHA. Pass the SHA the verdict covers to the merge route, so GitHub refuses the merge with 409 when the head moved. Read the PR back after every merge, as with `gh pr merge`.

REST has no review-thread resolution, auto-merge, or ready-for-review route. Claude cloud's proxy adds them on `api.github.com`, keyed by a thread's first comment ID:

- `gh api repos/{owner}/{repo}/pulls/N/ccr/review_threads` lists each thread's `resolved` state, `path`, `line`, and `comment_ids`.
- `gh api --method POST repos/{owner}/{repo}/pulls/N/ccr/comments/C/resolve`, or `.../unresolve`, resolves a thread.
- `gh api --method PUT repos/{owner}/{repo}/pulls/N/ccr/auto_merge` arms auto-merge, and `--method DELETE` disarms it.
- `gh api --method POST repos/{owner}/{repo}/pulls/N/ccr/ready_for_review` and `.../convert_to_draft` change draft state.

Elsewhere these steps need GraphQL. Report the step as blocked rather than skipping it.

`scripts/watch-pr/watch-pr` switches to REST by itself after the first refusal and reports the same verdicts, with these differences:

- A review thread's `id` is the REST ID of its first comment, which the reply and resolve routes above take.
- Check results come from the head commit's check runs and statuses, labeled `graphql-rollup`.
- REST has no review decision. A reviewer's latest change request blocks until that reviewer approves or the review is dismissed, even where branch protection requires no review.
- Only the head commit's checks are read, so the status table never shows `was ✅`.

`scripts/worktree-audit.sh` reads PR state through REST after `gh pr list` fails. REST has no author filter, so it reads the 1,000 newest PRs and keeps yours.
