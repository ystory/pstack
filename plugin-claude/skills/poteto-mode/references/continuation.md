# Continuing a stopped worker

Read this before you retry, replace, or resume a worker that stopped before it returned a usable result. It binds poteto-mode's costly-state exception to this host's executors.

## Continue by default

A worker's conversation is state that lives in that worker and is costly to move. A conversation that stopped before its result still holds the reads, tool results, and reasoning the worker finished. Continue that conversation. A fresh worker would repeat that work and spend its time and tokens again.

Give the work to a fresh worker with the consolidated brief only when one of these holds:

- The worker returned a result, and the result is wrong or unusable.
- The conversation cannot continue. The receipt says `continuable: false`, the executor rejects the continuation, or the executor, exact model, effort, working directory, or authentication must change.
- The calling workflow's retry by cause asks for a different model or a smaller scope.

When two continuations for the same cause stop again, stop retrying. Follow the calling workflow's retry limit, such as Orchestrate's rule to drop the unit and replan around it.

## Read the stop

Runner receipts record `stop.kind`, `stop.cause`, and `stop.continuable`. A native worker's stop arrives as the host's task notice.

- `interrupted`. Something outside the worker ended it, such as a deadline, a signal, a task stop, a session or host stop, or a usage limit. Continue it once the cause is gone.
- `permission`. The executor's own approval refused an action, such as a denied Codex review. Show the user the refused action and continue only after the user's explicit approval in chat. Do not grant permissions one by one on your own.
- `error`. The executor reported an error. Read `stop.cause`. A rate limit, a quota limit, or a dropped connection continues after it clears. A tool or model error follows the calling workflow's retry by cause.
- `completed`. Review the result under the calling workflow. New work that needs this worker's state continues it under the costly-state exception.

## Write the continuation

Interrupt-chained resumes can drop directives, so every continuation message repeats the consolidated brief: the original brief, every later directive, and what changed since the stop, such as a granted permission. Name the actual cause. For an interruption, say that it came from outside and was not a refusal, and that the worker reruns an interrupted step it still needs. A stopped native worker otherwise reads its cut-off tool call as a user rejection. For a permission stop, name the action the user approved.

Keep the executor, exact model, effort, working directory, and authentication. Give each runner continuation a new run directory.

| Executor                       | Continue with                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Claude worker           | `SendMessage` to the exact agent ID. It resumes a stopped agent from its transcript.                                                                          |
| Native Codex worker            | `followup_task` on the same agent after `interrupt_agent` or another stop.                                                                                    |
| `run-agy.mjs`                  | `--resume /absolute/prior/result.json`.                                                                           |
| `run-codex.mjs` on Claude Code | `--resume` with the receipt's `threadId`. A denied review also needs `--approve-review` and `--review-receipt`.                                               |
| `run-claude.mjs` on Codex      | `--resume` with the receipt's `sessionId`, with the approved `--allowed-tool` rule.                                                                            |

## Deadlines

Set a deadline only when the task itself has one. A deadline the task does not need turns work in progress into an interruption, and its continuation costs another turn.
