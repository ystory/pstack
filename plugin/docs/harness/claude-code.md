# Claude Code workers from Codex

This Codex product runs selected Claude Code workers through its [execution binding](../../skills/poteto-mode/references/codex-execution.md). Invoke [setup](../../skills/setup-pstack/SKILL.md) to choose worker executors first. When Claude is selected, setup checks installation and login before exact models, role assignments, and budget. Codex-only setup needs no Claude CLI.

Each external entry carries an exact supported model and a separate effort. The runner requires an explicit `--model`. It reuses the existing Claude CLI environment and authentication. Native Codex role definitions and conversation history do not automatically become Claude instructions. The caller supplies the original role body, relevant skills, task context, and authorized tools through the runner.

To use Claude Code as the parent host, install the separate `pstack-cc` product through the [repository guide](https://github.com/ystory/pstack#install-in-claude-code). It owns independent preferences and native Claude definitions. This product does not write a Claude rule file or translate model IDs into moving aliases.
