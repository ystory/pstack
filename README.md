# pstack for Codex and Claude Code

An unofficial Codex adaptation of [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) workflows, skills, and agents. It also bundles the `control-ui`, `control-cli`, and `deslop` skills from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit). The source snapshots are pinned, and each host has its own reproducible adaptation series. The existing Codex product is `pstack-for-codex`. The separate Claude Code product is `pstack-cc` and supports setup-selected Claude or Codex workers. See [Install in Claude Code](#install-in-claude-code).

In the Codex distribution, ordinary roles default to Sol 6.1 through Codex. The hardest tasks use Opus 5.5 through an existing Claude Code CLI, and candidate and review panels use both models. The default configuration requires an installed, authenticated Claude Code CLI with Opus 5.5 access.

Setup can save an all-Sol configuration, but that configuration cannot satisfy upstream steps requiring a different model or model family, such as Orchestrate's per-PR verifier, the final audit in `show-me-your-work`, and the eval playbook. Arena instead reports when it cannot run a judge from another family and continues without that judge. See the [plugin manifest](plugin/plugin.json) for the current version and the [compatibility notes](docs/spec.md) for verified workflows and limitations.

![pstack for Codex workflow: route a task through a playbook and situational skills, prove the result, and return the appropriate outcome.](docs/assets/pstack-for-codex-workflow.png)

The playbook determines which skills and agents to use; the result can be an answer, a change, or a PR. See [Design and compatibility](docs/spec.md) for execution details, or open the [editable workflow map](docs/assets/pstack-for-codex-workflow.svg).

## Requirements

- Codex with plugin and native subagent support, signed in to an account with access to your selected models.
- Git for Codex to fetch the GitHub marketplace.
- Node.js 24.12+ for setup and the bundled runtime helpers.
- Python 3.11+ for agent registration, using its standard-library TOML parser. Setup uses `python3` by default and can select another existing interpreter.
- An installed, authenticated Claude Code CLI 2.1.280+ with Opus 5.5 access for the default Claude roles. Setup checks CLI capabilities; detection alone does not establish model access.
- Bun 1.2+ for the PR watcher helper. Its first use installs locked dependencies in a cache outside the plugin and may need network access. GitHub PR workflows also need an authenticated GitHub CLI (`gh`).
- Optional TLA+ statechart checks need Java and TLC. The first real check uses mise to install pinned tools unless existing tools are supplied. SVG rendering uses Pele separately. See the [statechart skill](plugin/skills/statechart/SKILL.md) for its commands and limits.

## Install

Add the GitHub marketplace, then install the plugin:

```sh
codex plugin marketplace add https://github.com/ystory/pstack-for-codex.git
codex plugin add pstack-for-codex@pstack-for-codex
```

Codex reads the repository's marketplace catalog and installs the committed `plugin/` directory. You do not need to clone the repository, install project dependencies, or build it first. See [Development and maintenance](docs/stack.md) to build and verify a local artifact instead.

## Set up and use

Open a Codex chat in your project and run:

```text
$pstack-for-codex:setup-pstack
```

Setup registers the two bundled agents and a general-purpose role, then saves your reasoning budget and role choices in `$CODEX_HOME/pstack-for-codex/models.json` (default `~/.codex/pstack-for-codex/models.json`). It preserves unrelated settings and stops on conflicts with user-edited managed files or declarations.

After setup, start a new chat so Codex discovers the registered roles. For a first walkthrough, try:

```text
$pstack-for-codex:how explain how this project starts up.
```

Use `$pstack-for-codex:poteto-mode` at the start of a development task to select a playbook, or `$pstack-for-codex:poteto-help` to find a suitable workflow. The [pstack guide](plugin/docs/guide/README.md) covers prompting, review, verification, and longer runs.

## Update or restore

For a GitHub installation, refresh the Git marketplace and explicitly reinstall the plugin:

```sh
codex plugin marketplace upgrade pstack-for-codex
codex plugin add pstack-for-codex@pstack-for-codex
```

Run `$pstack-for-codex:setup-pstack` again to synchronize its managed registrations, then start a new chat. Saved model choices are retained.

To switch an existing local `pstack-for-codex` marketplace to GitHub, run the two [install commands](#install) above, then rerun setup and start a new chat. Adding the Git URL selects that source for the same marketplace identity; `marketplace upgrade` alone does not turn a local source into a Git source. For building, selecting, or restoring local artifacts, see [Development and maintenance](docs/stack.md#build-and-select-an-artifact).

Before restoring an older all-Sol bundle, use the current setup to explicitly save Codex-only role choices: older helpers reject the mixed-executor schema 2, while native-only schema 1 remains compatible. This does not make all-Sol choices satisfy steps that require a different model or model family.

## Remove

Before removing the plugin, run `$pstack-for-codex:setup-pstack` and ask it to unregister its managed agents. This removes unchanged owned registrations and leaves your model preferences in place. Then remove the plugin:

```sh
codex plugin remove pstack-for-codex@pstack-for-codex
```

There is no automatic uninstall hook to clean up registered agents after the plugin is removed.

## Install in Claude Code

Claude Code uses a separate marketplace entry and plugin. In a Claude Code session:

```text
/plugin marketplace add ystory/pstack-for-codex
/plugin install pstack-cc@pstack-cc
/pstack-cc:setup-pstack
```

This installs the committed `plugin-claude/` target. It does not require the separate official Codex plugin. Setup selects an executor, exact model, and reasoning budget for each of the existing 17 roles. It does not choose your parent chat model. You can select native Claude workers, Codex workers, or both. Panels preserve ordered entries and duplicates, and required model-diversity gates still apply. Original unavailable Grok defaults need a supported choice. A temporary quota condition does not set permanent defaults.

Setup checks Node.js 24.12+, Claude Code capabilities and login, and the Codex CLI when you choose Codex workers. It guides missing CLI installation and human login. Use [Claude Code installation](https://code.claude.com/docs/en/setup), `claude auth login` or `/login`, and [Codex CLI installation](https://developers.openai.com/codex/cli) plus `codex login` as applicable. Authentication and model access are separate checks. The bundled worker runtime uses the existing Codex installation and credentials.

Claude preferences live at `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. Codex preferences remain under `$CODEX_HOME/pstack-for-codex/`. Setup manages only its owned native agent variants and retains preferences across updates and removal. Start a new Claude session after setup, then try `/pstack-cc:how explain how this project starts up.` or `/pstack-cc:poteto-mode` with your task.

To update, refresh the native marketplace with `/plugin marketplace update pstack-cc`, update from the shell with `claude plugin update pstack-cc@pstack-cc`, and rerun setup. Restore a prior local artifact through the [artifact workflow](docs/stack.md#build-and-select-an-artifact), then reinstall and rerun that bundle's setup. Before removing the plugin, ask setup to unregister its owned agents while the bundle is still available. Then run `/plugin uninstall pstack-cc@pstack-cc`. Native removal does not perform agent cleanup. Preferences remain.

The [Claude setup guide](plugin-claude/docs/guide/01-setup.md) covers installation and role choices. The [execution binding](plugin-claude/skills/poteto-mode/references/claude-execution.md) explains native agents, Codex background tasks, worktrees, transcripts, and host limits. The [compatibility record](docs/spec.md#verified-scope) separates source and fixture checks from actual workflow runs.

## Development and sources

For contributions:

1. Keep the pinned `upstream/` snapshots unchanged during adaptation work. Review source updates through the [upstream candidate workflow](docs/stack.md#review-an-upstream-update).
2. Implement Codex adaptations in `plugin/` or Claude Code adaptations in `plugin-claude/`. Record each target's change in its own series and [verify patch replay](docs/stack.md#record-an-adaptation).

- [Design and compatibility](docs/spec.md): adaptation behavior, source invariants, and verified runtime scope.
- [Development and maintenance](docs/stack.md): verification, patch management, upstream candidates, and artifact commands. The full verification workflow also requires `tar`.
- [Original pstack README](upstream/pstack/README.md): upstream project background.
- [pstack source lock](upstream.lock.json), [cursor-team-kit source lock](dependencies.lock.json), and [Codex worker runtime lock](codex-runtime.lock.json): pinned revisions, file mappings, and hashes.

The original Codex adaptation code and documentation are released under the [MIT license](LICENSE). The Codex bundle includes this license at `licenses/pstack-for-codex/LICENSE`; the Claude bundle uses `licenses/pstack-cc/LICENSE`. pstack is by Lauren Tan and retains its [MIT license](upstream/pstack/LICENSE). The bundled cursor-team-kit skills retain Cursor's [MIT license](upstream/cursor-team-kit/LICENSE). The Claude target also includes pinned official Codex worker code and its notices under `vendor/codex-plugin-cc/`. Original copyright and license notices are preserved in each distribution.
