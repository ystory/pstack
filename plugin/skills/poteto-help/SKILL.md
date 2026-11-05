---
name: poteto-help
description: Guides users through pstack setup, $pstack-for-codex:poteto-mode, and picking the skill, playbook, or principle for a task. Type $pstack-for-codex:poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Read [`poteto-mode`](../poteto-mode/SKILL.md), do the work under it. Invoke the skill explicitly at the start of each task; a Codex chat has no Cursor Custom Mode to configure.

This file maps questions to the skills and guide pages that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. Resolve links to the actual installed absolute file paths so the user can inspect this Codex adaptation. Use the pinned upstream public source only when explaining original pstack behavior; it does not describe the Codex execution bindings.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `$pstack-for-codex:poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- Read the setup helper's model configuration with its absolute `scripts/models.mjs read` command. `source: default` means no saved Codex role configuration, so every role uses its bundled default.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `$pstack-for-codex:create-verification-skill` when the question is about proving a change works.
- No formal verification skill in the project means no property is checked past what tests reach. Mention `$pstack-for-codex:create-formal-verification-skill` when the question is about a race, an invariant, or another case tests rarely hit. When one exists and the code it covers changed after the commit it records as last in sync, mention `$pstack-for-codex:maintain-formal-verification-skill` if the question touches that code.

When the model rule is missing and it matters, ask whether the user wants to pick a model for each role and a reasoning budget now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. If the need is also unclear, ask both questions together. Offer two choices:

- Now: give them `$pstack-for-codex:setup-pstack` to type, and answer their question too.
- Later: answer their question, and add one line saying every role keeps its default model until they run `$pstack-for-codex:setup-pstack`.

## Get set up

1. Install this Codex plugin using the path described in the bundled [README](../../README.md) and setup guide. Distinguish source packaging from runtime discovery and activation.
2. Run [`$pstack-for-codex:setup-pstack`](../setup-pstack/SKILL.md). It asks for a reasoning budget, maps a model to each role, and saves user-global Codex role configuration and registers the bundled custom agents. Start a new chat after registration so native agent discovery can reload them. Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.
3. Start a real task with `$pstack-for-codex:poteto-mode`, a goal, and a check that can pass or fail.

`$pstack-for-codex:setup-pstack`, `$pstack-for-codex:control-ui`, `$pstack-for-codex:control-cli`, and `$pstack-for-codex:deslop` allow implicit invocation from the user's words. The other bundled skills load when the user invokes them explicitly or when `$pstack-for-codex:poteto-mode` reads them for a task. The [README](../../README.md) and [guide page 1](../../docs/guide/01-setup.md) have the details. Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pstack spends extra tokens on subagents and review panels. Rerun `$pstack-for-codex:setup-pstack` and pick a smaller budget or cheaper models. A role set to `auto` or `inherit-parent` runs on the chat's actual model through the parent-selection binding in **Codex execution**; omitted native parameters alone do not prove inheritance. A shorter panel list runs fewer subagents, one for each entry. Save `$pstack-for-codex:poteto-mode` for work that needs rigor.

This distribution defaults to Sol through native Codex subagents and Opus 5.5 through Claude Code. Saved supported model choices override those defaults. Shared role configuration, project-scoped history, and event-watch/heartbeat continuation bind those workers to this host. Read [Codex execution](../poteto-mode/references/codex-execution.md) for these bindings and their permission boundaries. Worktrees replace cloud placement by the approved choice and share machine resources. The diversity panels default to Sol and Opus. Original different-model and different-family requirements still apply.

## Start a task with `$pstack-for-codex:poteto-mode`

`$pstack-for-codex:poteto-mode` matches the task to a playbook, copies the playbook's steps into the todo list, and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one. [Guide page 2](../../docs/guide/02-poteto-mode.md) has examples.

Load the mode for each task:
- Invoke `$pstack-for-codex:poteto-mode` explicitly at the start of each task. Its instructions remain part of this task's context; a fresh task gets a fresh invocation.
- Codex supports explicit skill references, not Cursor Custom Modes. Persisting this mode in project guidance is a separate activation choice.

Mid-chat, "new task" makes the mode match a fresh playbook. `$pstack-for-codex:poteto-mode` already uses `poteto-agent` for its playbook delegates. For a subagent of your own, select `agent_type: "poteto-agent"` on the native path or pass its original instruction file on the Claude Code path through [Codex execution](../poteto-mode/references/codex-execution.md).

## Pick a skill

The default answer is `$pstack-for-codex:poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`$pstack-for-codex:poteto-mode`](../poteto-mode/SKILL.md) |
| Check that the agent understood their goal and the problem before it starts | [`$pstack-for-codex:in-your-own-words`](../in-your-own-words/SKILL.md) |
| Get a prompt rewritten deeper, not bigger, before sending it: what a top professional would add, their raw material and methods, and an outside check. It returns the prompt and doesn't do the task | [`$pstack-for-codex:sharpen`](../sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`$pstack-for-codex:how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`$pstack-for-codex:why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`$pstack-for-codex:teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`$pstack-for-codex:recall`](../recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in plain words and small visuals, with every item waiting on them listed and decidable from the reply alone | [`$pstack-for-codex:ketchup`](../ketchup/SKILL.md) |
| Catch up like `$pstack-for-codex:ketchup`, in a short subtitled video of slides, with the waiting calls as text under it | [`$pstack-for-codex:ketchup-video`](../ketchup-video/SKILL.md) |
| Know what a small diff could break outside itself | [`$pstack-for-codex:blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`$pstack-for-codex:architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`$pstack-for-codex:arena`](../arena/SKILL.md) |
| Run parallel checks over slices, or race workers, in dedicated local worktrees | [`$pstack-for-codex:swarm`](../swarm/SKILL.md) |
| Have different models review a diff and try to break it | [`$pstack-for-codex:interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`$pstack-for-codex:tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`$pstack-for-codex:typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`$pstack-for-codex:no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`$pstack-for-codex:unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`$pstack-for-codex:technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`$pstack-for-codex:bro`](../bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`$pstack-for-codex:create-verification-skill`](../create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`$pstack-for-codex:maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Formally verify a race, invariant, or other property that tests rarely reach | [`$pstack-for-codex:create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) |
| Bring a formal verification back in line after the code it covers changed, and learn whether a failure is drift or a bug | [`$pstack-for-codex:maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) |
| Show a PM or designer what the user sees as a chart checked by a TLA+ model, with the shortest path to each state that breaks a rule | [`$pstack-for-codex:statechart`](../statechart/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`$pstack-for-codex:benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`$pstack-for-codex:figure-it-out`](../figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`$pstack-for-codex:show-me-your-work`](../show-me-your-work/SKILL.md) |
| Pick a model for each role and a reasoning budget | [`$pstack-for-codex:setup-pstack`](../setup-pstack/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`$pstack-for-codex:automate-me`](../automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`$pstack-for-codex:reflect`](../reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`$pstack-for-codex:correct`](../correct/SKILL.md) |
| Build a page whose buttons wake a Grok Bot over a webhook | [`$pstack-for-codex:make-bot-ui`](../make-bot-ui/SKILL.md) |
| Find their way around pstack | `$pstack-for-codex:poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `$pstack-for-codex:how` explains what the code does. `$pstack-for-codex:why` explains the reasons. `$pstack-for-codex:teach` runs one or both and explains the result plainly.
- `$pstack-for-codex:arena` gives every worker the same brief and merges the best parts. `$pstack-for-codex:swarm` splits work into slices or a race and returns one report.
- `$pstack-for-codex:architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `$pstack-for-codex:interrogate` reviews the diff. `$pstack-for-codex:blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `$pstack-for-codex:recall` rebuilds context across recent chats. `$pstack-for-codex:ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `$pstack-for-codex:figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Companion bindings:

- `$pstack-for-codex:deslop`, `$pstack-for-codex:control-cli`, and `$pstack-for-codex:control-ui` are bundled unchanged from the pinned `cursor-team-kit` source. They provide code cleanup and browser/terminal harness guidance; repository-managed source updates track them together with pstack.
- Skill authoring uses Codex's `skill-creator`. Repeated work uses the [Codex event-watch and heartbeat binding](../poteto-mode/references/codex-loops.md).
- pstack has no `$orchestrate` skill. Orchestrate is a `$pstack-for-codex:poteto-mode` playbook. If the skill picker shows `$orchestrate`, another plugin provides it.

## Playbooks and principles

Playbooks are step lists inside `$pstack-for-codex:poteto-mode`, not skills, so they have no standalone skill invocation. Inside `$pstack-for-codex:poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "autopilot, don't merge" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

Without an explicit invocation of `$pstack-for-codex:poteto-mode`, a phrase such as "babysit this pr" may select another available skill for the same job. The Playbooks section of [`poteto-mode`](../poteto-mode/SKILL.md) lists every playbook and when it applies. [Guide page 6](../../docs/guide/06-verify-and-ship.md) covers opening, babysitting, and landing a PR.

pstack has no planning skill. Codex's Plan mode works alongside it. For work that spans phases or stacked PRs, asking `$pstack-for-codex:poteto-mode` for a plan runs the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `$pstack-for-codex:architect` settles it in code first.

Principles are one-rule skills that `$pstack-for-codex:poteto-mode` reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `$pstack-for-codex:principle-<name>` still loads one on demand. [Guide page 8](../../docs/guide/08-principles.md) lists them.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | Invoke `$pstack-for-codex:poteto-mode` at the start of each task. A Codex chat does not offer Cursor Custom Modes. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | The rule from `$pstack-for-codex:setup-pstack` applies to new chats. Start one. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | `$pstack-for-codex:setup-pstack`, `$pstack-for-codex:control-ui`, `$pstack-for-codex:control-cli`, and `$pstack-for-codex:deslop` allow implicit invocation. The others load when the user invokes them explicitly or when `$pstack-for-codex:poteto-mode` reads them for a task, and it doesn't read every skill. |
| Parallel agents overwrote each other | Give each agent its own worktree and independent app ports/data/session resources. Serialize resources the host cannot isolate. |
| An overnight run moved but finished nothing | Codex continuation needs a check that can pass or fail, an event watcher or heartbeat, and a saved resume point. See [guide page 7](../../docs/guide/07-overnight.md). |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers. [Guide page 10](../../docs/guide/10-recipes-and-pitfalls.md) has more pitfalls and the recipes worth copying.

## Make pstack my own

- [`$pstack-for-codex:automate-me`](../automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside `$pstack-for-codex:poteto-mode`.
- [`$pstack-for-codex:reflect`](../reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `$pstack-for-codex:poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

[Guide page 9](../../docs/guide/09-make-it-yours.md) covers each of these.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
