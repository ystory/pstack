---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Read [Claude Code execution](../poteto-mode/references/execution.md) and resolve the ordered `arena runners` list with worker kind `general-purpose`. Run one seat per entry, including duplicates and aliases. A parent alias binds to the actual native Claude parent. If the selected executor rejects a model, use the closest valid model of the same family from its error or drop the seat, keep at least two runners, and say so. Never resubmit a rejected model. Families go by model prefix, and the longest match wins, such as `claude-fable-*`, `claude-*`, `gemini-*`, and `gpt-*`, after dropping a leading `cursor-`. Any other model's family is its text before the first hyphen when its lineage is known. Spawn more for multiple design directions, and repeat one model when the work is generation-bound, not judgment-sensitive. Apply poteto-mode's task effort guidance.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N workers asynchronously through [Claude Code execution](../poteto-mode/references/execution.md), with worker kind `general-purpose`. Each gets the task, shared grounding path, its exclusive worktree or output path, and instructions to produce the artifact and a short rationale naming alternatives considered and rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, resolve `arena cross-judge pool` with worker kind `read-only` and launch one read-only judge. The judge is never from the actual parent's vendor, and Fable counts as Claude for that check, so use the first entry from another vendor in pool order. Compare the judge with the parent, not with every candidate. A parent alias is the parent model and never judges. If the parent's model is unknown, use the first real model entry and disclose that the vendor check did not run. If the executor rejects a model, use the closest valid model of the same family, then the next such entry, or skip the judge, and say so. Never resubmit a rejected model. While you read in Phase D, the judge scores each candidate, by sanitized path label, on each rubric criterion and recommends a base.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
