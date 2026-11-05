# pstack for Claude Code

An unofficial Claude Code adaptation of [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack). The locked upstream workflows, skills, principles, and original agent bodies remain the source. This target adds native Claude execution and setup-selected Claude or Codex workers. It also bundles `control-ui`, `control-cli`, and `deslop` from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit).

## Install and set up

This preview is on the `codex/claude-workflows` branch. The repository's default branch does not yet contain `pstack-cc`. Run these commands in your terminal:

```sh
claude plugin marketplace add 'https://github.com/ystory/pstack.git#codex/claude-workflows'
claude plugin install pstack-cc@pstack-cc
```

For Claude desktop, use the [plugin browser instructions](docs/guide/01-setup.md#install). Both routes install the committed `plugin-claude/` directory from the selected Git branch. Start a new local Code session in your project, then run:

```text
/pstack-cc:setup-pstack
```

Setup checks Node, CLI capabilities and authentication. It guides missing CLI installation and human login, then saves your reasoning budget and exact worker choices for all 17 roles. It does not choose the parent chat model. A native Claude entry uses an exact-model agent definition. A Codex entry runs through the bundled, pinned official Codex runtime and your existing Codex login.

Preferences live at `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. They are independent of Codex-host preferences. The original unavailable Grok defaults need a supported choice. Panels preserve their ordered entries and duplicates. Parent aliases select the actual Claude parent. Required model diversity still applies.

Start a new session after setup, then try:

```text
/pstack-cc:how explain how this project starts up.
/pstack-cc:poteto-mode fix the duplicate notification. reproduce it, then verify the fix.
```

Read [Set up pstack](docs/guide/01-setup.md) for requirements, updates, removal, and login guidance. The [guide](docs/guide/README.md) covers the workflows. Use `/pstack-cc:poteto-help` to find one.

## Execution and verification

The [Claude Code binding](docs/harness/claude-code.md) maps the original workflow to native Agent, background Bash, worktrees, scoped transcripts, schedules, and channels. The parent still owns review. A worktree isolates files on this machine. It does not supply a cloud VM. External Codex workers use Codex's configured tools and MCPs, which can differ from the Claude parent.

Source inspection, fixture checks, live runtime checks, and release approval are separate. The repository's [compatibility record](https://github.com/ystory/pstack/blob/codex/claude-workflows/docs/spec.md) states what actually ran. A successful artifact build does not establish that every workflow or selected model works on your account.

## Sources and licenses

The maintainer repository owns source locks, host adaptations, ordered patch replay, and artifact verification. The [maintenance guide](https://github.com/ystory/pstack/blob/codex/claude-workflows/docs/stack.md) documents those commands. Updating this installed bundle does not run its workflows.

pstack is by Lauren Tan and retains its [MIT license](LICENSE). The bundled cursor-team-kit skills retain their [MIT license](licenses/cursor-team-kit/LICENSE). Adaptation code retains its [MIT license](licenses/pstack-cc/LICENSE). The official Codex worker files retain their bundled upstream notices under `vendor/codex-plugin-cc/`. Original copyright and license notices remain.
