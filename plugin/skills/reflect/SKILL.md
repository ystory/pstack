---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Use the current conversation context first. When the runtime exposes an active local transcript identity, resolve the sibling `recall/scripts/codex-history.mjs` helper from this skill's actual directory. Run `list --project <absolute project path>` to obtain project-scoped metadata, then `read --project <absolute project path> --id <session UUID>` for the matching session. Confirm the opening user prompt before passing a path or transcript. The helper gates project ownership before reading session content.

If the active transcript cannot be matched, pass a tight digest of this conversation instead. Keep unrelated projects' chats outside the search.

## 2. Spawn three reviewers in parallel

Read [Codex execution](../poteto-mode/references/codex-execution.md). Launch three general-purpose reviewers through each selected executor without waiting between them, selecting `agent_type: "pstack-general-purpose"` on the native path. Native reviewers retain the parent's MCP access; Claude Code reviewers use its configured MCPs to look up tickets, chat threads, and observability traces.

Resolve each table role with the sibling setup helper. Apply task effort and budget guidance from poteto-mode. Pass absolute paths to this skill, each template, and the scoped transcript or digest.

| Lens | Model role | Missing role | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | native parent | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | native parent | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | native parent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Collect each reviewer's terminal report through Codex execution before synthesis.

## 3. Synthesize

Launch one general-purpose synthesizer through the selected executor, using `agent_type: "pstack-general-purpose"` on the native path and the `reflect judgment, divergent, synthesizer` role. It uses the selected executor's MCP access for citation spot-checks. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Find existing editable skills under the project's `.agents/skills/`, `~/.agents/skills/`, and `$CODEX_HOME/skills/` (`~/.codex/skills/` when unset). Preserve the discovered path. Never edit a skill under `plugins/cache/`. Before approval, show the destination. For a new personal copy, default to `$CODEX_HOME/skills/<skill>/`, or `~/.codex/skills/<skill>/` when unset. After approval, edit the existing skill in place or copy a cached skill folder to that destination and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to Codex's `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
