# Claude history

Use the current conversation or an explicit state capsule before searching stored history. Scope recall to the active project, its Git worktrees, the named topic, and the requested time window. Do not read unrelated projects.

Claude Code stores local transcripts under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/`. A project directory uses the absolute checkout path with non-alphanumeric characters replaced by `-`. Main session files are `<session-id>.jsonl`; child transcripts live under `<session-id>/subagents/`. These files are host runtime data, so confirm the active session ID or opening user message. The newest file alone does not establish the active conversation.

Resolve the helper from this installed skill and use an absolute project path:

```sh
node "<recall>/scripts/claude-history.mjs" list --project "/absolute/project"
node "<recall>/scripts/claude-history.mjs" read --project "/absolute/project" --id "<exact-session-id>"
```

`list` returns session metadata ordered by actual modification time. It searches only the active repository's registered worktree directories and verifies each transcript's `cwd` ownership. `read` rejects an ID outside that project and returns the main records plus its scoped child transcripts. `--touching "/absolute/worktree"` narrows either command to that worktree. `--claude-home "/absolute/fixture-home"` selects an isolated test home. It neither edits history nor searches every user's project directory.

Parse user and assistant `message.content`, tool calls and results, session IDs, and timestamps. Skip this session and obvious eval or test chats when recalling earlier work. Read the complete relevant transcript when the answer depends on what an agent actually read, ran, or changed. For a selected Codex worker, also inspect its exact run directory and receipt from Claude Code execution. Claude child logs do not contain the external Codex thread's full execution evidence.

When the active transcript cannot be matched, use a tight conversation digest and disclose that limit. Do not broaden the search to unrelated projects. A checkpoint is prior context, not proof of current code or process state.
