# Prompts worth copying

Swap in the real paths, skills, and done checks. Informal wording works.

## Understand

- `$pstack-codex:poteto-mode read <thread>. restate the underlying issue in your own words, in plain english.`
- `$pstack-codex:in-your-own-words <long or messy ask>`
- `$pstack-codex:sharpen <the prompt you're about to send>`
- `$pstack-codex:poteto-mode investigate why <symptom>. give me what we know, what data you used, and your best hypotheses. don't change any code yet.`
- `use $pstack-codex:how to understand <subsystem>. then use $pstack-codex:why to find out why it broke recently.`
- `$pstack-codex:recall my work on <topic> from last week, then read <issue>.`
- `$pstack-codex:teach me why you implemented it this way and not <other way>. what did you trade off?`
- `$pstack-codex:poteto-mode take over this branch. read the decision log, find what's done, and continue. don't redo finished work.`

## Build

- Bug: `$pstack-codex:poteto-mode <symptom>. repro first, then fix and verify.`
- Bug in an app: `$pstack-codex:poteto-mode repro this with $verify-<app>. if it repros on main, fix it and show me a video as proof.`
- Bug with a cheap test: `$pstack-codex:poteto-mode repro <bug> first. if there's a cheap test path, $pstack-codex:tdd it. then fix and rerun.`
- Feature: `$pstack-codex:poteto-mode add <behavior>. <current output> stays byte-identical. verify both.`
- Refactor: `$pstack-codex:poteto-mode move <code> into one module, zero behavior change. record the current output first and prove it's unchanged after.`
- Perf: `$pstack-codex:poteto-mode <operation> takes <time> on <fixture>. trace it, fix the measured cause, show me before and after.`

## Design and plan

- `$pstack-codex:poteto-mode prototype a few options for <feature>. take screenshots or videos for me to compare.`
- `$pstack-codex:poteto-mode we need <feature>. $pstack-codex:architect it first, and answer open questions with prototypes. let me review before proceeding.`
- `$pstack-codex:poteto-mode write a tutorial for how i would use <new package> first. then $pstack-codex:teach me why it beats the current one.`
- `ask $pstack-codex:arena for a second opinion on this thread and our approach.`
- `$pstack-codex:poteto-mode turn this design into a plan. small verifiable PRs, each with its own verification steps.`
- `$pstack-codex:poteto-mode plan the migration of <library> to <target>. small verifiable PRs. the result must match the original exactly, bugs included.`

## Review and ship

- `$pstack-codex:interrogate the whole branch, but skeptically. don't change anything yet. no nitpicks unless it's a real bug or regression.` Read the Dropped list too.
- `$pstack-codex:create-formal-verification-skill prove <property> holds in <module>, even when <steps> interleave or retry.` After merges or refactors in that code: `$pstack-codex:maintain-formal-verification-skill`.
- `$pstack-codex:swarm check every package under <dir> against its check script. one worker per package. one report.`
- `$pstack-codex:poteto-mode open the pr. small ordered commits, evidence in the description.`
- `$pstack-codex:poteto-mode babysit this pr. get it green.` For status only: `$pstack-codex:poteto-mode check on pr <number>. anything outstanding?`
- `$pstack-codex:poteto-mode land the stack.`

## Away and back

- `$pstack-codex:poteto-mode im going to bed. <goal> in a fresh worktree off <base>. done means <checks>. keep a decision log. don't ask me before committing. use the Codex event-watch and heartbeat binding until done. if you're truly stuck after a few hours, stop and write up why.`
- `$pstack-codex:show-me-your-work catch me up on what you did last night.` Read its Attention section first.
- `$pstack-codex:ketchup` catches you up on this chat since your last message and lists every call that waits on you.
- `$pstack-codex:poteto-mode full autopilot on this queue. each item is independent.`
- `$pstack-codex:poteto-mode autopilot these changes, but don't merge. i'll land them.`
- `$pstack-codex:reflect capture what we learned so the next run doesn't repeat it.` Approve only edits that change a future decision.
- `$pstack-codex:bro` restates the last reply in plain words.
