# Claude cloud sessions

`CLAUDE_CODE_REMOTE=true` marks a Claude cloud session. A Claude Project thread also has the project's shared folder at `/mnt/project-files/`. Without that environment value, nothing in this file applies.

## What a new container loses

The container is reclaimed after the session goes idle, and a later wake can start on a fresh container. These do not carry over:

- Files outside the durable location below, including `.local/`, the work dir, and `/tmp/`.
- Commits that were not pushed.
- Worktrees and the dependencies installed in them.
- Background Bash tasks, such as Codex worker runs and `scripts/watch-pr/watch-pr`.
- Session schedules from CronCreate or `/loop`.

## Arm wakes on the server

Use the server-side wake controls that the session exposes. Tool names vary by host, so the names below are examples:

- For PR, CI, and review events, subscribe to the PR's activity, such as with `subscribe_pr_activity`.
- For the fallback heartbeat, schedule a one-shot wake, such as with `send_later`. Arm the next one on each tick, at the cadence the workflow would have used.
- For recurring work that must run with no session, create a cloud routine or trigger, such as with `create_trigger`.

Verify each wake you create and record its ID in the run's task store. Point each wake at the tick instructions in the durable location. When the run has no durable location, report that gap before you claim a durable wake. A watcher inside the session can wait for an event within one active turn, but it is never the only wake of a long run. If the session exposes no wake that outlives the container, report that gap before you claim a wake is armed. When the run stops, delete or unsubscribe each recorded wake by its ID.

## Keep state in a durable location

The durable location holds the run's task store, decision trail, resume note, tick instructions, and any receipt that a later tick or reviewer needs.

- In a Claude Project, the durable location is one subdirectory per run, such as `/mnt/project-files/pstack/<project-slug>/<run-slug>/`.
- Outside a Project, only what reaches the remote survives: pushed commits, and notes posted on the run's PR. The durable location is the run's PR. Post one comment per note, edit that comment in place, and read it back through `gh api`.

Wherever a workflow passes a local store path, pass the durable location instead. That is the run's folder path in a Project, or the note's PR comment URL outside one.

When the run has no durable location, say so in the reply. Its work then lives only in this container and is lost once the session goes idle.

When the run already pushes its branch, push each finished unit before you end a turn or arm a wake.

On every wake, rebuild from the durable location and the pushed branches. Fetch, recreate each worktree at its pushed head, and prepare its dependencies per [Worktree dependency and build state](worktree-setup.md). Never assume that a local file or process survived.

## Share the Project folder safely

Other threads write to the same folder, and the last write wins. Write only in the run's own subdirectory, and re-read a file before you append to it. The folder does not keep `600` permissions, so never write credentials or secrets there.
