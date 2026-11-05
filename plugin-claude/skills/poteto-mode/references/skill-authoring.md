# Skill authoring in Claude Code

Use an installed `skill-creator` when available. Read that skill and follow its draft, test, and iteration workflow. Do not assume Cursor's create-skill command exists.

Otherwise follow the [Claude Code skills contract](https://code.claude.com/docs/en/skills). Write a project skill at `.claude/skills/<name>/SKILL.md`, or a personal skill under `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/` when requested. Preserve an existing category directory. Keep valid YAML frontmatter with `name` and a description that names the task and when it applies. Preserve the user's invocation policy.

Keep instructions focused on decisions the skill changes. Put task-specific detail in referenced files when that helps discovery. Resolve links from the skill's actual directory. Validate frontmatter, reference paths, invocation name, and any scripts. For substantive workflow edits, run realistic behavioral cases in an isolated fixture and inspect the actual reads, actions, and outputs. A matching heading or a copied prompt is not evidence that the next agent followed the skill. Iterate on observed failures. Do not edit installed plugin caches.
