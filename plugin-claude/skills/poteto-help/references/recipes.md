# Prompts worth copying

Swap in the real paths, skills, and done checks. Informal wording works.

## Understand

- `/pstack-cc:poteto-mode read <thread>. restate the underlying issue in your own words, in plain english.`
- `/pstack-cc:in-your-own-words <long or messy ask>`
- `/pstack-cc:sharpen <the prompt you're about to send>`
- `/pstack-cc:poteto-mode investigate why <symptom>. give me what we know, what data you used, and your best hypotheses. don't change any code yet.`
- `use /pstack-cc:how to understand <subsystem>. then use /pstack-cc:why to find out why it broke recently.`
- `/pstack-cc:recall my work on <topic> from last week, then read <issue>.`
- `/pstack-cc:teach me why you implemented it this way and not <other way>. what did you trade off?`
- `/pstack-cc:poteto-mode take over this branch. read the decision log, find what's done, and continue. don't redo finished work.`

## Build

- Bug: `/pstack-cc:poteto-mode <symptom>. repro first, then fix and verify.`
- Bug in an app: `/pstack-cc:poteto-mode repro this with /verify-<app>. if it repros on main, fix it and show me a video as proof.`
- Bug with a cheap test: `/pstack-cc:poteto-mode repro <bug> first. if there's a cheap test path, /pstack-cc:tdd it. then fix and rerun.`
- Feature: `/pstack-cc:poteto-mode add <behavior>. <current output> stays byte-identical. verify both.`
- Refactor: `/pstack-cc:poteto-mode move <code> into one module, zero behavior change. record the current output first and prove it's unchanged after.`
- Perf: `/pstack-cc:poteto-mode <operation> takes <time> on <fixture>. trace it, fix the measured cause, show me before and after.`

## Design and plan

- `/pstack-cc:poteto-mode prototype a few options for <feature>. take screenshots or videos for me to compare.`
- `/pstack-cc:poteto-mode we need <feature>. /pstack-cc:architect it first, and answer open questions with prototypes. let me review before proceeding.`
- `/pstack-cc:poteto-mode write a tutorial for how i would use <new package> first. then /pstack-cc:teach me why it beats the current one.`
- `ask /pstack-cc:arena for a second opinion on this thread and our approach.`
- `/pstack-cc:poteto-mode turn this design into a plan. small verifiable PRs, each with its own verification steps.`
- `/pstack-cc:poteto-mode plan the migration of <library> to <target>. small verifiable PRs. the result must match the original exactly, bugs included.`

## Review and ship

- `/pstack-cc:interrogate the whole branch, but skeptically. don't change anything yet. no nitpicks unless it's a real bug or regression.` Read the Dropped list too.
- `/pstack-cc:create-formal-verification-skill prove <property> holds in <module>, even when <steps> interleave or retry.` After merges or refactors in that code: `/pstack-cc:maintain-formal-verification-skill`.
- `/pstack-cc:swarm check every package under <dir> against its check script. one worker per package. one report.`
- `/pstack-cc:poteto-mode open the pr. small ordered commits, evidence in the description.`
- `/pstack-cc:poteto-mode babysit this pr. get it green.` For status only: `/pstack-cc:poteto-mode check on pr <number>. anything outstanding?`
- `/pstack-cc:poteto-mode land the stack.`

## Away and back

- `/pstack-cc:poteto-mode im going to bed. <goal> in a fresh worktree off <base>. done means <checks>. keep a decision log. don't ask me before committing. /loop until done. if you're truly stuck after a few hours, stop and write up why.`
- `/pstack-cc:show-me-your-work catch me up on what you did last night.` Read its Attention section first.
- `/pstack-cc:ketchup` catches you up on this chat since your last message and lists every call that waits on you.
- `/pstack-cc:poteto-mode full autopilot on this queue. each item is independent.`
- `/pstack-cc:poteto-mode autopilot these changes, but don't merge. i'll land them.`
- `/pstack-cc:reflect capture what we learned so the next run doesn't repeat it.` Approve only edits that change a future decision.
- `/pstack-cc:bro` restates the last reply in plain words.
