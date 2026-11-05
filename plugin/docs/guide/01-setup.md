# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

Install from the GitHub marketplace described in the [plugin README](../../README.md). No repository build is needed:

```sh
codex plugin marketplace add https://github.com/ystory/pstack.git
codex plugin add pstack-for-codex@pstack-for-codex
```

For a local distribution artifact, replace the GitHub URL with its absolute directory path. Both routes use the same marketplace identity. The [repository README](https://github.com/ystory/pstack#update-or-restore) explains updates and switching from an existing local marketplace.

Start a new Codex chat in your project and select `$pstack-for-codex:setup-pstack`. Installing the plugin and running setup are separate steps.

Original pstack also installs in Claude Code with `/plugin marketplace add cursor/plugins`, then `/plugin install pstack@cursor-plugins`. Its [Claude Code adapter](../harness/claude-code.md) covers that setup and its `pstack:` command prefix. This distribution uses the [Claude CLI bridge](../../skills/poteto-mode/references/codex-execution.md) from a Codex parent.

## Pick your models

Run:

```text
$pstack-for-codex:setup-pstack
```

[`$pstack-for-codex:setup-pstack`](../../skills/setup-pstack/SKILL.md) reads the native model catalog, confirms external model choices and their supported efforts, asks for a reasoning budget, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `$CODEX_HOME/pstack-for-codex/models.json`, or `~/.codex/pstack-for-codex/models.json` when `CODEX_HOME` is unset. Every pstack skill resolves its model roles from this user-owned configuration.

Ordinary roles, including explanation, judgment, and synthesis, default to Sol 6.1 through Codex. The hardest-task role defaults to Opus 5.5 through Claude Code. The three candidate and reviewer lists and the cross-judge pool default to `[Sol 6.1, Opus 5.5]`. The original requirements for a different model or model family still apply to audits, verification, and retries.

Claude runs need an existing, authenticated Claude Code CLI 2.1.280 or newer. Setup checks the executable path, version, and supported options. Runs reuse its existing authentication. It does not install Claude Code or change its global settings. The parent agent passes the task and needed instructions and file paths to the bundled [Claude runner](../../skills/poteto-mode/scripts/run-claude.mjs). Detection reports global CLI effort syntax and does not enumerate account models. You can select another supported exact Claude ID with model-specific source evidence, as described in the [model contract](../../skills/setup-pstack/references/models-contract.md#model-capability-records). Setup retains a labeled Opus default for the shipped route. Neither CLI detection nor that default proves account access or successful execution.

The defaults run at `xhigh` reasoning, the same as the `large` budget. `unlimited` targets `max`; each model uses its highest supported level at or below the target. `medium` and `small` target `high` and `medium`. Model IDs and executors stay unchanged when the reasoning budget changes.

You only override what you care about. A role absent from `roles` keeps the skill's default. To restore a default, remove that role's entry. A rerun of `$pstack-for-codex:setup-pstack` keeps your existing choices. Saved choices stay separate from plugin updates; when a default changes, a saved old choice stays pinned until you remove or change it. For an existing all-Sol configuration, setup shows the proposed mixed defaults separately and asks before saving any change.

Preferences containing a Claude executor use schema 2. Earlier mixed bundles pinned to Opus reject saved nondefault Claude entries; explicitly save choices they support before restoring them. Older all-Sol bundles reject that format and preserve the file. Before restoring one of those bundles, use the current setup to explicitly choose Codex models for every role and save a native-only configuration; it uses schema 1. This conversion changes your choices only when you request it.

You might be wondering what happens if you use Auto. Set a role to `inherit-parent` or `auto` to select your current parent chat's model and reasoning settings. Both values mean the same thing, and neither is a model slug. The [Codex execution binding](../../skills/poteto-mode/references/codex-execution.md#roles-models-and-effort) omits overrides only when that preserves the parent selection; otherwise it passes the observed parent settings. If those settings or effective inheritance cannot be established, the alias is reported as unresolved. For a panel role the value is an ordered list of objects, each with a `model`, optional `reasoningEffort`, and optional `executor`. Omitted `executor` retains the native Codex path; `claude-code` selects the external CLI. One worker runs per entry, so the list length sets the panel size; repeated model IDs remain separate seats. Setup also configures `swarm workers`, the default model for every `$pstack-for-codex:swarm` worker unless a race names a model for each arm.

## Accept the verification offers, or don't

At the end of setup, `$pstack-for-codex:setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`$pstack-for-codex:create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.agents/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `$pstack-for-codex:create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`$pstack-for-codex:create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

Setup also registers pstack's two custom agent roles under `$CODEX_HOME/agents/`, or `~/.codex/agents/` by default. After setup, start a new Codex chat so it discovers the registered agents and generated project skills. A successful file write alone does not prove discovery.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `$pstack-for-codex:setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `$pstack-for-codex:poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
$pstack-for-codex:poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `$pstack-for-codex:poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups to continue the task. Include `$pstack-for-codex:poteto-mode` again when you want to select it explicitly. Codex uses [skill mentions](https://learn.chatgpt.com/docs/skills-and-plugins#use-skills-for-repeatable-work); the mention selects a skill for the request. If you want a standing project instruction for new chats, ask the agent to add it to your project's `AGENTS.md` and review that instruction before activating it.

Next: [Route work through `$pstack-for-codex:poteto-mode`](./02-poteto-mode.md).
