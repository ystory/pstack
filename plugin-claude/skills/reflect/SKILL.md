---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

For authoring, follow [skill authoring](../poteto-mode/references/skill-authoring.md). It uses an installed skill-creator when available and the native Claude skill contract otherwise.

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Read [Claude history](../recall/references/claude-history.md). List project-scoped session metadata, then read this session by its exact ID. Confirm its opening user prompt before passing the transcript and scoped subagent evidence to reviewers. If the active session cannot be matched, pass a tight conversation digest instead. Do not search unrelated projects.

## 2. Spawn three reviewers in parallel

Read [Claude Code execution](../poteto-mode/references/execution.md). Launch three `general-purpose` reviewers through their selected executors without waiting between launches. Reviewers use the executor's configured MCP tools to check tickets, chat threads, and observability traces. Keep their no-edits scope explicit.

Resolve each table role through the sibling setup helper with worker kind `general-purpose`. Use the selected exact model and supported task effort. A rejected model follows the execution binding, using a valid same-family choice from the error when available, with disclosure. Parent aliases bind the actual native parent. Apply poteto-mode's reasoning and speed guidance.

| Lens | Model role | Missing role | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | native parent | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | native parent | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | native parent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Collect every reviewer's terminal report through Claude Code execution before synthesis.

## 3. Synthesize

Launch one `general-purpose` synthesizer through the selected executor using `reflect judgment, divergent, synthesizer`. It uses that executor's MCP access for citation spot-checks. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`. Before approval, show its destination, `.claude/skills/<skill>/` or `~/.claude/skills/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the installed `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
