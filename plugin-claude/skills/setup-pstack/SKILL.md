---
name: setup-pstack
description: Configure pstack's per-role Claude, Codex, or Pi workers in Claude Code. Prepare selected official runtimes and login, save independent model choices, and register exact-model native agents. Use for /setup-pstack, "configure pstack models", or "pstack budget".
---

# Setup pstack

Configure workers for this Claude Code host. Save choices in `${CLAUDE_CONFIG_DIR:-~/.claude}/pstack-cc/models.json`. These preferences survive plugin updates and removal. The Codex distribution keeps its independent settings.

Resolve helpers relative to this installed skill and invoke their absolute paths with Node.js. Read [the helper contract](references/models-contract.md) for JSON shapes and fixture arguments.

## 1. Choose worker executors

Start with worker executor selection unless already supplied in the conversation. Offer the available worker executors independently. Native Claude, Codex, and Pi can be selected in any combination. The parent chat stays in Claude Code. Prefill executors used by saved entries on a rerun. A harness choice does not choose a model. If a saved entry uses an executor the user excludes, show it and obtain its replacement before saving. Preserve other choices.

## 2. Prepare selected runtimes

Check `node --version` first. The helpers require Node.js 24.12 or newer. If Node is missing, use the [prerequisite guide](references/prerequisites.md).

When native Claude workers are selected, run `scripts/detect.mjs detect --executors claude-code`. Include `codex` in that list only when Codex workers are also selected. When Codex is selected without native Claude workers, run the sibling `poteto-mode/scripts/run-codex.mjs detect` directly. For Pi-only workers, skip both detectors and use the Pi catalog procedure below. Report runtime versions, native effort support, and login state. Unselected Codex and Pi CLIs are neither probed nor required. The detection helper is read-only; it does not perform installation or login.

Within the authorized setup, prepare missing selected tools yourself using their official installation guidance and the host's normal tools. For Codex workers, install the official standalone server when needed and make `codex-app-server` available on the PATH inherited by this host and future workers. Choose suitable installation details for this machine. Recheck detection without an executable override before completing setup. Do not leave installation or PATH preparation as a user checklist. Hand off only steps that require human interaction, such as login or an operating-system approval.

When the Claude detector runs, report `configuration.claudeHome` as the setup configuration target and `claude.cli.environment` as the inherited CLI environment used for authentication. `--claude-home` changes the configuration target only. Existing CLI authentication stays in the inherited environment, including an existing `CLAUDE_CONFIG_DIR`. An intentionally selected environment profile keeps its own login state.

Claude-only choices do not require Codex. Use [the prerequisite guide](references/prerequisites.md) for selected tools that need preparation, then rerun detection. Reuse existing installations and authentication. Distinguish ChatGPT subscription login from OpenAI API-key billing. Keep interactive login in the user's terminal or the host's normal login flow. Never ask the user to paste credentials into the conversation.

Native exact-model choices use generated agent definitions and per-invocation effort. Claude Code 2.1.292 introduced that effort parameter. If the installed host lacks the parameter, guide an update before configuring explicit native effort. Inspect the active tool schema as well as the version.

## 3. Collect actual model options

For Codex workers with selected native Claude workers, run `scripts/detect.mjs catalog --executors claude-code,codex --cwd ABSOLUTE_PROJECT` through inherited PATH. For Codex workers without native Claude workers, run the sibling `poteto-mode/scripts/run-codex.mjs catalog --cwd ABSOLUTE_PROJECT` directly. These routes use the same official standalone runtime. For diagnostics, `--codex-executable ABS` overrides only that catalog invocation. The bundled runner uses the selected server for safe account status and every `model/list` page. Its receipt separates runtime capability, authentication, catalog, and execution evidence.

For selected Pi workers, use the prerequisite guide and run the sibling `poteto-mode/scripts/run-pi.mjs catalog --cwd ABSOLUTE_PROJECT --run-dir ABSOLUTE_NEW_LOCAL_DIRECTORY`. This queries exact provider/model routes and per-model thinking levels without submitting a prompt. Pass its `catalog.json` through `--pi-catalog ABSOLUTE_PI_CATALOG` when normalizing. Configured availability does not prove fresh authentication or successful inference.

For native Claude workers, use exact model IDs and supported efforts exposed by the current host or its model catalog. Inspect the current host and configuration rather than copying a fixed list from this skill. Detection lists configured model candidates, including `settings.json` model choices and model-specific environment variables. Those candidates require confirmation. A configured name or allowlist does not prove entitlement or supported efforts.

The detector does not enumerate native models; its `modelCatalog.discovered: false` describes the helper, not the host. Claude Code states the exact model IDs available to the session in your environment context, and the native Agent tool schema lists the accepted `effort` levels. Use those as a `host` catalog source and name both origins in its description. The host does not state per-model effort support; say so in that description.

If neither the session context nor the tool schema provides exact IDs and efforts, ask the user to confirm them and label the resulting catalog source `manual-confirmation`. Keep that fallback visible. Do not substitute moving aliases such as `opus` or `sonnet` for exact selections.

Normalize the selected routes with `scripts/models.mjs catalog --input ABSOLUTE_CODEX_RECEIPT --native-catalog ABSOLUTE_NATIVE_CATALOG`. Omit the Codex input for Claude-only setup. Every explicit selection must match its executor's catalog. A matching ID under another executor does not validate it.

For Pi-only worker choices, skip native and other external model collection. Normalize with `scripts/models.mjs catalog --pi-catalog ABSOLUTE_PI_CATALOG` alone. Omit `--input`, `--native-catalog`, and `--claude-runtime` when unused. Native parent aliases remain available without a native model catalog.

`auto` and `inherit-parent` always mean the actual native Claude parent. They omit effort and executor overrides on invocation. They cannot select Codex or Pi. Use the [Claude execution binding](../poteto-mode/references/execution.md) when dispatching.

## 4. Load current choices

Run `scripts/models.mjs read`. Retain its `sha256`, `config`, `proposal`, and `needsChoice`.

`config` contains only saved selections and is empty on a fresh install. `proposal` exposes all 17 roles with unresolved model slots. Scalar roles have one initial slot, and panels or pools have two. No exact model is a proposal default. Missing roles execute on the actual native Claude parent with their original cardinality and `source: "unconfigured"`. Disclose that resolution. Before-setup tasks remain available.

On a rerun, retain independently chosen models, executors, aliases, efforts, list order, and duplicates. Unknown role keys fail validation without changing preferences.

## 5. Select the budget and role mapping

Use a budget already specified in the conversation. Otherwise show the saved budget, or explain that `large` is the initial effort target, and offer the original four choices.

- `unlimited` targets `max` reasoning.
- `large` targets `xhigh` reasoning.
- `medium` targets `high` reasoning.
- `small` targets `medium` reasoning.

Run `scripts/models.mjs budget --budget LABEL --catalog ABSOLUTE_CATALOG` to preview the highest supported effort at or below the target. It retains exact model IDs, executors, role shapes, list order, duplicates, and aliases. Parent aliases keep the actual parent's settings. Resolve unsupported saved choices before saving. Do not persist unresolved proposal slots. A user may leave roles unconfigured after seeing their parent fallback.

Show every role's current and proposed executor, Pi provider when applicable, exact model, and effort. Ask whether to accept the proposal or change specific roles. Offer the detected choices and parent aliases. Honor choices already authorized in the conversation. A user can choose one available model for several roles without editing each role manually.

Scalar roles hold one entry or parent alias. `arena runners`, `architect runners`, and `interrogate reviewers` hold nonempty lists. Run one independent delegate per entry, including duplicates and aliases. `arena cross-judge pool` is an ordered candidate pool, from which Arena runs one eligible judge. Parent aliases never judge. Preserve Arena's ordered selected pool and disclosed judge skip, plus every other workflow's original diversity, verifier, retry, and fresh-worker requirements.

Pi choices retain `{ "executor": "pi", "provider": "EXACT_PROVIDER", "model": "EXACT_MODEL", "reasoningEffort": "LEVEL" }`. Choose provider and model separately. Pi uses `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Budget previews select only reported levels on that ladder, including `off` for nonreasoning models. Native aliases stay native, and native registration creates no Pi model definitions. Follow [Pi execution](../poteto-mode/references/pi-execution.md) for explicit tools, context, fresh sessions, capability gaps, and required family gates.

## 6. Review, register, and save

Show accepted roles, remaining unconfigured roles, budget, and evidence sources. Write the accepted sparse config to an absolute temporary JSON file. Validate it with `scripts/models.mjs write --input ABSOLUTE_JSON --catalog ABSOLUTE_CATALOG --expected-hash HASH --dry-run`. Use the read hash, or `absent` if no file exists. Missing roles keep their disclosed native-parent fallback.

Run `scripts/register-agents.mjs --input ABSOLUTE_JSON`. It derives four native agent kinds from this plugin's original bodies for each distinct exact Claude model. It writes owned definitions under the Claude home, without editing the installed plugin cache, unrelated agents, `settings.json`, or Codex configuration. `general-purpose`, `poteto-agent`, and `comment-sicko` retain their supplied bodies. `read-only` retains the general-purpose body and disallows `Write`, `Edit`, and `NotebookEdit` for actual readonly callers. Bash remains available. Task-specific effort uses the native invocation parameter.

Registration retains earlier owned variants so interruption or a rejected preference save leaves the saved selection usable. The receipt lists these unused files in `retained`. Registration never prunes them, including on later reruns, because another setup may still save a staged choice. Explicit unregister removes all owned variants.

Registration is idempotent. Updates and older plugin bundles refresh the proposed variants from their bundled bodies and retain other owned variants unchanged. A modified or unowned destination produces a conflict before registration changes. An interrupted registration retains a journal and completes that same transaction on the next run. Preserve the diagnostic files if recovery reports a user edit.

After registration succeeds, run the same `models.mjs write` command without `--dry-run`. A changed hash requires reloading the current choices before saving. The helper saves atomically and leaves identical bytes untouched.

## 7. Finish setup

Report the preferences path, selected executors, registered exact-model definitions, and detected CLI versions. State which choices came from a catalog or manual confirmation. A saved preference or definition does not verify execution. Explain that a new Claude Code session refreshes the registered agent list when needed. When the user requests execution verification, use the selected executor binding and effort. Native Claude workers use the emitted `agentType` and the installed namespace for a small task with the selected worker. Keep observed model identity separate from requested settings. Distinguish fixture checks, native CLI execution, and Desktop UI evidence. A helper-only check does not establish first-time onboarding.

When the user requests removal, run `scripts/register-agents.mjs --unregister` before uninstalling the plugin. It removes only unchanged owned definitions and their registration record. It retains model preferences and unrelated files.

## 8. Offer a verification skill

If the project has no way to drive its real application, offer the original optional project verification skill once. On acceptance, resolve `create-verification-skill/SKILL.md` and follow it. On decline, continue.

## 9. Offer a formal verification skill

If the project has no formal verification skill, offer the original optional formal verification skill once. On acceptance, resolve `create-formal-verification-skill/SKILL.md` and follow it. On decline, continue.
