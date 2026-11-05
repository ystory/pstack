---
name: setup-pstack
description: Configure pstack's per-role Claude or Codex workers in Claude Code. Detect CLI and login state, guide missing prerequisites, save independent model choices, and register exact-model native agents. Use for /setup-pstack, "configure pstack models", or "pstack budget".
---

# Setup pstack

Configure workers for this Claude Code host. Save choices in `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. These preferences survive plugin updates and removal. The Codex distribution keeps its independent settings.

Resolve helpers relative to this installed skill and invoke their absolute paths with Node.js. Read [the helper contract](references/models-contract.md) for JSON shapes and fixture arguments.

## 1. Detect executors and login state

Check `node --version` first. The helpers require Node.js 24.12 or newer. If Node is missing, use the [prerequisite guide](references/prerequisites.md).

Run `scripts/detect.mjs detect`. Report Node and Claude versions, native effort support, and each executor's login state. It checks Claude's CLI and auth status and the bundled Codex runner's capabilities. It does not install, authenticate, read credential files, or change settings.

Claude-only choices do not require Codex. For a selected executor that is missing or logged out, read [the prerequisite guide](references/prerequisites.md), guide installation or login, then rerun detection. Distinguish ChatGPT subscription login from OpenAI API-key billing. Keep interactive login in the user's terminal or the host's normal login flow. Never ask the user to paste credentials into the conversation.

Native exact-model choices use generated agent definitions and per-invocation effort. Claude Code 2.1.292 introduced that effort parameter. If the installed host lacks the parameter, guide an update before configuring explicit native effort. Inspect the active tool schema as well as the version.

## 2. Collect actual model options

For Codex workers, run `scripts/detect.mjs catalog --cwd ABSOLUTE_PROJECT`. The bundled runner collects every `model/list` page and each model's supported efforts. Its receipt separates CLI, authentication, catalog, and execution evidence.

For native Claude workers, use exact model IDs and supported efforts exposed by the current host or its model catalog. Inspect the current host and configuration rather than copying a fixed list from this skill. Detection lists configured model candidates, including `settings.json` model choices and model-specific environment variables. Those candidates require confirmation. A configured name or allowlist does not prove entitlement or supported efforts.

If the host cannot enumerate exact IDs and efforts, ask the user to confirm them and label the resulting catalog source `manual-confirmation`. Keep that fallback visible. Do not substitute moving aliases such as `opus` or `sonnet` for exact selections.

Normalize both routes with `scripts/models.mjs catalog --input ABSOLUTE_CODEX_RECEIPT --native-catalog ABSOLUTE_NATIVE_CATALOG`. Omit the Codex input for Claude-only setup. Every explicit selection must match its executor's catalog. A matching ID under another executor does not validate it.

`auto` and `inherit-parent` always mean the actual native Claude parent. They omit effort and executor overrides on invocation. They cannot select Codex. Use the [Claude execution binding](../poteto-mode/references/claude-execution.md) when dispatching.

## 3. Load current choices

Run `scripts/models.mjs read`. Retain its `sha256`, `config`, `proposal`, and `needsChoice`.

`config` contains valid saved selections. `proposal` fills missing roles with the original upstream suggestions. Upstream code roles suggest Grok, which neither bundled executor supplies as an assumed route. Those suggestions remain visibly unresolved until the user chooses an available executor and model. Setup does not replace them with a permanent Sol default. The original Claude judgment preference and original panel order remain in the proposal. Execution is separate. Missing roles use the original Claude adapter's native parent or Opus alias fallback without setup, with disclosure. These execution fallbacks are not saved exact choices.

On a rerun, retain independently chosen models, executors, aliases, efforts, list order, and duplicates. Report retired keys from `droppedRoles` before saving.

## 4. Select the budget and role mapping

Use a budget already specified in the conversation. Otherwise show the saved budget, or explain that `large` matches the upstream effort target, and offer the original four choices.

- `unlimited` targets `max` reasoning.
- `large` targets `xhigh` reasoning.
- `medium` targets `high` reasoning.
- `small` targets `medium` reasoning.

Run `scripts/models.mjs budget --budget LABEL --catalog ABSOLUTE_CATALOG` to preview the highest supported effort at or below the target. It retains exact model IDs, executors, role shapes, list order, duplicates, and aliases. Parent aliases keep the actual parent's settings. Resolve each `needsChoice` entry before saving.

Show every role's current and proposed executor, exact model, and effort. Ask whether to accept the proposal or change specific roles. Offer the detected choices and parent aliases. Honor choices already authorized in the conversation. A user can choose one available model for several roles without editing each role manually.

Scalar roles hold one entry or parent alias. `arena runners`, `architect runners`, and `interrogate reviewers` hold nonempty lists. Run one independent delegate per entry, including duplicates and aliases. `arena cross-judge pool` is an ordered candidate pool, from which Arena runs one eligible judge. Parent aliases never judge. Preserve Arena's original default-pool fallback and disclosed judge skip, plus every other workflow's original diversity, verifier, retry, and fresh-worker requirements.

## 5. Validate, register, and save

Write the complete accepted proposal to an absolute temporary JSON file. Validate it with `scripts/models.mjs write --input ABSOLUTE_JSON --catalog ABSOLUTE_CATALOG --expected-hash HASH --dry-run`. Use the read hash, or `absent` if no file exists. All 17 roles need resolved choices for a first save.

Run `scripts/register-agents.mjs --input ABSOLUTE_JSON`. It derives four native agent kinds from this plugin's original bodies for each distinct exact Claude model. It writes owned definitions under the Claude home, without editing the installed plugin cache, unrelated agents, `settings.json`, or Codex configuration. `general-purpose`, `poteto-agent`, and `comment-sicko` retain their supplied bodies. `read-only` retains the general-purpose body and disallows `Write`, `Edit`, and `NotebookEdit` for actual readonly callers. Bash remains available. Task-specific effort uses the native invocation parameter.

Registration retains earlier owned variants so interruption or a rejected preference save leaves the saved selection usable. The receipt lists these unused files in `retained`. Registration never prunes them, including on later reruns, because another setup may still save a staged choice. Explicit unregister removes all owned variants.

Registration is idempotent. Updates and older plugin bundles refresh the proposed variants from their bundled bodies and retain other owned variants unchanged. A modified or unowned destination produces a conflict before registration changes. An interrupted registration retains a journal and completes that same transaction on the next run. Preserve the diagnostic files if recovery reports a user edit.

After registration succeeds, run the same `models.mjs write` command without `--dry-run`. A changed hash requires reloading the current choices before saving. The helper saves atomically and leaves identical bytes untouched.

## 6. Report the result

Report the preferences path, selected executors, registered exact-model definitions, and detected CLI versions. State which choices came from a catalog or manual confirmation. A saved preference or definition does not verify execution. Start a new Claude Code session if its agent list has not refreshed, then use the emitted `agentType` with the selected effort. Keep observed model identity separate from requested settings.

When the user requests removal, run `scripts/register-agents.mjs --unregister` before uninstalling the plugin. It removes only unchanged owned definitions and their registration record. It retains model preferences and unrelated files.

## 7. Offer a verification skill

If the project has no way to drive its real application, offer the original optional project verification skill once. On acceptance, resolve `create-verification-skill/SKILL.md` and follow it. On decline, continue.

## 8. Offer a formal verification skill

If the project has no formal verification skill, offer the original optional formal verification skill once. On acceptance, resolve `create-formal-verification-skill/SKILL.md` and follow it. On decline, continue.
