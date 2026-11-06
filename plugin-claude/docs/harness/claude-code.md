# pstack in Claude Code

This target uses native Claude Code skills and agents, with setup-selected Claude or Codex workers. Read [Claude Code execution](../../skills/poteto-mode/references/claude-execution.md) for the binding shared by every workflow. It preserves exact selected models, ordered panels, worker instructions, stateful continuation, and caller-specific review and failure rules.

Before setup, missing roles inherit the actual native parent with disclosure and original cardinality. Setup proposals start unresolved, and saved exact entries take precedence. Run `/pstack-cc:setup-pstack` to select exact models and executors, then start a new session. User commands use `/pstack-cc:<skill>`. Internally, read installed skill files by their actual path. The [setup guide](../guide/01-setup.md) covers independent preferences and CLI authentication. The [delegation inventory](../../skills/poteto-mode/references/delegation-sites.json) records the affected source sites.

Readonly callers use the native `read-only` kind with the selected model, a no-edits brief, and a before/after `git status --short` check. The kind disallows `Write`, `Edit`, and `NotebookEdit`. Bash remains available, so this is a file-tool restriction rather than OS write isolation. Why and Reflect retain their full-access kind and MCP access.

Claude Agent workers and foreground Codex commands in native background Bash share the workflow contract. A local worktree is not a cloud VM. Native child completion is not a CI subscription. See [Claude Code wakeups](../../skills/poteto-mode/references/claude-wakeups.md) for schedules and channels and [Claude history](../../skills/recall/references/claude-history.md) for project-scoped transcripts.
