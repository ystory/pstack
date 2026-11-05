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
3. Pick the runners. Read [Claude Code execution](../poteto-mode/references/claude-execution.md) and resolve the ordered `arena runners` list with worker kind `general-purpose`. Run one seat per entry, including duplicates and aliases. A parent alias binds to the actual native Claude parent. Families go by model prefix, such as `claude-*`, `gpt-*`, and `grok-*`, with `cursor-grok-*` and `composer-*` in Grok's family. If the selected executor rejects a model, try the closest valid model of the same family from its error, or drop the seat and say so. Never resubmit a rejected model. If dropouts leave fewer than two runners, add runners until there are two, or one when the configured list has one entry. Use a remaining runner's model for additions, or bind to the actual native parent when none remain, and say so. Spawn more runners when the arena covers multiple design directions. Use the same model N times when generation capacity matters more than judgment diversity. Apply poteto-mode's task effort and speed guidance.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N workers asynchronously through [Claude Code execution](../poteto-mode/references/claude-execution.md), with worker kind `general-purpose`. Each gets the task, shared grounding path, its exclusive worktree or output path, and instructions to produce the artifact and a short rationale naming alternatives considered and rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, resolve `arena cross-judge pool` with worker kind `read-only`. Select one read-only judge from a family other than the actual parent's, in pool order. Parent aliases never judge. Compare the judge with the parent, not with every candidate. If the executor rejects an entry, try a supported setting of the same model, or move to the next eligible entry. Never resubmit a rejected model. If no selected eligible entry runs, skip the judge, pick the base alone in Phase D, and say so. If the parent's model is unknown, try real model entries in order and disclose that the family check did not run. The judge sees the rubric and candidates by sanitized path label. It scores each criterion and recommends a base with rationale. Run it in parallel with your Phase D reading, after candidates stop writing.

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
