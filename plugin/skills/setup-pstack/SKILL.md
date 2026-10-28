---
name: setup-pstack
description: Register pstack's bundled Codex agents and configure per-role models and reasoning budget across native Codex and an existing Claude Code CLI. Saves user-global choices that override skill defaults. Use for $setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Save pstack's per-role choices in `$CODEX_HOME/pstack-for-codex/models.json`, or `~/.codex/pstack-for-codex/models.json` when `CODEX_HOME` is unset. These choices belong to the user and survive plugin updates and rollbacks. Resolve every bundled helper relative to this installed `SKILL.md`, then run Node.js with the helper's absolute path.

## Steps

### 0. Register the bundled agents

Run `scripts/register-agents.mjs` with Node.js and Python 3.11 or newer. Python's standard-library `tomllib` validates native configuration; `--python ABSOLUTE_PATH` selects an existing compatible interpreter. The helper locates this plugin's agent definitions, registers `poteto-agent` and `comment-sicko` under `$CODEX_HOME/agents/` (default `~/.codex/agents/`), and adds explicit `[agents.<name>]` declarations with absolute `config_file` paths and the original descriptions in `config.toml`. It also adds `[agents.pstack-general-purpose]` with only a pstack-specific description, so pstack's generic delegates can receive the selected model and reasoning effort. This metadata role has no separate file or instruction body and preserves the user's existing default role. Users do not need to copy or edit the TOML files. Their original instruction bodies remain intact; callers provide the absolute installed paths of referenced skills in the delegated task.

Read the JSON result and report the two file-based `agents`, the description-only `metadataRoles`, and the native config declaration status separately. Re-running setup leaves identical files untouched. The registration record tracks agent hashes and permissions and the exact owned config block. Updates and older bundles replace only unchanged managed registrations. On an unowned role declaration, malformed configuration, or user edit inside the managed block, report the conflict and stop setup before any mutation. An inline `agents` table that cannot be extended requires the user to convert it to normal tables; preserve it and report that action. Registration retains unrelated agents, configuration bytes and comments, existing file permissions, and model preferences. Successful registration confirms writing the files; start a new Codex session and check that its native tool exposes the named role before invoking it.

For an isolated check, pass an absolute temporary `--codex-home` directory. `--dry-run` parses and previews without writing. A requested uninstall uses `--unregister`; it removes only unchanged registered agent files, the owned config block, and their ownership record. It restores preexisting config bytes when otherwise unchanged and retains independent later edits and model settings. Continue with model configuration after registration succeeds.

### 1. Detect available models

Enumerate the actual model IDs and supported reasoning efforts exposed by this session's native subagent tools or model catalog. Prefer Codex `model/list` for completeness when available; collect every page. Native defaults use `gpt-6.1-sol`. The `hardest tasks` default and one entry in each of the four list defaults use the existing Claude Code CLI with pinned `claude-opus-5-5`.

Normalize the detected native catalog with `scripts/models.mjs catalog --input ABSOLUTE_JSON`. It accepts a `model/list` response or `{ "models": [{ "model": "gpt-6.1-sol", "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }] }` assembled from the current tool's confirmed choices. Retain the actual supported values. If availability cannot be confirmed, ask for the Codex model IDs and efforts the user can use.

Run the sibling `poteto-mode/scripts/run-claude.mjs detect` with Node.js from its absolute installed path as described in the [execution binding](../poteto-mode/references/codex-execution.md). It discovers the existing executable and checks CLI version and required options. Reuse existing authentication and configuration. Installing Claude, authenticating, and changing Claude settings are separate operations. Normalize both routes with `scripts/models.mjs catalog --input ABSOLUTE_NATIVE_JSON --claude-runtime ABSOLUTE_DETECT_JSON`. The Claude route requires CLI 2.1.280 or newer and supports `low`, `medium`, `high`, `xhigh`, and `max`. A detection receipt confirms CLI capabilities; its `modelExecutionVerified` state remains separate from actual model access and execution evidence. Keep the exact pinned model rather than a moving `opus` alias.

`inherit-parent` and `auto` are always valid saved aliases. Both select the literal Codex parent model and effort, and cannot be tagged for Claude execution. Use the shared execution binding when dispatching; omit native override fields only when doing so has been confirmed to preserve those parent settings.

### 2. Load current state

Run `scripts/models.mjs read` and use its `config` and `sha256`. With no saved file, the helper returns the defaults below and budget `large`. Saved role values override the packaged defaults; an absent role falls back to its default. Existing native schema 1 settings and entries without `executor` retain their selected values. Configurations containing a Claude executor use schema 2, which older bundles reject instead of misreading as native. Explicit Claude entries labeled schema 1 are rejected without modifying the file.

`defaultChanges` shows current and proposed values for saved hardest-task or list roles that differ from the new defaults; it does not apply those changes. `matchesPreviousDefault` is an exact comparison with the former all-Sol default, not evidence that the user wants it replaced. Preserve independently chosen models, lists, aliases, and efforts. The helper lists retired keys in `droppedRoles`, such as `how critics`. Show these to the user before saving.

### 3. Budget, map, and confirm

**(a) Select a budget.** Use an already specified budget. Otherwise name the saved budget, or say that `large` matches the defaults, and offer the original four options. Prefer the current session's native user-input tool when available:

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Run `scripts/models.mjs budget --budget LABEL --catalog ABSOLUTE_COMBINED_JSON`. It retains the selected executor, model, family, list, order, duplicates, and aliases while resolving the highest supported effort at or below the budget target. Model IDs stay unchanged: both default models use separate `reasoningEffort: "xhigh"` under `large` and `"medium"` under `small`. Identical effort names do not establish identical computation across providers. The budget is a global default target; a consuming skill's explicit task-specific effort still applies. Aliases keep the literal parent settings and do not change with the budget. Any entry in `needsChoice` requires an available model choice before saving.

**(c) Show every role and confirm changes.** Display the current and proposed executor, model entries, and resolved efforts, plus dropped retired keys. On a re-run show the proposed diversity changes from `defaultChanges` alongside current choices; apply only the changes the user accepts. Keep independently chosen values unless the user changes them. Offer detected native models, the confirmed pinned Claude route, `inherit-parent`, and `auto`. Honor choices already authorized in the conversation.

For `arena runners`, `architect runners`, and `interrogate reviewers`, run one independent delegate per list entry, including duplicate models and aliases: list length sets the count. `arena cross-judge pool` is a candidate list from which Arena runs one judge. It tries only entries from a family other than the parent's, in list order, so order the pool by preference. An `inherit-parent` or `auto` entry never judges. If the configured entries cannot run, try the default pool's entries from another family. If none runs, skip the judge and report it. When the parent's model is unknown, try the pool's real entries in order and report that the family check did not run. `swarm workers` supplies every worker's default unless a race or comparison assigns another model per arm. The two-entry defaults preserve the original counts. Keep each consuming workflow's original different-model and different-family requirements, audits, verifiers, and retry rules.

### 4. Validate

Every real ID and its resolved effort must appear under its executor in the detected combined catalog. Native entries cannot validate Claude entries with the same ID. Claude entries require matching runtime capability metadata; bare native catalog entries cannot authorize that route. Aliases omit effort and use the native parent. Resolve unavailable IDs, unsupported efforts, and `needsChoice` entries before writing. Saving configuration confirms the saved choices; model execution and review requirements need their own evidence.

### 5. Save the choices

Read [references/models-contract.md](references/models-contract.md) for the JSON shape and helper arguments. Save the confirmed proposal to an absolute temporary JSON file, then run `scripts/models.mjs write --input ABSOLUTE_JSON --catalog ABSOLUTE_CATALOG --expected-hash HASH`. Use the hash from step 2, or `absent` if no configuration file existed. A concurrent change fails safely; reload and show the new state before saving. The helper validates every role before an atomic save and leaves identical bytes untouched. Keep the same exact role labels as poteto-mode:

| Role                                     | Default model entries                      |
| ---------------------------------------- | ------------------------------------------ |
| feature, refactoring                     | gpt-6.1-sol                                |
| bug-fix                                  | gpt-6.1-sol                                |
| perf-issue                               | gpt-6.1-sol                                |
| hillclimb                                | gpt-6.1-sol                                |
| judgment and prose                       | gpt-6.1-sol                                |
| hardest tasks                            | claude-opus-5-5 (Claude Code)              |
| how explorer                             | gpt-6.1-sol                                |
| how explainer                            | gpt-6.1-sol                                |
| why investigators                        | gpt-6.1-sol                                |
| why synthesizer                          | gpt-6.1-sol                                |
| reflect tooling                          | gpt-6.1-sol                                |
| reflect judgment, divergent, synthesizer | gpt-6.1-sol                                |
| arena runners                            | gpt-6.1-sol, claude-opus-5-5 (Claude Code) |
| arena cross-judge pool                   | gpt-6.1-sol, claude-opus-5-5 (Claude Code) |
| swarm workers                            | gpt-6.1-sol                                |
| architect runners                        | gpt-6.1-sol, claude-opus-5-5 (Claude Code) |
| interrogate reviewers                    | gpt-6.1-sol, claude-opus-5-5 (Claude Code) |

### 6. Confirm

Report the actual saved path, schema version, selected budget, and detected Claude executable/version. State model execution evidence separately; CLI detection alone leaves it unverified. pstack consumers read these global choices when next invoked, including in a new session. Re-running this skill updates them. A plugin install, update, rollback, or uninstall preserves this preference file. An older native-only bundle cannot read schema 2. If the user wants to run that bundle, selecting only native entries or parent aliases in the current setup and saving produces schema 1; do not replace external selections automatically. Claude receives the selected task, role, and absolute installed skill paths on invocation; this setup does not need a second Claude plugin or agent installation.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof, such as a `verify-*` skill or existing harness. If it does not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with $create-verification-skill." On yes, resolve the installed `create-verification-skill/SKILL.md` to an absolute path and follow it. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with $create-formal-verification-skill." On yes, resolve the installed `create-formal-verification-skill/SKILL.md` to an absolute path and follow it. On no, move on without pushing.
