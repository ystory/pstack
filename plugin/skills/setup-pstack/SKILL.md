---
name: setup-pstack
description: Configure pstack workers in Codex. Choose worker executors, prepare selected CLIs, select supported models and reasoning budget, and register bundled agents. Use for $setup-pstack, "configure pstack models", or "pstack budget".
---

# Setup pstack

Save accepted choices in `$CODEX_HOME/pstack-codex/models.json`, or `~/.codex/pstack-codex/models.json` when `CODEX_HOME` is unset. Resolve helpers relative to this installed skill and invoke their absolute paths with Node.js. Read [the helper contract](references/models-contract.md) for shapes and arguments.

For removal, run `scripts/register-agents.mjs --unregister` while this bundle is available, then remove the plugin. Unregister removes only unchanged owned registrations and retains preferences. A fresh reset removes the old installation through its own setup before installing this product. There is no old-name alias or automatic preference migration.

## 1. Choose worker executors

Start by asking which worker executors to use, unless the conversation already supplies the choice. Offer the available worker executors independently. Native Codex, Claude Code, Pi, and Antigravity can be selected in any combination. The parent chat stays in Codex. Prefill the executors used by saved choices on a rerun. Do not infer a worker model from the chosen executors.

Only selected executors need installation and login checks. Unselected worker CLIs are neither invoked nor required. If a previously saved entry uses an executor the user now excludes, show that entry and obtain its replacement before saving. Preserve every other accepted choice.

## 2. Prepare the selected CLIs

Check `node --version`. Helpers require Node.js 24.12 or newer. Codex registration also needs Python 3.11 or newer. Use [CLI installation and login](references/cli-prerequisites.md) when a prerequisite is missing.

For selected Claude Code workers, run the sibling `poteto-mode/scripts/run-claude.mjs detect`. Report its executable, version, compatibility, safe auth status, and guidance. If missing, guide the authorized CLI installation. If logged out, guide human login in the user's terminal. Rerun detection afterward. Reuse existing authentication and configuration. Never copy credentials into a test home or setup file. Detection does not install tools, authenticate, or prove model access. If login status cannot be established, inspect the selected CLI's normal status flow with the user before choosing its models.

For selected Pi workers, use the Pi prerequisite section and catalog procedure below.

For selected Antigravity workers, run the sibling `poteto-mode/scripts/run-agy.mjs detect`. Use the prerequisite guide for the official agy CLI, then collect its source-labeled catalog below. Reuse inherited authentication without reading credentials or changing personal defaults. Detection proves required syntax and version only.

The [execution binding](../poteto-mode/references/execution.md) describes runtime capability checks. A global CLI effort list proves syntax only. It supplies no default model or account entitlement.

## 3. Load choices and collect supported models

Run `scripts/models.mjs read` and retain `config`, `proposal`, `needsChoice`, `droppedRoles`, and `sha256`. Fresh `config.roles` is empty. The proposal presents all 13 roles with unresolved model slots. Scalars start with one slot and panels or pools with three. Saved choices prefill the proposal and remain authoritative. Missing roles execute on the actual native parent with their original counts, disclosed as `unconfigured`. Setup is optional before a task.

A retired role in the saved file, such as `how explorer` or `why investigators`, appears in `droppedRoles` and not in `config`. Show each one to the user. The next save drops it. Any other unknown role still fails validation.

For selected native Codex workers, enumerate exact model IDs and supported efforts from this session's native tools or Codex `model/list`. Collect every page. For selected Claude workers, collect model-specific host or configuration evidence, or ask for confirmation of the exact model and its efforts. Label that source. A configured candidate alone does not prove access. Honor confirmation already supplied in the conversation.

For selected Pi workers, run the sibling `poteto-mode/scripts/run-pi.mjs catalog --cwd ABSOLUTE_PROJECT --run-dir ABSOLUTE_NEW_LOCAL_DIRECTORY`. It queries exact provider/model routes and their supported efforts without submitting a task prompt. Use its `catalog.json` with `--pi-catalog ABSOLUTE_PI_CATALOG` when normalizing. Configured availability does not prove authentication freshness or successful inference.

For selected Antigravity workers, run the sibling `poteto-mode/scripts/run-agy.mjs catalog --cwd ABSOLUTE_PROJECT --run-dir ABSOLUTE_NEW_LOCAL_DIRECTORY`. Pass its sanitized `catalog.json` through `--agy-catalog ABSOLUTE_AGY_CATALOG` when normalizing. No model prompt is submitted. Fixed-effort labels establish only the reported variant's configured availability. Unclassified candidates need per-model evidence before selection.

Normalize the combined catalog with `scripts/models.mjs catalog --input ABSOLUTE_JSON`. Include `--claude-runtime ABSOLUTE_DETECT_JSON` only when configuring external Claude entries. Every Claude entry needs its own source and efforts expressible by that runtime. Pi entries carry their own per-model RPC source and provider. See [model capability records](references/models-contract.md#model-capability-records). No fixed Sol, Opus, or other model is required.

For Antigravity-only worker choices, skip native, Claude, and Pi probes and model collection. Normalize with `scripts/models.mjs catalog --agy-catalog ABSOLUTE_AGY_CATALOG` alone. For any combination, include only the selected catalogs.

For Pi-only worker choices, skip native and other external model collection. Normalize with `scripts/models.mjs catalog --pi-catalog ABSOLUTE_PI_CATALOG` alone. Omit `--input`, `--native-catalog`, and `--claude-runtime` when unused. Native parent aliases remain available without a native model catalog.

`auto` and `inherit-parent` always mean the actual native Codex parent. They omit a separate effort and cannot select an external executor. Bind them through Codex execution's parent-selection rules.

## 4. Choose roles and reasoning budget

Present every role and its proposed executor, Pi provider when applicable, model or parent alias, and effort. Offer detected exact choices and parent aliases. A user can apply one selection to several roles. Resolve proposed slots that the user accepts as saved choices. A user may leave roles unconfigured after seeing their native-parent behavior. Do not persist unresolved proposal slots.

Use an already specified budget. Otherwise offer these original four budgets, and name the saved budget on a rerun. Each role has a target effort, which is its starting effort in the table below moved by the budget. `large` keeps it, `unlimited` raises it one step, `medium` lowers it one step, and `small` lowers it two steps, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. A target at either end of the ladder stays there. Most roles start at `xhigh`, and each budget label names where those land.

- `unlimited` names `max` reasoning.
- `large` names `xhigh` reasoning.
- `medium` names `high` reasoning.
- `small` names `medium` reasoning.

`scripts/models.mjs budget --budget LABEL --catalog ABSOLUTE_JSON` previews supported efforts for saved choices. It preserves model IDs, executors, ordered duplicates, and aliases. Choose the highest supported effort at or below the role's target. The preview does not write. Parent aliases keep the parent's actual model and effort. Task-level effort adjustments apply to exact model selections.

Keep these role names, initial counts, and starting efforts.

| Role | Initial entries | Starting effort |
| --- | --- | --- |
| feature, refactoring | 1 | xhigh |
| bug-fix | 1 | xhigh |
| perf-issue | 1 | xhigh |
| hillclimb | 1 | xhigh |
| judgment and prose | 1 | xhigh |
| hardest tasks | 1 | max |
| reflect tooling | 1 | high |
| reflect judgment, divergent, synthesizer | 1 | xhigh |
| arena runners | 3 | high |
| arena cross-judge pool | 3 | high |
| swarm workers | 1 | high |
| architect runners | 3 | high |
| interrogate reviewers | 3 | high |

Panels run every ordered entry, including duplicates and aliases. Arena's cross-judge pool selects one eligible judge from a vendor other than the parent's, in order. Families are the ones Phase A of the arena skill defines, so Fable is its own family. Fable and the other Claude models are one vendor. Parent aliases never establish a different family or vendor. Pi provider names and ambiguous virtual model IDs do not establish model lineage. Arena skips its judge with disclosure if no selected eligible entry runs. Required diversity gates elsewhere keep their own unmet outcome. No unused executor is a blanket requirement.

Pi choices retain `{ "executor": "pi", "provider": "EXACT_PROVIDER", "model": "EXACT_MODEL", "reasoningEffort": "LEVEL" }`. Choose provider and model separately. Pi uses `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Budget previews select only reported levels on that ladder, including `off` for nonreasoning models. Native aliases stay native, and native registration creates no Pi model definitions. Follow [Pi execution](../poteto-mode/references/pi-execution.md) for explicit tools, context, fresh sessions, capability gaps, and required family gates.

Antigravity choices retain `{ "executor": "antigravity", "model": "EXACT_AGY_ID", "reasoningEffort": "LEVEL" }`. They have no provider or authentication fields and create no native model definitions. Budget previews keep the exact ID and use only that model's reported efforts. A fixed `xhigh` variant has no lower effort unless its per-model evidence says otherwise. If the target cannot be met, resolve `needsChoice` without silently switching IDs. Follow [Antigravity execution](../poteto-mode/references/agy-execution.md) for scoped permissions, complete context, native history, exact continuation, and capability limits.

## 5. Review, register, and save

Show the accepted roles, any roles left unconfigured, the budget, supported efforts, and evidence sources. Honor choices already authorized in the conversation. Save the accepted sparse config to an absolute temporary JSON file. Validate with `scripts/models.mjs write --input ABSOLUTE_JSON --catalog ABSOLUTE_CATALOG --expected-hash HASH --dry-run`. Use the read hash, or `absent` for a fresh file.

Run `scripts/register-agents.mjs`. It registers `poteto-agent`, `comment-sicko`, and the description-only `pstack-general-purpose` role. Python's standard-library `tomllib` checks native configuration. `--python ABSOLUTE_PATH` selects an existing interpreter. The helper preserves unrelated config, comments, modes, roles, and preferences. It refuses user edits, unowned declarations, symlinks, and damaged ownership. An unsupported inline agents table needs conversion to normal tables. Report the exact conflict before proceeding.

Read the receipt's file-based `agents`, `metadataRoles`, and config declaration status. Repeated registration is idempotent. An isolated `--codex-home ABS` selects a fixture target. `--dry-run` previews without writing.

After registration succeeds, run the same model write without `--dry-run`. A stale hash requires reloading and reviewing current state. Saving is atomic and identical bytes stay untouched. Both native and mixed settings use the current schema 1 under the new identity.

## 6. Finish setup

Report the saved path, budget, selected executors, registration, and source evidence. Explain that a fresh Codex session loads the registered roles. When the user requests execution verification, use the installed namespace with a small task and the selected worker. Record requested and observed model separately, and distinguish saved settings, fixture evidence, native CLI execution, and Desktop UI evidence. Saving setup does not itself verify worker execution.

## Optional project verification

If the project lacks a way to drive its real app, offer `create-verification-skill` once. If it lacks formal verification, offer `create-formal-verification-skill` once. Follow the selected installed skill only when accepted.
