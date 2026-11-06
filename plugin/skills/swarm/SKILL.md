---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Read [Codex execution](../poteto-mode/references/codex-execution.md) and resolve the `swarm workers` role with the sibling setup helper. A missing role uses the actual native parent with disclosure. For `auto` or `inherit-parent`, use Codex execution's parent-selection binding so the workers run on the parent model. If the selected executor rejects a model, follow the execution binding and disclose a supported same-family choice from its error message. For a model race, name each arm's configured model and executor up front; an explicit race uses the configured participants and their exact models. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give every code-writing worker an exclusive local worktree, branch, and writable output as described in Codex execution. Assign distinct machine resources, such as ports and data directories, when its verification uses them. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Create the worker checkouts from the detected repository default ref, or the caller's specified non-default ref. Resolve and record the starting SHA. Launch all N workers through Codex execution without waiting between them, selecting `agent_type: "pstack-general-purpose"` on the native path. Pass each step 3 entry's executor, model, and effort through its supported controls, using Codex execution's parent-selection binding for inherited aliases. Give each worker its absolute checkout, branch, input and output paths, required skill paths, and assigned host resources. Each writer is told that other workers are active and must preserve their changes.

A local worker can access resources on the user's computer, subject to the parent's permissions. Its brief must identify those resources and restrict commands to its assigned checkout and outputs. The worktree provides filesystem separation; it does not provide a separate VM or credentials.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Drain every worker and read its terminal report and artifacts. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
