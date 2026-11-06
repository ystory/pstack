# Set up pstack

In this page you install the plugin, pick which models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

Install from the GitHub marketplace described in the [plugin README](../../README.md). No repository build is needed:

```sh
codex plugin marketplace add https://github.com/ystory/pstack.git
codex plugin add pstack-codex@pstack-codex
```

For a local distribution artifact, replace the GitHub URL with its absolute directory path. Both routes use the same marketplace identity. The [repository README](https://github.com/ystory/pstack#update-or-restore) explains updates and switching from an existing local marketplace.

Start a new Codex chat in your project and select `$pstack-codex:setup-pstack`. Installing the plugin and running setup are separate steps.

## Choose workers and models

Run the installed setup skill.

```text
$pstack-codex:setup-pstack
```

First choose native Codex only, or Codex with Claude Code workers. The parent chat stays in Codex. Only selected CLIs need installation and login. Setup guides any needed authorized installation and human authentication, then rechecks the CLI before model selection. Reuse existing login. See [CLI preparation](../../skills/setup-pstack/references/cli-prerequisites.md).

Then choose supported exact models, role assignments, and one of `unlimited`, `large`, `medium`, or `small`. Setup shows all 17 roles with unresolved slots on a fresh install. No fixed model is required. It retains your saved choices on reruns. Model catalogs and confirmed per-model source evidence establish choices. CLI syntax alone does not establish account access.

Review the accepted selections before saving. Setup stores `$CODEX_HOME/pstack-codex/models.json`, defaulting to `~/.codex/pstack-codex/models.json`. Only accepted roles are saved. A role left unconfigured uses the actual native parent with disclosure. Scalars have one entry and initial panels or pools have two.

`auto` and `inherit-parent` bind to the current native parent's model and effort. Exact choices carry model and effort separately. A budget change retains exact models and selects each model's highest supported effort at or below its target. The targets are `max`, `xhigh`, `high`, and `medium` respectively. Parent aliases keep the parent's actual settings.

Panels run every ordered entry, including duplicates. Arena's ordered cross-judge pool selects one eligible judge from another family. Parent aliases do not establish that relationship. Arena skips its judge with disclosure if no selected eligible choice runs. Other required diversity gates keep their existing unmet outcome. No optional CLI is required for unrelated steps.

Start a fresh Codex chat after registration so the native host discovers the roles. The [model contract](../../skills/setup-pstack/references/models-contract.md) describes saved shapes and ownership. For a fresh replacement of an old install, unregister and remove the old plugin before installing the new identity. There is no automatic migration or old-name alias.

## Accept the verification offers, or don't

At the end of setup, `$pstack-codex:setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`$pstack-codex:create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.agents/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `$pstack-codex:create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to pstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`$pstack-codex:create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

Setup also registers pstack's two custom agent roles under `$CODEX_HOME/agents/`, or `~/.codex/agents/` by default. After setup, start a new Codex chat so it discovers the registered agents and generated project skills. A successful file write alone does not prove discovery.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `$pstack-codex:setup-pstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `$pstack-codex:poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
$pstack-codex:poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `$pstack-codex:poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups to continue the task. Include `$pstack-codex:poteto-mode` again when you want to select it explicitly. Codex uses [skill mentions](https://learn.chatgpt.com/docs/skills-and-plugins#use-skills-for-repeatable-work); the mention selects a skill for the request. If you want a standing project instruction for new chats, ask the agent to add it to your project's `AGENTS.md` and review that instruction before activating it.

Next: [Route work through `$pstack-codex:poteto-mode`](./02-poteto-mode.md).
