# Global model choices

`scripts/models.mjs` stores user choices outside the plugin at `$CODEX_HOME/pstack-codex/models.json` (default `~/.codex/pstack-codex/models.json`). Resolve the script from the actual installed skill path. An explicit `--codex-home ABSOLUTE_PATH` selects an isolated destination without changing environment variables.

```json
{
  "schemaVersion": 1,
  "budget": "large",
  "roles": {
    "feature, refactoring": [
      { "model": "EXACT_CODEX_ID", "reasoningEffort": "xhigh" }
    ],
    "arena runners": [
      { "model": "EXACT_CODEX_ID", "reasoningEffort": "xhigh" },
      {
        "executor": "claude-code",
        "model": "EXACT_CLAUDE_ID",
        "reasoningEffort": "xhigh"
      }
    ]
  }
}
```

The saved file contains accepted roles. A write may supply only changed roles, and omitted roles preserve existing choices. Each role is an ordered array. The six scalar roles contain exactly one entry. The two panel roles and `arena cross-judge pool` contain one or more entries. Configured lists retain their length, order, and duplicates.

`executor` is optional. Omitted or `"codex"` selects native Codex, and `"claude-code"` selects the shared Claude CLI runner. Exact entries keep a separate `reasoningEffort`. Parent aliases are `{ "model": "auto" }` or `{ "model": "inherit-parent" }`, without effort or external executor. They bind to the actual native parent.

The current new-identity schema is 1 for both native and mixed selections. There are no old-state readers or automatic migrations. Fresh `config.roles` is empty. Setup's separate `proposal` contains all 9 roles, with unresolved objects containing only the role's target effort for missing slots. Scalars start with one slot, panels with three, and `arena cross-judge pool` with two. These unresolved objects cannot be saved as model entries. Sparse accepted saves are valid. Missing roles resolve to native `inherit-parent` at the original cardinality and disclose `source: "unconfigured"`.

The retired keys `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `hardest tasks`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, and `architect runners` can remain in a saved file. Read, resolve, and budget leave them out of `config`, list them in `droppedRoles`, and do not validate their values. The next write omits them and lists them in its `droppedRoles`. Every other saved value stays unchanged.

A saved `"budget": "unlimited"` value also keeps working. Read, resolve, and budget treat it as `"large"` and report `{ "from": "unlimited", "to": "large" }` in `replacedBudget`, or `null` when no saved budget was replaced. The next write saves `"large"` unless its input names another accepted budget, and reports the replacement in `replacedBudget`. Any other unknown budget fails validation.

Ordered lists preserve duplicate seats. Each role has a starting effort. `swarm workers`, the two panels (`arena runners`, `interrogate reviewers`), and `arena cross-judge pool` start at `high`. The other five roles start at `xhigh`. No role runs above `xhigh`. A budget moves every starting effort by steps on the ladder `low`, `medium`, `high`, `xhigh`. `large` keeps it, `medium` lowers it one step, and `small` lowers it two steps. A target stays at the bottom of the ladder. A budget preview maps each saved exact entry to the highest effort its executor and model support at or below the role's target. Parent aliases retain the actual parent's settings.

Write rejects any exact entry whose `reasoningEffort` is above `xhigh` (`max` or `ultra`), across all executors. Read and resolve still load a saved entry above `xhigh` unchanged.

## Commands

- `read [--codex-home ABS]` returns `file`, `exists`, `sha256`, `config`, `targetReasoningEffort`, full unresolved `proposal`, `needsChoice`, `droppedRoles`, and `replacedBudget`. Saved roles prefill the proposal. Read never writes.
- `resolve --role "ROLE" [--codex-home ABS]` returns `role`, `entries`, `source`, `file`, `budget`, `targetReasoningEffort`, `droppedRoles`, and `replacedBudget`. Its `targetReasoningEffort` is that role's target. Use one subagent per entry for panel roles. The judge pool remains a selection pool.
- `catalog --input ABS [--claude-runtime ABS]` normalizes native Codex `model/list` results or combined confirmed model capabilities. Collect every native catalog page first. The optional runtime file is the Claude runner's `detect` receipt. It records an absolute executable, CLI version at least `2.1.280`, required print/model/effort/output-format/verbose/resume options, global `effortSyntax`, and `modelExecutionVerified: false`. It does not enumerate account models. Normalized catalogs retain the runtime under `runtimes` and model sources. Normalizing them again produces the same result.
- `budget --budget large|medium|small --catalog ABS [--codex-home ABS]` previews the sparse saved config while preserving role model choices, lists, and aliases. It also returns `droppedRoles` and `replacedBudget`. `needsChoice` lists entries without a confirmed effort at or below their role's target, each with that `targetReasoningEffort`. This command never writes.
- `write --input ABS --catalog ABS --expected-hash HASH|absent [--codex-home ABS] [--dry-run]` validates then saves an accepted config or a resolved `budget` result. Use the hash from the read that informed the confirmed choices. A stale hash, malformed preference, unconfirmed model, effort above `xhigh`, or unsupported effort prevents writing. Dry run validates the full proposal without creating a destination. `droppedRoles` lists the retired keys the write omits, and `replacedBudget` reports a saved `unlimited` budget replacement.

The top-level `targetReasoningEffort` of `read` and `budget` is the effort the budget label names, which is the target of a role that starts at `xhigh`. Per-role targets appear in proposal slots, `resolve`, and `needsChoice` entries.

Budget and write accept the normalized combined catalog, or native `--catalog ABS` plus `--claude-runtime ABS`. Catalog validation keys each model by executor and ID. External entries require model-specific capability records and a compatible CLI that can express their efforts. A native model entry with the same ID does not validate them. The helper does not install or authenticate Claude or change its configuration.

## Model capability records

The existing combined `models` input accepts external records alongside native records. An external record includes its executor, exact ID, model-specific supported efforts, and source. This synthetic record illustrates the shape and does not describe a real model's availability:

```json
{
  "executor": "claude-code",
  "model": "claude-example-fixture-20300101",
  "supportedReasoningEfforts": ["low", "medium", "high"],
  "source": {
    "kind": "manual-confirmation",
    "description": "Fixture user confirmed this exact ID and these efforts in the current environment."
  }
}
```

`source.kind` is `host`, `configuration`, or `manual-confirmation`. Its nonblank description identifies the evidence for that exact model and its efforts. Keep a configured candidate distinct from confirmed support or account access. Reuse confirmation already given in the conversation rather than starting another confirmation workflow. Every effort must be expressible by the detected CLI. The helper rejects inconsistent capability metadata instead of silently changing it.

Runtime syntax alone never adds a model capability. Every external model needs a `host`, `configuration`, or `manual-confirmation` source that identifies the exact ID and its supported efforts. Arbitrary `models` fields in a runtime receipt do not authorize a route. Sources stay in the normalized catalog rather than saved preferences. Normalization preserves those records on repeated reads.

If a later catalog lacks a saved nondefault model, budget reports `needsChoice`, and write refuses the unresolved proposal. Read and resolve preserve that saved selection without modifying its bytes. A real execution can still reject a previously confirmed choice, and the calling workflow retains its existing fallback rules.

## Invocation precedence

The saved model entry is authoritative for the consuming role. `reasoningEffort` is that role's resolved default under the selected global budget. For an exact selection, a skill's explicit task-specific effort remains a deliberate override; validate it against the selected executor's supported efforts. Do not append an effort to a model ID. Follow the shared [execution binding](../../poteto-mode/references/execution.md) for the selected route. Claude entries use the shared runner with `--model ENTRY.MODEL`, the chosen separate `--effort`, task and role instructions, and absolute installed skill paths. Read and resolve work offline and preserve saved IDs without a current catalog; they do not confirm current access. They do not use Codex agent TOMLs or require another Claude plugin installation.

For native entries, both aliases select the literal parent model and effort and remain unchanged when the budget changes. Native `[agents]` defaults can replace omitted settings. For parent aliases, omit override fields only when true parent inheritance has been established. Otherwise bind the observed parent model and effort explicitly. If those values or that binding cannot be established, report the unresolved selection before dispatching. Follow the shared [execution binding](../../poteto-mode/references/execution.md) for native role selection, including its supported path for unconfigured generic seats before setup. Saved selections for generic delegates use the registered `pstack-general-purpose` role. The `poteto-agent` and `comment-sicko` custom roles require setup registration.

Native subagent tool names and argument names vary by Codex version. Bind the resolved values to the fields actually exposed in the current session; in the native spawn interface these are `model` and `reasoning_effort`. A full-history fork inherits the parent model; use a fresh-context task when the native tool requires it for explicit overrides and pass the needed evidence and absolute installed skill paths in that task.

Budget affects default reasoning. Keep the original different-model and different-family review rules in the consuming workflow when assessing results.

Unknown role keys other than the retired keys fail boundary validation without dropping or migrating them. Preferences remain unchanged.

## Antigravity routes

An Antigravity choice is `{ "executor": "antigravity", "model": "EXACT_AGY_ID", "reasoningEffort": "LEVEL" }`. It has no provider or authentication fields. Parent aliases remain native-only. Existing scalar and list shapes, sparse saves, order, duplicates, and native fallback remain. Read and resolve work offline without agy or a current catalog. Antigravity entries create no native model definitions or `agentType`.

`models.mjs catalog --agy-catalog ABS` merges the runner's sanitized `catalog.json` with selected native or Claude inputs. Antigravity-only normalization omits other inputs. The separate flag rejects rows from another executor. Each normalized capability retains `executor`, exact `model`, `supportedReasoningEfforts`, a labeled per-model `source`, and optional `runtimeVersion`. Re-normalization preserves these fields. Sources remain in catalogs rather than saved preferences.

The effort domain is separate from native efforts. Supported efforts come from each exact model's evidence, not a global CLI matrix. A host label such as `(XHigh)` supplies that one variant effort and identifies that limitation in its source. It proves configured availability only. Other candidates need a host, configuration, or manual-confirmation source for their exact ID and supported efforts.

Budget mapping keeps the exact model and chooses the highest supported effort at or below the target. A fixed `xhigh` variant returns `needsChoice` for a lower target rather than changing its ID. Invalid routes, efforts above `xhigh` on write, unsupported efforts, missing provenance, native aliases on Antigravity, and provider fields prevent saving. Follow [Antigravity execution](../../poteto-mode/references/agy-execution.md) for inherited authentication, scoped permissions, cumulative usage, native history, and one-use exact continuation.
