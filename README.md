# pstack for Codex and Claude Code

An unofficial adaptation of [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) workflows, skills, and agents. It also bundles the `control-ui`, `control-cli`, and `deslop` skills from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit). Each host has a separate plugin and reproducible adaptation series over pinned sources.

Choose your host:

- [Claude desktop and Claude Code terminal](#install-in-claude-code). Install the `pstack-cc` preview from Git and select Claude or Codex workers.
- [Codex](#install-in-codex). Install `pstack-for-codex` from the existing Git marketplace.
- [Development and maintenance](docs/stack.md). Build artifacts, check patches, and review source updates.

![pstack for Codex workflow: route a task through a playbook and situational skills, prove the result, and return the appropriate outcome.](docs/assets/pstack-for-codex-workflow.png)

The playbook determines which skills and agents to use; the result can be an answer, a change, or a PR. See [Design and compatibility](docs/spec.md) for execution details, or open the [editable workflow map](docs/assets/pstack-for-codex-workflow.svg).

## Install in Claude Code

The Claude preview uses the `codex/claude-workflows` branch. Use the branch URL below. The repository's default branch does not yet contain `pstack-cc`.

### Prepare your CLIs and login

You need a current Claude desktop app with the **Code** tab and local sessions, or the Claude Code terminal client. Setup also needs Git, Node.js 24.12+, and a Claude Code CLI available as `claude`. Native worker effort requires Claude Code 2.1.292+ with Agent effort support. The desktop session and the installed CLI can have different versions. Use `/status` in the Code session to inspect its version.

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

If Claude's CLI is logged out, run `claude auth login` and complete the browser login. Use the account and organization you intend to use for Claude workers.

If you want Codex workers, install the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and sign in:

```sh
npm install -g @openai/codex
codex --version
codex login
codex login status
```

Codex login with ChatGPT uses your subscription access. API-key login uses separate OpenAI API billing. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for both methods and device login. Complete login in your terminal or browser. Keep credentials out of the chat. Claude-only workers do not need Codex, and `pstack-cc` does not need the separate official Codex plugin.

If setup cannot find `node`, `claude`, or `codex`, check the command's installation directory and your `PATH`. Quit and reopen Desktop after changing the environment. See [Desktop tools and PATH](https://code.claude.com/docs/en/desktop#session-not-finding-installed-tools) if the command works in your terminal but fails in Code.

### Install from Git in Claude desktop

1. Open Claude desktop's **Code** tab. Start a **Local** session in the project folder you want Claude to work on.
2. In the sidebar, open **Customize**, then **Plugins**. Select **Add plugin**, **Add marketplace**, then **Add from a repository**.
3. Paste this source in the URL field and select **Sync**:

   ```text
   ystory/pstack-for-codex#codex/claude-workflows
   ```

4. Open the `pstack-cc` entry from that marketplace and install it for your user account. Confirm that the plugin appears as installed and enabled.
5. Start a new local Code session in your project, or type `/reload-plugins` into the current session. Confirm that `/pstack-cc:setup-pstack` is available.

Some Desktop versions open the plugin browser through **+** beside the prompt, then **Add plugins**. See [Desktop plugin installation](https://code.claude.com/docs/en/desktop#install-plugins). The `/plugin` interactive panel requires a terminal session. Use the Desktop plugin browser or the shell commands below to manage plugins.

You do not need to clone this repository, install its development dependencies, or build an artifact. The marketplace installs the committed `plugin-claude/` directory from the selected Git branch.

### Install from a terminal instead

Run these commands in your terminal, outside a Claude chat:

```sh
claude plugin marketplace add 'https://github.com/ystory/pstack-for-codex.git#codex/claude-workflows'
claude plugin install pstack-cc@pstack-cc
```

Then open a new local Code session in your project, or start `claude` from that project folder. Both installation routes use the `pstack-cc` marketplace. The [native plugin commands](https://code.claude.com/docs/en/plugins/cli-reference#plugin-marketplace-add) support the branch ref.

### Select workers with setup

In the Code session, run:

```text
/pstack-cc:setup-pstack
```

Setup checks CLI capabilities and login, collects available models, and shows the existing 17 roles. Choose an executor, exact model, and supported reasoning effort for each role. You can choose native Claude workers, Codex workers, or both. Setup saves worker choices independently of the parent chat model.

For example, tell setup:

```text
Use Codex for how explainer with an exact model and effort from the detected catalog. Show me the available choices for the other roles before saving.
```

Choose `unlimited`, `large`, `medium`, or `small` as the reasoning budget. Setup previews the supported effort for each selected model. It shows unresolved upstream Grok suggestions so you can replace them with supported choices. Select the models your account can use.

Review the complete proposal before setup saves it. Keep ordered panel entries and required model diversity when choosing several roles. `auto` and `inherit-parent` use the native Claude parent. They do not select Codex. A single-model configuration cannot satisfy a workflow that requires another model or model family. Arena reports a skipped optional judge when none is eligible.

Healthy setup reports successful registration and saved preferences, then reads them back. Claude preferences live at `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. Setup manages only its owned native agents and preserves unrelated settings. Codex-host preferences remain separate under `$CODEX_HOME/pstack-for-codex/`.

### Run a first workflow

Start a new local Code session in the same project after setup so Claude discovers the registered agents. For exactly one Codex worker, first select Codex for `how explainer` in setup. Then ask about one function or module. For example, in this repository:

```text
/pstack-cc:how explain how src/cli.ts handles --help. Use the simple path with one explainer. Do not edit files.
```

Replace `src/cli.ts` and the question with a real module in your project. The simple How path uses one explainer and no explorers. A healthy run identifies the selected executor and model, completes the worker, and returns an explanation based on the project's files. Codex workers run as background tasks whose results Claude collects. A successful CLI or catalog check alone does not prove that a worker can execute.

For a development task, start with `/pstack-cc:poteto-mode` and describe the goal and how to check the result. Use `/pstack-cc:poteto-help` to find other workflows. The [Claude guide](plugin-claude/docs/guide/README.md) covers the workflows, and the [execution binding](plugin-claude/skills/poteto-mode/references/claude-execution.md) describes worker behavior and host limits. The [compatibility record](docs/spec.md#verified-scope) distinguishes source inspection, automated fixtures, and live workflow runs.

### Update, restore, or remove

Refresh the selected Git branch and installed plugin from your terminal:

```sh
claude plugin marketplace update pstack-cc
claude plugin update pstack-cc@pstack-cc
```

Rerun `/pstack-cc:setup-pstack`, then start a new local Code session. Saved model choices remain. A marketplace added with a branch ref continues to update that branch. To restore a previous local artifact, follow [Development and maintenance](docs/stack.md#build-and-select-an-artifact), reinstall it, and rerun its setup.

Before removing the plugin, run `/pstack-cc:setup-pstack` and ask it to unregister its owned agents while the plugin is still available. Then uninstall it through Desktop's plugin browser or your terminal:

```sh
claude plugin uninstall pstack-cc@pstack-cc
```

Plugin removal does not clean up registered agents automatically. Setup removes unchanged owned registrations and retains model preferences.

## Install in Codex

In the Codex distribution, ordinary roles default to Sol 6.1 through Codex. The hardest tasks use Opus 5.5 through an existing Claude Code CLI, and candidate and review panels use both models. The default configuration requires an installed, authenticated Claude Code CLI with Opus 5.5 access.

Setup can save an all-Sol configuration, but that configuration cannot satisfy upstream steps requiring a different model or model family, such as Orchestrate's per-PR verifier, the final audit in `show-me-your-work`, and the eval playbook. Arena instead reports when it cannot run a judge from another family and continues without that judge. See the [plugin manifest](plugin/plugin.json) for the current version and the [compatibility notes](docs/spec.md) for verified workflows and limitations.

### Requirements

- Codex with plugin and native subagent support, signed in to an account with access to your selected models.
- Git for Codex to fetch the GitHub marketplace.
- Node.js 24.12+ for setup and the bundled runtime helpers.
- Python 3.11+ for agent registration, using its standard-library TOML parser. Setup uses `python3` by default and can select another existing interpreter.
- An installed, authenticated Claude Code CLI 2.1.280+ with Opus 5.5 access for the default Claude roles. Setup checks CLI capabilities; detection alone does not establish model access.
- Bun 1.2+ for the PR watcher helper. Its first use installs locked dependencies in a cache outside the plugin and may need network access. GitHub PR workflows also need an authenticated GitHub CLI (`gh`).
- Optional TLA+ statechart checks need Java and TLC. The first real check uses mise to install pinned tools unless existing tools are supplied. SVG rendering uses Pele separately. See the [statechart skill](plugin/skills/statechart/SKILL.md) for its commands and limits.

### Install

Add the GitHub marketplace, then install the plugin:

```sh
codex plugin marketplace add https://github.com/ystory/pstack-for-codex.git
codex plugin add pstack-for-codex@pstack-for-codex
```

Codex reads the repository's marketplace catalog and installs the committed `plugin/` directory. You do not need to clone the repository, install project dependencies, or build it first. See [Development and maintenance](docs/stack.md) to build and verify a local artifact instead.

### Set up and use

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

### Update or restore

For a GitHub installation, refresh the Git marketplace and explicitly reinstall the plugin:

```sh
codex plugin marketplace upgrade pstack-for-codex
codex plugin add pstack-for-codex@pstack-for-codex
```

Run `$pstack-for-codex:setup-pstack` again to synchronize its managed registrations, then start a new chat. Saved model choices are retained.

To switch an existing local `pstack-for-codex` marketplace to GitHub, run the two [install commands](#install) above, then rerun setup and start a new chat. Adding the Git URL selects that source for the same marketplace identity; `marketplace upgrade` alone does not turn a local source into a Git source. For building, selecting, or restoring local artifacts, see [Development and maintenance](docs/stack.md#build-and-select-an-artifact).

Before restoring an older all-Sol bundle, use the current setup to explicitly save Codex-only role choices: older helpers reject the mixed-executor schema 2, while native-only schema 1 remains compatible. This does not make all-Sol choices satisfy steps that require a different model or model family.

### Remove

Before removing the plugin, run `$pstack-for-codex:setup-pstack` and ask it to unregister its managed agents. This removes unchanged owned registrations and leaves your model preferences in place. Then remove the plugin:

```sh
codex plugin remove pstack-for-codex@pstack-for-codex
```

There is no automatic uninstall hook to clean up registered agents after the plugin is removed.

## Development and sources

For contributions:

1. Keep the pinned `upstream/` snapshots unchanged during adaptation work. Review source updates through the [upstream candidate workflow](docs/stack.md#review-an-upstream-update).
2. Implement Codex adaptations in `plugin/` or Claude Code adaptations in `plugin-claude/`. Record each target's change in its own series and [verify patch replay](docs/stack.md#record-an-adaptation).

- [Design and compatibility](docs/spec.md): adaptation behavior, source invariants, and verified runtime scope.
- [Development and maintenance](docs/stack.md): verification, patch management, upstream candidates, and artifact commands. The full verification workflow also requires `tar`.
- [Original pstack README](upstream/pstack/README.md): upstream project background.
- [pstack source lock](upstream.lock.json), [cursor-team-kit source lock](dependencies.lock.json), and [Codex worker runtime lock](codex-runtime.lock.json): pinned revisions, file mappings, and hashes.

The original Codex adaptation code and documentation are released under the [MIT license](LICENSE). The Codex bundle includes this license at `licenses/pstack-for-codex/LICENSE`; the Claude bundle uses `licenses/pstack-cc/LICENSE`. pstack is by Lauren Tan and retains its [MIT license](upstream/pstack/LICENSE). The bundled cursor-team-kit skills retain Cursor's [MIT license](upstream/cursor-team-kit/LICENSE). The Claude target also includes pinned official Codex worker code and its notices under `vendor/codex-plugin-cc/`. Original copyright and license notices are preserved in each distribution.
