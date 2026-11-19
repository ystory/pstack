### Pause safely

Use [Claude Code execution](../references/execution.md) for worker identities and [Claude Code wakeups](../references/claude-wakeups.md) for the run's event watcher and schedule lifecycle.

**You own a clean stop. Leave a checkpoint a cold-start agent can resume from.** This is explicit only. On "keep going", "going to bed, keep going", or "don't stop", do not pause.

1. Stop at a safe boundary. Finish the current atomic step or back out of it. Start nothing new, and cancel any nested subagents.
2. Take no irreversible action to pause. No PR and no push unless you already had one out.
3. Make the work durable. Commit uncommitted edits as one clear `wip:` commit on the current branch so nothing is lost. If the tree is broken, say so in the commit body in one line. In a Claude cloud session, an unpushed commit dies with the container. Unless the run already pushes its branch, save every unpushed commit as `git format-patch` output in the durable location from [Claude cloud sessions](../references/claude-cloud.md). Start the range at the last pushed commit, or at the base when nothing was pushed. Save the untracked files that the commits left out in the same place. When the run has no durable location, say in the reply that its work lives only in this container and is lost once the session goes idle.
4. Write the resume note off-context. Capture intent, what you were doing, progress and what's verified, current state, next steps, key files, and gotchas. For the compaction trigger write it to a file like `/tmp/<slug>-resume.md`. In a Claude cloud session, write it to the durable location instead. If a show-me-your-work trail exists, point at it instead of duplicating it.

**Reply:** where you are in the loop, what's on disk versus still in your head (paths, no diff dumps), the commits you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.
