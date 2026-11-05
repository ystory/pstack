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
3. Pick the runners using [Codex execution](../poteto-mode/references/codex-execution.md). Resolve the `arena runners` role with the sibling setup helper. An unconfigured list has two native-parent seats. Preserve the ordered entries, including duplicates. An `auto` or `inherit-parent` entry means the parent model. Bind it through Codex execution's parent-selection rules. Families follow model prefixes such as `gpt-*` and `claude-*`. If the selected executor rejects a configured model, use the closest valid model of the same family from its error message and disclose it. Drop the seat and say so when none is available. Do not retry a model already rejected by that executor. If dropped seats leave fewer than two runners, add runners until there are two, or one when the configured role has one entry. Run each added runner on a surviving runner's model and executor, or use Codex execution's parent-selection binding when none remain, and say so. An unavailable executor makes that seat unavailable. Disclose it and apply the dropped-seat rule without claiming that executor ran. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each candidate its own output location, per the **separate-before-serializing-shared-state** principle skill. Code-writing candidates get exclusive local Git worktrees and branches through Codex execution. Other artifacts can use `/tmp/arena-<slug>/candidate-<n>/`.

## Phase B: Fan out

Launch all N general-purpose delegates through Codex execution without waiting between them, using `agent_type: "pstack-general-purpose"` on the native path, each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, resolve the `arena cross-judge pool` role. Launch one general-purpose judge through Codex execution with a read-only brief, using `agent_type: "pstack-general-purpose"` on the native path. The judge must be from another model family than the parent, as Phase A step 3 defines families. Try only entries from another family, in pool order. An `auto` or `inherit-parent` entry is the parent model and never judges. If the selected executor rejects an entry, use a valid setting for that same model from the error message, or move to the next entry when none is available. Keep model, effort, and speed separate. If no selected eligible entry runs, skip the judge, pick the base alone in Phase D, and say so. Do not replace it with a judge from the parent's family. If the parent's model is unknown, try the pool's explicit model entries in order and say that the family check did not run. Pass this skill's absolute path and the candidates by path label. The judge sees the rubric, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

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
