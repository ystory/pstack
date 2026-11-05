---
name: poteto-help
description: Guides users through pstack setup, /pstack-cc:poteto-mode, and picking the skill, playbook, or principle for a task. Type /pstack-cc:poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Read [`poteto-mode`](../poteto-mode/SKILL.md), do the work under it, and apply the selected playbook.

This file maps questions to the skills and guide pages that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. The links here point into the installed plugin, which the user may not be able to open, so give the user the file's public copy: `https://github.com/ystory/pstack/blob/main/plugin-claude/` followed by its path.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/pstack-cc:poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- A missing setup preferences file means `/pstack-cc:setup-pstack` hasn't run for this user, so missing roles inherit the actual native parent with disclosure and original cardinality.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/pstack-cc:create-verification-skill` when the question is about proving a change works.
- No formal verification skill in the project means no property is checked past what tests reach. Mention `/pstack-cc:create-formal-verification-skill` when the question is about a race, an invariant, or another case tests rarely hit. When one exists and the code it covers changed after the commit it records as last in sync, mention `/pstack-cc:maintain-formal-verification-skill` if the question touches that code.

When the model preferences is missing and it matters, ask whether the user wants to pick a model for each role and a reasoning budget now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. If the need is also unclear, ask both questions together. Offer two choices:

- Now: give them `/pstack-cc:setup-pstack` to type, and answer their question too.
- Later: answer their question, and add one line saying unconfigured roles inherit the native parent, while saved choices remain authoritative.

## Get set up

1. Add `ystory/pstack` through `/plugin marketplace add`, then install `pstack-cc@pstack-cc`.
2. Run [`/pstack-cc:setup-pstack`](../setup-pstack/SKILL.md). Choose worker executors first. Setup checks installation and authentication only for selected CLIs and guides any needed installation and human login. Then choose supported models, role assignments, and a reasoning budget. Review and save the independent preferences and register exact-model agents. Start a new session afterward. Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.
3. Start a real task with `/pstack-cc:poteto-mode`, a goal, and a check that can pass or fail.

Installing changes nothing until the user invokes a skill. Only `/pstack-cc:setup-pstack` loads from the user's words. The [README](../../README.md) and [guide page 1](../../docs/guide/01-setup.md) have the details. Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pstack spends extra tokens on subagents and review panels. Rerun `/pstack-cc:setup-pstack` and pick a smaller budget or cheaper models. A role set to `auto` or `inherit-parent` runs on the chat's model, which saves tokens when the chat runs on Auto or a cheaper model. A shorter panel list runs fewer subagents, one for each entry. Save `/pstack-cc:poteto-mode` for work that needs rigor.

This distribution runs in Claude Code as `pstack-cc`. Use `/pstack-cc:setup-pstack`, then `/pstack-cc:<skill>`. Setup selects Claude or Codex workers per role without changing the parent chat's model. The [Claude Code binding](../../docs/harness/claude-code.md) links execution, transcripts, schedules, and concrete host limits.

## Start a task with `/pstack-cc:poteto-mode`

`/pstack-cc:poteto-mode` matches the task to a playbook, copies the playbook's steps into the todo list, and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one. [Guide page 2](../../docs/guide/02-poteto-mode.md) has examples.

Start each new task with `/pstack-cc:poteto-mode`. Follow-ups continue the active playbook. Claude Code does not offer Cursor's Custom Mode shortcut.

Link the [Claude Code skills docs](https://code.claude.com/docs/en/skills) when this comes up. Mid-chat, "new task" makes the mode match a fresh playbook. `/pstack-cc:poteto-mode` already uses `poteto-agent` for the subagents its playbook steps spawn. To get the same style from a subagent of your own, resolve its role with worker kind `poteto-agent` through [Claude Code execution](../poteto-mode/references/claude-execution.md).

## Pick a skill

The default answer is `/pstack-cc:poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`/pstack-cc:poteto-mode`](../poteto-mode/SKILL.md) |
| Check that the agent understood their goal and the problem before it starts | [`/pstack-cc:in-your-own-words`](../in-your-own-words/SKILL.md) |
| Get a prompt rewritten deeper, not bigger, before sending it: what a top professional would add, their raw material and methods, and an outside check. It returns the prompt and doesn't do the task | [`/pstack-cc:sharpen`](../sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`/pstack-cc:how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/pstack-cc:why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/pstack-cc:teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/pstack-cc:recall`](../recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in plain words and small visuals, with every item waiting on them listed and decidable from the reply alone | [`/pstack-cc:ketchup`](../ketchup/SKILL.md) |
| Catch up like `/pstack-cc:ketchup`, in a short subtitled video of slides, with the waiting calls as text under it | [`/pstack-cc:ketchup-video`](../ketchup-video/SKILL.md) |
| Know what a small diff could break outside itself | [`/pstack-cc:blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/pstack-cc:architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/pstack-cc:arena`](../arena/SKILL.md) |
| Run parallel checks over slices, or race workers, in exclusive worktrees | [`/pstack-cc:swarm`](../swarm/SKILL.md) |
| Have different models review a diff and try to break it | [`/pstack-cc:interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/pstack-cc:tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/pstack-cc:typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`/pstack-cc:no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/pstack-cc:unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/pstack-cc:technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/pstack-cc:bro`](../bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/pstack-cc:create-verification-skill`](../create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`/pstack-cc:maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Formally verify a race, invariant, or other property that tests rarely reach | [`/pstack-cc:create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) |
| Bring a formal verification back in line after the code it covers changed, and learn whether a failure is drift or a bug | [`/pstack-cc:maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) |
| Show a PM or designer what the user sees as a chart checked by a TLA+ model, with the shortest path to each state that breaks a rule | [`/pstack-cc:statechart`](../statechart/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`/pstack-cc:benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/pstack-cc:figure-it-out`](../figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`/pstack-cc:show-me-your-work`](../show-me-your-work/SKILL.md) |
| Pick a model for each role and a reasoning budget | [`/pstack-cc:setup-pstack`](../setup-pstack/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`/pstack-cc:automate-me`](../automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`/pstack-cc:reflect`](../reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`/pstack-cc:correct`](../correct/SKILL.md) |
| Build a page whose buttons wake a configured Claude channel over a webhook | [`/pstack-cc:make-bot-ui`](../make-bot-ui/SKILL.md) |
| Find their way around pstack | `/pstack-cc:poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `/pstack-cc:how` explains what the code does. `/pstack-cc:why` explains the reasons. `/pstack-cc:teach` runs one or both and explains the result plainly.
- `/pstack-cc:arena` gives every worker the same brief and merges the best parts. `/pstack-cc:swarm` splits work into slices or a race and returns one report.
- `/pstack-cc:architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `/pstack-cc:interrogate` reviews the diff. `/pstack-cc:blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/pstack-cc:recall` rebuilds context across recent chats. `/pstack-cc:ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/pstack-cc:figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in pstack:

- `deslop`, `control-cli`, and `control-ui` are bundled from `cursor-team-kit`. Read their installed skill paths.
- Native `/loop` uses [Claude Code wakeups](../poteto-mode/references/claude-wakeups.md). Skill authoring uses the [native authoring binding](../poteto-mode/references/skill-authoring.md).
- pstack has no `/orchestrate` skill. Orchestrate is a `/pstack-cc:poteto-mode` playbook. If the slash menu shows `/orchestrate`, another plugin provides it.

## Playbooks and principles

Playbooks are step lists inside `/pstack-cc:poteto-mode`, not skills, so they have no slash command. Inside `/pstack-cc:poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "autopilot, don't merge" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

Without `/pstack-cc:poteto-mode`, a phrase such as "babysit this pr" can start another skill for the same job instead. The Playbooks section of [`poteto-mode`](../poteto-mode/SKILL.md) lists every playbook and when it applies. [Guide page 6](../../docs/guide/06-verify-and-ship.md) covers opening, babysitting, and landing a PR.

pstack has no planning skill. Claude Code Plan Mode works alongside it. For work that spans phases or stacked PRs, asking `/pstack-cc:poteto-mode` for a plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `/pstack-cc:architect` settles it in code first.

Principles are one-rule skills that `/pstack-cc:poteto-mode` reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `/principle-<name>` still loads one on demand. [Guide page 8](../../docs/guide/08-principles.md) lists them.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | Read the active skill again, and start each new task with `/pstack-cc:poteto-mode`. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | Rerun setup to refresh owned native definitions, then start a new chat. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | Only `/pstack-cc:setup-pstack` loads from the user's words. The others load when the user types them or when `/pstack-cc:poteto-mode` runs them, and it doesn't run every skill. |
| Parallel agents overwrote each other | Give every writer its own worktree and separately assign ports, caches, and data directories. |
| An overnight run moved but finished nothing | `/loop` needs a check that can pass or fail, not a duration. See [guide page 7](../../docs/guide/07-overnight.md). |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers. [Guide page 10](../../docs/guide/10-recipes-and-pitfalls.md) has more pitfalls and the recipes worth copying.

## Make pstack my own

- [`/pstack-cc:automate-me`](../automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside `/pstack-cc:poteto-mode`.
- [`/pstack-cc:reflect`](../reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `/pstack-cc:poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

[Guide page 9](../../docs/guide/09-make-it-yours.md) covers each of these.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
