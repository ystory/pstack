# Set up pstack in Claude Code

Install the plugin, select workers for its roles, and run a first workflow. The Claude parent and worker executors are independent choices.

## Install

You need a Claude Code host with native plugin, Agent, effort, and background Bash support. Setup uses Node.js 24.12 or later. Codex worker choices also need an authenticated Codex CLI with the app-server capabilities checked by setup. GitHub workflows need Git and authenticated `gh`. The bundled PR watcher needs Bun 1.2 or later and installs locked dependencies in an external cache on first use.

The Claude preview is on the `codex/claude-workflows` branch. The repository's default branch does not yet contain `pstack-cc`.

In Claude desktop, use a local Code session. Open **Customize**, then **Plugins**, **Add plugin**, **Add marketplace**, and **Add from a repository**. Enter this Git source and select **Sync**:

```text
ystory/pstack#codex/claude-workflows
```

Install the marketplace's `pstack-cc` entry for your user account. Some Desktop versions open the plugin browser through **+**, then **Add plugins**. See [Desktop plugin installation](https://code.claude.com/docs/en/desktop#install-plugins).

For terminal installation, run these commands outside a Claude chat:

```sh
claude plugin marketplace add 'https://github.com/ystory/pstack.git#codex/claude-workflows'
claude plugin install pstack-cc@pstack-cc
```

Both routes install the committed `plugin-claude/` directory. You do not need a local clone or build. Start a new local Code session in your project, or enter `/reload-plugins` in the current session. Then run:

```text
/pstack-cc:setup-pstack
```

If Claude Code is missing, follow its [official installation guide](https://code.claude.com/docs/en/setup). Sign in with `claude auth login`, or `/login` in Claude Code. Setup checks `claude auth status` without copying credentials.

If Node is missing or older, install a supported release from [Node.js](https://nodejs.org/en/download). If Codex is missing, setup guides `npm install -g @openai/codex` or the [official Codex installation options](https://developers.openai.com/codex/cli). Sign in with `codex login`, including `!codex login` from an interactive Claude session when appropriate. Complete the browser or device login yourself, then let setup recheck. CLI detection, login, catalog access, and actual model execution are separate checks. Existing subscription authentication and API-key billing are distinct choices.

## Pick your models

Setup loads the current Claude preferences and the original pstack role defaults. It asks for `unlimited`, `large`, `medium`, or `small` reasoning budget and shows every role. Pick a supported Claude or Codex executor and exact model for each real selection. Unavailable upstream Grok suggestions need a choice. A temporary quota condition does not assign a permanent replacement model.

Scalar roles retain one entry or parent alias. `arena runners`, `architect runners`, and `interrogate reviewers` retain ordered lists, with one worker per entry including duplicates. `arena cross-judge pool` is also a list, but Arena selects one judge from another family in preference order. `swarm workers` stays scalar unless a race specifies models per arm.

`auto` and `inherit-parent` select the actual native Claude parent. They do not select Codex. Setup does not change the parent chat model. A single-model configuration cannot satisfy a required different-model or different-family verifier. Arena has its own disclosed optional judge skip. The other required diversity gates remain requirements.

The helper saves `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json` and manages only owned generated native agents. It preserves unrelated files and settings. Codex-host preferences under `$CODEX_HOME/pstack-for-codex/` remain independent. Use isolated `--claude-home` paths for fixtures.

## Run your first task

Start a new session after registration so Claude discovers exact-model agent variants. Try:

```text
/pstack-cc:how explain how this project starts up.
```

For implementation, start each new task with `/pstack-cc:poteto-mode` and name the goal and its done check. Follow-ups continue the selected playbook. Read [Claude Code execution](../../skills/poteto-mode/references/claude-execution.md) for actual tool and model bindings. Claude Code has no Cursor Custom Mode keyboard shortcut.

## Update or remove

Refresh the marketplace and installed plugin from your terminal:

```sh
claude plugin marketplace update pstack-cc
claude plugin update pstack-cc@pstack-cc
```

Rerun `/pstack-cc:setup-pstack` and start a new session. Updates follow the selected Git branch. Setup refreshes its owned agent definitions while retaining model preferences. Restore a prior bundle through the same installation path and rerun that bundle's setup.

Before uninstalling, run setup and ask it to unregister its managed agents while the bundle is still available. Then uninstall through Desktop's plugin browser or run `claude plugin uninstall pstack-cc@pstack-cc` in your terminal. Native plugin removal does not invoke agent cleanup. Preferences remain available for later installation.

Next, [Route work through poteto-mode](02-poteto-mode.md).
