# Set up pstack in Claude Code

Install the plugin, select workers for its roles, and run a first workflow. The Claude parent and worker executors are independent choices.

## Requirements

You need a current Claude desktop app with the **Code** tab and local sessions, or the Claude Code terminal client. The host must support native plugins, Agent, effort, and background Bash. Ordinary Claude chat is not a pstack host. Setup needs Git, Node.js 24.12+, and a Claude Code CLI available as `claude`. Native worker effort requires Claude Code 2.1.292+ with Agent effort support. The desktop session and installed CLI can have different versions. Use `/status` in the Code session to inspect its version.

Codex workers also need the official standalone `codex-app-server` package and a shared Codex login. Claude-only workers do not need Codex. `pstack-cc` does not need the separate official Codex plugin. GitHub workflows need an authenticated GitHub CLI, `gh`. The bundled PR watcher needs Bun 1.2+ and installs locked dependencies in an external cache on first use.

## Prepare selected CLI login and PATH

Install [Node.js](https://nodejs.org/en/download) and the [Claude Code CLI](https://code.claude.com/docs/en/setup) if needed. On macOS, Linux, or WSL, Claude's installer is:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new terminal and check:

```sh
node --version
git --version
claude --version
claude auth status
```

If Claude's CLI is logged out, run `claude auth login`, or use `/login` in Claude Code. Complete the browser login with the account and organization you intend to use for Claude workers. Setup checks authentication without copying credentials. Keep credentials out of the chat.

After choosing Codex workers, download the complete matching-platform `codex-app-server-package` archive from [official Codex releases](https://github.com/openai/codex/releases). Extract the whole package and keep its companion files together. The no-extension `codex-app-server` release asset is a DotSlash manifest, not the native binary. Put the package's `bin` directory on PATH. Setup can instead select `bin/codex-app-server` through `--codex-executable ABS`; worker runs use `--executable ABS` for the same selection.

Check the standalone runtime:

```sh
codex-app-server --version
codex-app-server --session-source app-server --help
```

The help output must advertise `--session-source`. Setup uses this runtime for account and model probes, and workers use the same launch arguments. The plugin does not install or update the binary and does not fall back to `codex app-server`.

For human login, install the separate [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) if needed and sign in:

```sh
npm install -g @openai/codex
codex login
codex login status
```

The npm CLI installation does not supply the standalone package. Keep the CLI and server on the same inherited `CODEX_HOME`, or its default `~/.codex`, so they share authentication, configuration, and persistent history. You can also run `!codex login` from an interactive Claude session when appropriate. Use `codex login --device-auth` when a browser callback cannot complete. Complete login yourself, then let setup recheck. Codex login with ChatGPT uses your subscription access. API-key login uses separate OpenAI API billing. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for both methods and device login. [Claude Code authentication](https://code.claude.com/docs/en/authentication) also supports subscription and Console credentials with their respective billing. Model access and usage limits depend on the account and configuration.

If setup cannot find `node`, `claude`, or `codex-app-server`, check the command's installation directory and your `PATH`. Quit and reopen Desktop after changing the environment. See [Desktop tools and PATH](https://code.claude.com/docs/en/desktop#session-not-finding-installed-tools) if the command works in your terminal but fails in Code.

CLI detection, login, catalog access, and actual model execution are separate checks. Run setup after installation. It asks which workers to use before checking selected CLIs, then guides any needed installation and human login. Continue to model selection after readiness checks.

## Install

Both installation routes below use the repository's default branch.

In Claude desktop, use a local Code session. Open **Customize**, then **Plugins**, **Add plugin**, **Add marketplace**, and **Add from a repository**. Enter this Git source and select **Sync**:

```text
ystory/pstack
```

Install the marketplace's `pstack-cc` entry for your user account. Confirm that the plugin is installed and enabled. Some Desktop versions open the plugin browser through **+**, then **Add plugins**. See [Desktop plugin installation](https://code.claude.com/docs/en/desktop#install-plugins).

The `/plugin` interactive panel requires a terminal session. Use the Desktop plugin browser or the shell commands below to manage plugins.

For terminal installation, run these commands outside a Claude chat:

```sh
claude plugin marketplace add https://github.com/ystory/pstack.git
claude plugin install pstack-cc@pstack-cc
```

Both routes install the committed `plugin-claude/` directory. You do not need a local clone or build. Start a new local Code session in your project, or enter `/reload-plugins` in the current session. Then run:

```text
/pstack-cc:setup-pstack
```

## Pick your models

Setup starts with native Claude only, or Claude with Codex workers. The parent chat stays in Claude. Unselected Codex is neither probed nor required. For a selected missing runtime or logged-out account, setup guides installation or human login and rechecks it before model selection.

Then choose supported exact models, role assignments, and `unlimited`, `large`, `medium`, or `small` reasoning budget. Fresh proposals expose all 17 roles with unresolved model slots. Saved entries prefill reruns. Review accepted choices before saving. You may leave a role unconfigured after seeing its native-parent fallback. No fixed model is required.

Scalar roles retain one entry or parent alias. `arena runners`, `architect runners`, and `interrogate reviewers` retain ordered lists, with one worker per entry including duplicates. `arena cross-judge pool` is also a list, but Arena selects one judge from another family in preference order. `swarm workers` stays scalar unless a race specifies models per arm.

`auto` and `inherit-parent` select the actual native Claude parent. They do not select Codex. Setup does not change the parent chat model. A single-model configuration cannot satisfy a required different-model or different-family verifier. Arena has its own disclosed optional judge skip. The other required diversity gates remain requirements.

The helper saves `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json` and manages only owned generated native agents. It preserves unrelated files and settings. Codex-host preferences under `$CODEX_HOME/pstack-codex/` remain independent. Use isolated `--claude-home` paths for fixtures.

## Run your first task

Start a new session after registration so Claude discovers exact-model agent variants. Try:

```text
/pstack-cc:how explain how src/cli.ts handles --help. Use the simple path with one explainer. Do not edit files.
```

Replace `src/cli.ts` with a real module in your project. The simple How path uses one explainer and no explorers. To try one Codex worker, first select Codex for `how explainer` in setup. A healthy run identifies the selected executor and model, completes the worker, and returns an explanation based on the project's files. Codex workers run as background tasks whose results Claude collects.

For implementation, start each new task with `/pstack-cc:poteto-mode` and name the goal and its done check. Follow-ups continue the selected playbook. Read [Claude Code execution](../../skills/poteto-mode/references/execution.md) for actual tool and model bindings. Claude Code has no Cursor Custom Mode keyboard shortcut.

## Update or remove

Refresh the marketplace and installed plugin from your terminal:

```sh
claude plugin marketplace update pstack-cc
claude plugin update pstack-cc@pstack-cc
```

Rerun `/pstack-cc:setup-pstack` and start a new session. Updates follow the selected Git branch. A marketplace previously added with a branch ref continues to update that branch. Setup refreshes its owned agent definitions while retaining model preferences. To restore a previous local artifact, follow [Build and select an artifact](https://github.com/ystory/pstack/blob/main/docs/stack.md#build-and-select-an-artifact), reinstall it, and rerun its setup.

Before uninstalling, run setup and ask it to unregister its managed agents while the bundle is still available. Then uninstall through Desktop's plugin browser or run `claude plugin uninstall pstack-cc@pstack-cc` in your terminal. Native plugin removal does not invoke agent cleanup. Preferences remain available for later installation.

Next, [Route work through poteto-mode](02-poteto-mode.md).
