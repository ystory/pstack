# Codex continuation and wakeups

Use this binding wherever a playbook says to loop. The predicate, event wake, fallback heartbeat, drain, and rearm behavior remain the workflow. A recurring schedule alone does not perform the work.

## Arm

Record the done predicate, authorized scope, standing orders, current branch/head, trail, and resume point in the run's local task store. Use the installed absolute paths from [Codex execution](execution.md) for the playbook and helpers. Re-read those paths each audit. When a skill is owned by the current project and tracked on its trunk, read its actual repository-relative path from trunk; an installed plugin is a versioned bundle, not a `pstack/` directory inside the target repository.

For an event, start one watcher with `poteto-agent` instructions for a playbook step, or an execution session, using **Codex execution** for its selected model and parent-alias binding. Its command waits for the event and reports the observed state. For GitHub PRs, run the installed `scripts/watch-pr/watch-pr`; for Origin, use its watch commands. An active coordinator waits through native agent or execution-session tools, drains the result, acts on that verdict, and rearms after each push wave or acted-on verdict. The watcher owns polling. Keep the coordinator out of a second sleep loop.

For a run that must wake after this turn or an app restart, use the host's `automation_update` tool with `kind: heartbeat` in this chat, alongside the event watcher. This preserves the current conversation and a time-based fallback. Save the predicate, standing orders, store paths, and concrete tick instructions in the automation prompt. Use the requested cadence, such as every hour for program audits. For work with no event to watch, the heartbeat is the primary wake mechanism. Read the host's live schema before creating or updating it; let the scheduler validate its recurrence. If it cannot express the needed cadence, report that capability gap before choosing another cadence. Never claim a live schedule exists until creation succeeds.

## Tick and rearm

Re-read the saved state and the current playbook. Check the predicate on the real artifact, inspect the selected executor's agent or command statuses and side effects, drain queued receipts, and perform the next justified unit. A stopped child needs a fresh consolidated brief; a status probe does not restart it. A watcher completion is an event, not a pass by itself.

Keep the same execution session attached while its watcher is running. A tool returning a session ID means the command remains in flight; poll that session rather than launching another watcher. If the turn ends, the saved heartbeat owns the next fallback wake. It rechecks the event against the forge and rearms a missing watcher. It does not assume a terminal process or local agent survived the restart.

Post an update only for a meaningful change, completion, failure, or required human action. Leave unchanged or non-actionable ticks quiet and log the tick as the execution playbook requires. Changing the goal, scope, or notification policy follows the user's instruction.

## Stop and recover

When the predicate passes, stop the run's watcher and delete its heartbeat by the returned automation ID. An explicit pause cancels these wakeups and nested agents after the current atomic step reaches a safe boundary, then writes the resume note. Keep evidence and the trail.

After a restart, read the local task store, branch/PR state, and each executor's agent/session inventory. Reattach only identities the host reports as live. Replace a missing child with a fresh brief carrying the standing orders and current evidence. Restore the watcher and saved fallback only for a run the user asked to continue. A checkpoint is recoverable state, not proof that background work is still running.
