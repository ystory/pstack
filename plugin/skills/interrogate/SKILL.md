---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill, with four changes. Resolve the `interrogate reviewers` role in place of `arena runners` through [Codex execution](../poteto-mode/references/codex-execution.md). Its defaults are native `gpt-6.1-sol` and Claude Code `claude-opus-5-5`. Preserve saved entries, ordered duplicate seats, and Arena's runner fallback. Start each adversary's exclusive local worktree at the scope's exact source HEAD. Copy the scope's actual uncommitted changes into every worktree through Codex execution's working-tree transfer, including scoped staged, unstaged, and untracked files. A supplied diff or a conversation fork does not copy those files. Launch each adversary through its selected executor, using `agent_type: "pstack-general-purpose"` on the native path. Pass absolute paths to this skill, the assigned worktree, required source files, and runnable tools. In place of the arena task and rationale, give each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify every finding yourself per arena Phase F by rerunning its exact command against the reviewed scope. Read the adversary's repro and run it in its isolated worktree, preserving the scope's input and any needed repro files. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.
