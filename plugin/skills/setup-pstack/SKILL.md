---
name: setup-pstack
description: Configure pstack workers in Codex. Choose worker executors, prepare selected CLIs, select supported models and reasoning budget, and register bundled agents. Use for $setup-pstack, "configure pstack models", or "pstack budget".
---

# Setup pstack

Save accepted choices in `$CODEX_HOME/pstack-codex/models.json`, or `~/.codex/pstack-codex/models.json` when `CODEX_HOME` is unset. Resolve helpers relative to this installed skill and invoke their absolute paths with Node.js. Read [the helper contract](references/models-contract.md) for shapes and arguments.

For removal, run `scripts/register-agents.mjs --unregister` while this bundle is available, then remove the plugin. Unregister preflights owned registrations and retires owned native hook keys without reindexing other hooks. It retains preferences, commands, and trust records. It does not stop live workers. A fresh reset removes the old installation through its own setup before installing this product. There is no old-name alias or automatic preference migration.

## 1. Choose worker executors

Start by asking which worker executors to use, unless the conversation already supplies the choice. Offer native Codex only, or native Codex with Claude Code workers. The parent chat stays in Codex. Prefill the executors used by saved choices on a rerun. Do not infer a worker model from the chosen executors.

Only selected executors need installation and login checks. Codex-only setup must not invoke or require Claude Code. If a previously saved entry uses an executor the user now excludes, show that entry and obtain its replacement before saving. Preserve every other accepted choice.

## 2. Prepare the selected CLIs

Check `node --version`. Helpers require Node.js 24.12 or newer. Codex registration also needs Python 3.11 or newer. Use [CLI installation and login](references/cli-prerequisites.md) when a prerequisite is missing.

For selected Claude Code workers, run the sibling `poteto-mode/scripts/run-claude.mjs detect`. Report its executable, version, compatibility, safe auth status, and guidance. If missing, guide the authorized CLI installation. If logged out, guide human login in the user's terminal. Rerun detection afterward. Reuse existing authentication and configuration. Never copy credentials into a test home or setup file. Detection does not install tools, authenticate, or prove model access. If login status cannot be established, inspect the selected CLI's normal status flow with the user before choosing its models.

The [execution binding](../poteto-mode/references/execution.md) describes runtime capability checks. A global CLI effort list proves syntax only. It supplies no default model or account entitlement.

## 3. Load choices and collect supported models

Run `scripts/models.mjs read` and retain `config`, `proposal`, `needsChoice`, and `sha256`. Fresh `config.roles` is empty. The proposal presents all 17 roles with unresolved model slots. Scalars start with one slot and panels or pools with two. Saved choices prefill the proposal and remain authoritative. Missing roles execute on the actual native parent with their original counts, disclosed as `unconfigured`. Setup is optional before a task.

Enumerate exact model IDs and supported efforts from this session's native tools or Codex `model/list`. Collect every page. For selected Claude workers, collect model-specific host or configuration evidence, or ask for confirmation of the exact model and its efforts. Label that source. A configured candidate alone does not prove access. Honor confirmation already supplied in the conversation.

Normalize the combined catalog with `scripts/models.mjs catalog --input ABSOLUTE_JSON`. Include `--claude-runtime ABSOLUTE_DETECT_JSON` only when configuring external Claude entries. Every external entry needs its own source and efforts expressible by that runtime. See [model capability records](references/models-contract.md#model-capability-records). No fixed Sol, Opus, or other model is required.

`auto` and `inherit-parent` always mean the actual native Codex parent. They omit a separate effort and cannot select the external executor. Bind them through Codex execution's parent-selection rules.

## 4. Choose roles and reasoning budget

Present every role and its proposed executor, model or parent alias, and effort. Offer detected exact choices and parent aliases. A user can apply one selection to several roles. Resolve proposed slots that the user accepts as saved choices. A user may leave roles unconfigured after seeing their native-parent behavior. Do not persist unresolved proposal slots.

Use an already specified budget. Otherwise offer these original four targets.

- `unlimited` targets `max` reasoning.
- `large` targets `xhigh` reasoning.
- `medium` targets `high` reasoning.
- `small` targets `medium` reasoning.

`scripts/models.mjs budget --budget LABEL --catalog ABSOLUTE_JSON` previews supported efforts for saved choices. It preserves model IDs, executors, ordered duplicates, and aliases. Choose the highest supported effort at or below the target. The preview does not write. Parent aliases keep the parent's actual model and effort. Task-level effort adjustments apply to exact model selections.

Keep these original role names and initial counts.

| Role | Initial entries |
| --- | --- |
| feature, refactoring | 1 |
| bug-fix | 1 |
| perf-issue | 1 |
| hillclimb | 1 |
| judgment and prose | 1 |
| hardest tasks | 1 |
| how explorer | 1 |
| how explainer | 1 |
| why investigators | 1 |
| why synthesizer | 1 |
| reflect tooling | 1 |
| reflect judgment, divergent, synthesizer | 1 |
| arena runners | 2 |
| arena cross-judge pool | 2 |
| swarm workers | 1 |
| architect runners | 2 |
| interrogate reviewers | 2 |

Panels run every ordered entry, including duplicates and aliases. Arena's cross-judge pool selects one eligible judge in order. Parent aliases never establish a different family. Arena skips its judge with disclosure if no selected eligible entry runs. Required diversity gates elsewhere keep their own unmet outcome. No unused executor is a blanket requirement.

## 5. Review, register, and save

Show the accepted roles, any roles left unconfigured, the budget, supported efforts, and evidence sources. Honor choices already authorized in the conversation. Save the accepted sparse config to an absolute temporary JSON file. Validate with `scripts/models.mjs write --input ABSOLUTE_JSON --catalog ABSOLUTE_CATALOG --expected-hash HASH --dry-run`. Use the read hash, or `absent` for a fresh file.

Run `scripts/register-agents.mjs`. It registers `poteto-agent`, `comment-sicko`, and the description-only `pstack-general-purpose` role. Python's standard-library `tomllib` checks native configuration. `--python ABSOLUTE_PATH` selects an existing interpreter. The helper preserves unrelated setting values, modes, roles, and preferences. The native config API may normalize comments and formatting inside the `PreToolUse` array when appending a generation. On the tested macOS runtime it also writes config files with mode `0600`. It refuses user edits, unowned declarations, symlinks, and damaged ownership. An unsupported inline agents table needs conversion to normal tables. Report the exact conflict before proceeding.

On macOS, normal registration installs a self-contained command hook as an owned user-config generation. The helper checks runtime support and conflicts, trusts its exact key and hash through the native config API, and confirms readback before publishing agent definitions. The receipt includes `commandBoundary`. Unchanged generations need no writes. A changed guard or interpreter appends a generation and preserves old commands, trust, and slots. Package updates and unrelated package content do not replace these commands. Setup checks the validated absolute Node interpreter, which remains a runtime dependency.

A disabled, removed, conflicting, or unsupported boundary is a setup gap. Preserve existing agents and report the failure. Never silently re-enable a user-disabled hook or restore a user-removed generation. `--definitions-only` is reserved for isolated ownership fixtures. It and `--dry-run` do not activate or retire hooks. Native roles, original worker instructions, selected models, and reasoning budgets retain their existing routing.

Read the receipt's file-based `agents`, `metadataRoles`, and config declaration status. Repeated registration is idempotent. An isolated `--codex-home ABS` selects a fixture target. `--dry-run` previews without writing.

After registration succeeds, run the same model write without `--dry-run`. A stale hash requires reloading and reviewing current state. Saving is atomic and identical bytes stay untouched. Both native and mixed settings use the current schema 1 under the new identity.

## 6. Finish setup

Report the saved path, budget, selected executors, registration, and source evidence. After setup, start a fresh root Codex session to load the registered roles and native user hook. Sessions loaded before this migration cannot claim protection from config readback. When the user requests execution verification, use the installed namespace with a small task and the selected worker. Record requested and observed model separately, and distinguish saved settings, fixture evidence, native CLI execution, and Desktop UI evidence. Saving setup does not itself verify worker execution.

## Optional project verification

If the project lacks a way to drive its real app, offer `create-verification-skill` once. If it lacks formal verification, offer `create-formal-verification-skill` once. Follow the selected installed skill only when accepted.
