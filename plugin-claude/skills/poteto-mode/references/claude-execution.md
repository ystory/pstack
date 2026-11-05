# Claude Code execution

Read this reference before launching, steering, waiting for, or collecting pstack workers. Resolve bundled files from the actual installed skill path. This reference binds the upstream workflow to Claude Code. The calling workflow still owns its scope, roles, retries, dropouts, model-diversity rules, fresh-worker rules, and parent review.

## Resolve roles and models

Run the sibling setup helper by absolute path:

```sh
node "<skills>/setup-pstack/scripts/models.mjs" resolve --role "<role>" --kind general-purpose
```

The worker kinds are `general-purpose`, `poteto-agent`, `comment-sicko`, and `read-only`. Use `poteto-agent` inside playbook steps, `comment-sicko` for no-comments, and `general-purpose` for routed investigation, candidate, review, and synthesis seats. Use `read-only` where the caller requires `readonly: true`, including How, Arena judges, and maintain-verification source-wave children. Why and Reflect retain `general-purpose` and their MCP access. Pass the relevant skill, template, rubric, and project instructions in every brief.

The helper reads `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. Explicit entries preserve their executor, exact model, and reasoning effort. Scalar roles stay scalar. `arena runners`, `architect runners`, and `interrogate reviewers` are ordered panels. Run every seat, including duplicate selections and parent aliases. `arena cross-judge pool` is an ordered selection pool, so it launches one eligible judge rather than the whole list. `swarm workers` is scalar unless an explicit race assigns models per arm.

A missing role returns the original Claude adapter's native execution fallback without requiring setup or generated definitions. A Grok default binds to the actual native parent. An Opus default returns `model: "opus"` and `modelKind: "native-alias"` with the configured budget effort. Both disclose their original `upstreamModel` and use a static plugin agent type. Report this mapping when dispatching. The Opus alias is a moving native default, not an exact model ID. Run `resolve --defaults --role "<role>" --kind general-purpose` when a caller requires its original default fallback or Arena's default-pool retry. Saved choices remain intact. Setup's `read` and `budget` proposals still require explicit supported choices before saving.

For a real model, use the caller's explicit task effort when given. Otherwise adjust its saved starting effort through poteto-mode's Subagents guidance. Keep the exact model ID and send effort and speed as separate supported controls. Report unavailable independent speed controls. Do not append effort or `-fast` to model IDs. Keep a rejected-model record per executor and never resubmit a rejected ID. Follow the caller's fallback and dropout rules, with disclosure. An unavailable executor is a capability gap, not a rejected model.

`auto` and `inherit-parent` bind to the actual native Claude parent, regardless of the other workers' executors. Their returned `agentType` selects the plugin's inherited base definition. Omit invocation model and effort overrides. Never translate a parent alias to Codex or to an assumed Claude alias. Inspect host configuration if inheritance is overridden. Report unresolved or substituted effective settings rather than claiming the requested model ran.

Validate required different-model or different-family relationships before the affected step. A repeated seat is still a seat, but it does not establish diversity. Use a supported selected counterpart for a required non-author verifier or final audit. A configuration that cannot satisfy a required gate remains a configuration gap. Arena alone permits its disclosed different-family judge skip, default-pool retry, and unknown-parent behavior. Orchestrate's tool-error retry needs a different model, not necessarily another family.

## Native Claude workers

For `executor: "claude-code"`, use the native `Agent` tool with the returned `agentType` as `subagent_type`. Setup owns generated definitions for each exact Claude model and worker kind. Saved exact selections omit invocation model overrides. A default with `modelKind: "native-alias"` uses the static definition and passes its alias through Agent's `model` parameter only when the actual schema accepts it. Report a capability gap if the schema cannot select it. Pass the supported per-invocation `effort` for a real model or the native Opus default. Inherited aliases omit both overrides. Preserve the returned identity and inspect actual settings when the host exposes them.

The [Claude subagent reference](https://code.claude.com/docs/en/sub-agents) documents exact model IDs in definitions, invocation effort, completion, and stateful messaging. Host policy can substitute models. Requested settings are not observed settings.

The brief names the goal, owned files or slice, forbidden changes, assigned checkout and branch, resolved starting SHA, exact verification, output contract, and absolute skill and artifact paths. Writers are not alone in the repository and must accommodate others' changes. A readonly caller uses kind `read-only` and an explicit "do not edit files" brief. Its native definition disallows `Write`, `Edit`, and `NotebookEdit`, while retaining Bash and the selected model. Check `git status --short` before dispatch and after completion for unexpected changes. This restricts file tools, not OS writes through Bash or interpreters. Other no-edits tasks keep their caller's kind. Do not substitute Explore, since it can change the selected model and role body.

Pass the absolute `poteto-mode/SKILL.md` path to every poteto-agent. Its first action is an actual full Read of that file, including the Principles index. Copying the body into a prompt does not establish that read. Require reads of applied principle leaves as upstream specifies, and inspect the worker transcript when chain-following matters.

Use the current Agent schema's asynchronous controls. Current Claude subagents normally run in the background. Launch independent seats without waiting between them and keep every agent ID. Native completion delivers a result. Use the exposed result or task retrieval tool when needed. An acknowledgement or completed status without its report is not a result. A concurrency limit queues work, not permission to omit required seats.

## Codex workers

For `executor: "codex"`, write the consolidated task to a local prompt file. The workflow's main conversation launches and owns the native Bash task. Run the foreground runner in background Bash with `run_in_background: true` and `timeout: 7200000` when the actual schema supports that maximum. Current native Bash defaults background tasks to 600000 ms and caps them at 7200000 ms. Honor the exposed host limit if it differs and report it. Do not shell-background the command with `&`, detach it, or add a relay agent. The foreground command remains active until the actual Codex turn terminates or the host stops it, allowing the host to deliver its completion event.

Pass this launch request to native Bash:

```json
{
  "command": "node \"<poteto-mode>/scripts/run-codex.mjs\" run --cwd \"/absolute/assigned-worktree\" --run-dir \"/absolute/unique-local-run-directory\" --model \"<selected-exact-model>\" --effort \"<supported-task-effort>\" --instruction \"/absolute/applicable/AGENTS.md\" --skill \"/absolute/relevant/SKILL.md\" --role \"<plugin>/agents/poteto-agent.md\" --write --prompt-file \"/absolute/consolidated-task.txt\"",
  "run_in_background": true,
  "timeout": 7200000
}
```

Use `--role` for the selected original role body. `general-purpose` seats pass their body plus the workflow templates. Repeat `--instruction` for project rules, source references, rubrics, and templates, and `--skill` for selected skill bodies. Use `--write` only for authorized `workspace-write` tasks. Without it, the runner defaults to `read-only`. An explicit `--sandbox` must match the authorized task scope. Never silently broaden it after a denial. A poteto-agent also receives the absolute poteto-mode skill and the instruction to read it before work. The runner includes supplied bodies in its task input. Required actual reads still need transcript evidence.

Each independent seat and new round gets a unique run directory and fresh Codex thread. Use `--resume EXACT_THREAD_ID` only under poteto-mode's stateful-reuse exception. Never resume the latest thread or infer identity from a directory name. The runner uses the existing Codex CLI and authentication. Claude tools, MCP servers, conversation history, and permissions do not automatically become Codex tools or state. Verify the external executor has the capabilities needed for its assigned task.

Track the native Bash task ID and collect its terminal outcome through the host's task-result controls. Read `<run-dir>/result.json` and `<run-dir>/final.txt` for the retained receipt and final answer. Bash stdout can truncate. Inspect the actual exit outcome, exact Codex thread identity, terminal status, result, requested and observed settings, and evidence paths. A final-answer item before a later failed terminal event is not success. Read the retained prompt, request, progress, diagnostics, and result when investigating failure. Review the worker's files and verification evidence under the calling workflow's rules.

## Worktrees and state transfer

Native `isolation: "worktree"` is available when its base and copy behavior meet the workflow. Otherwise create an explicit Git worktree at the resolved base commit before dispatch. Every independent writer owns a branch and checkout. A Cursor cloud-agent instruction maps to an exclusive local worktree, not a new machine. For a task that needs a remote host, use a real configured remote environment and identify it.

Workers share the machine, repository metadata, credentials, and devices. Assign separate ports, cache and data directories, temporary paths, and output files. Serialize a resource that cannot be separated. The parent prepares worktrees and reviews accepted artifacts before integration. Retain unintegrated work and diagnostic evidence.

Conversation history is not filesystem state. When a review includes uncommitted changes, record the source checkout and exact HEAD. Create all receiving worktrees at that HEAD. Capture scoped tracked final contents with `git diff --binary HEAD -- <scope>`. Inventory and copy scoped untracked files separately, preserving bytes, file types, symlink targets, and executable modes. Include ignored input only when the task needs it. Apply that same captured input to each receiver and compare its files, modes, deletions, and untracked inventory with the source before launch. Recapture if the source changes during the transfer.

A fresh worker can receive a stopped writer's checkout or a copied committed and uncommitted state. A history fork copies no process. Reuse a worker only when its costly checkout state, uncommitted changes, or live process meets poteto-mode's exception. A role outlives an individual worker. New rounds otherwise get a fresh consolidated brief with every later directive and prior report.

## Steering, results, and host features

Use the exposed native messaging control, such as `SendMessage`, for a running Claude worker's steering or a permitted stateful resume by exact agent ID. Keep stop orders distinct from new briefs. Stop a Codex Bash task through the host's actual task-stop control and collect the resulting receipt. Do not equate interrupt delivery with observed process death. Retain exact thread identity for a later permitted continuation.

Wait for all required terminal results before synthesis. Account for every seat and apply only the calling workflow's failure or dropout rule. The parent reviews diffs and reruns load-bearing claims. Never accept an author summary as a non-author verdict.

Read [Claude Code wakeups](claude-wakeups.md) for repeated watchers and schedules, and [Claude history](../../recall/references/claude-history.md) for transcripts. Use native TodoWrite or task tools when offered, otherwise maintain the workflow's list in its local tracker. Inspect the live schemas rather than assuming a Project store or a PR-event subscription exists.

For another pstack skill, Read its installed `SKILL.md` and follow it. Most pstack skills are explicit-only, so the Skill tool may refuse them. User invocation is `/pstack-cc:<name>`. User-authored skills live in `.claude/skills/` or `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/`. Follow [skill authoring](skill-authoring.md) for a create-skill reference. Use native AskUserQuestion when available, or a plain question when it is absent.

Claude Code reads `CLAUDE.md` and supports `AGENTS.md` under its [project instruction rules](https://code.claude.com/docs/en/memory#agentsmd). Do not rewrite unrelated instruction files or global settings to force a match. Read applicable project rules explicitly for external Codex tasks. Bugbot comments remain ordinary forge review threads. Use the calling workflow's `gh` or Origin commands. Cursor-specific configuration is not an instruction to install Cursor.
