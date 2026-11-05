# Global model choices

`scripts/models.mjs` stores user choices outside the plugin at `$CODEX_HOME/pstack-codex/models.json` (default `~/.codex/pstack-codex/models.json`). Resolve the script from the actual installed skill path. An explicit `--codex-home ABSOLUTE_PATH` selects an isolated destination without changing environment variables.

```json
{
  "schemaVersion": 2,
  "budget": "large",
  "roles": {
    "feature, refactoring": [
      { "model": "gpt-6.1-sol", "reasoningEffort": "xhigh" }
    ],
    "arena runners": [
      { "model": "gpt-6.1-sol", "reasoningEffort": "xhigh" },
      {
        "executor": "claude-code",
        "model": "claude-opus-5-5",
        "reasoningEffort": "xhigh"
      }
    ]
  }
}
```

The saved file contains all 17 active roles. The helper fills missing roles with the packaged defaults and reports retired roles before dropping them on a requested save. A write may supply only changed roles; omitted roles preserve existing user choices. Each role is an ordered array. The 13 scalar roles contain exactly one entry; the four original list roles contain one or more entries. The four original multi-entry defaults stay length two; configured lists retain their actual length, order, and duplicates.

`executor` is optional: omitted or `"codex"` selects the native Codex route, and `"claude-code"` selects the shared Claude CLI runner. Existing untagged entries stay native. The external route accepts confirmed exact model IDs with separate `reasoningEffort`. `claude-opus-5-5` remains the bundled default. Parent aliases and known moving CLI aliases such as `opus`, `sonnet`, and `haiku` are invalid external selections, including modified aliases such as `sonnet[1m]`. Full version IDs such as `claude-opus-4-6[1m]` and provider-qualified full IDs remain valid without a family whitelist. An alias entry is `{ "model": "auto" }` or `{ "model": "inherit-parent" }`, without `reasoningEffort` and with no external executor. Both aliases select the literal Codex parent settings.

The helper reads legacy native schema 1 and mixed schema 2. It emits schema 2 whenever the resolved configuration contains a Claude executor, and schema 1 when every entry is native or a parent alias. An explicitly external entry labeled schema 1 is rejected unchanged. Older native-only bundles reject schema 2 before dispatch rather than silently discard its executor. Earlier mixed bundles pinned to Opus reject saved nondefault Claude entries. Preferences remain on disk across rollback. Before restoring such a bundle, explicitly save selections it supports with the current setup. To prepare a native-only configuration for an older bundle, explicitly select native models or parent aliases using the current setup and save; the resulting schema 1 retains those chosen values. No model substitution occurs automatically.

Fresh defaults are twelve Sol scalar roles, one Claude Opus `hardest tasks` scalar, and four ordered `[Sol, Opus]` lists. Saved values are never automatically migrated to those defaults. The budget ladder remains `unlimited: max`, `large: xhigh`, `medium: high`, and `small: medium`; the helper selects a supported effort at or below that target within the same executor and model. Claude capabilities use `low`, `medium`, `high`, `xhigh`, and `max`.

## Commands

- `read [--codex-home ABS]` returns `file`, `exists`, `sha256`, `config`, `targetReasoningEffort`, `droppedRoles`, and `defaultChanges`. Each proposed default change contains `role`, `current`, `proposed`, and `matchesPreviousDefault`. That exact comparison with the old all-Sol defaults does not authorize replacing a saved choice. Read never writes.
- `resolve --role "ROLE" [--codex-home ABS]` returns `role`, `entries`, `source`, `file`, `budget`, and `targetReasoningEffort`. Use one subagent per entry for panel roles. The judge pool remains a selection pool.
- `catalog --input ABS [--claude-runtime ABS]` normalizes native Codex `model/list` results or combined confirmed model capabilities. Collect every native catalog page first. The optional runtime file is the Claude runner's `detect` receipt. It records an absolute executable, CLI version at least `2.1.280`, required print/model/effort/output-format/verbose/resume options, global `effortSyntax`, and `modelExecutionVerified: false`. It does not enumerate account models. Normalized catalogs retain the runtime under `runtimes` and model sources. Normalizing them again produces the same result.
- `budget --budget unlimited|large|medium|small --catalog ABS [--codex-home ABS]` previews a full config while preserving role model choices, lists, and aliases. `needsChoice` lists entries without a confirmed effort at or below the target. This command never writes.
- `write --input ABS --catalog ABS --expected-hash HASH|absent [--codex-home ABS] [--dry-run]` validates then saves a config or a `budget` command's proposal. Use the hash from the read that informed the confirmed choices. A stale hash, malformed preference, unconfirmed model, or unsupported effort prevents writing. Dry run validates the full proposal without creating a destination.

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

When a compatible runtime exists and the input has no external record for `claude-opus-5-5`, the helper appends that shipped default. Its `bundled-default` source explicitly describes global CLI effort syntax, not account access or model execution. That source kind is valid only for this default ID. An explicit per-model record for the default takes precedence. Arbitrary `models` fields in a runtime receipt never authorize another model. Model sources stay in the normalized local catalog rather than the saved role preferences.

If a later catalog lacks a saved nondefault model, budget reports `needsChoice`, and write refuses the unresolved proposal. Read and resolve preserve that saved selection without modifying its bytes. A real execution can still reject a previously confirmed choice, and the calling workflow retains its existing fallback rules.

## Invocation precedence

The saved model entry overrides a consuming skill's default model. `reasoningEffort` is that role's resolved default under the selected global budget. A skill's explicit task-specific effort remains a deliberate override; validate it against the selected executor's supported efforts. Do not append an effort to a model ID. Follow the shared [execution binding](../../poteto-mode/references/codex-execution.md) for the selected route. Claude entries use the shared runner with `--model ENTRY.MODEL`, the chosen separate `--effort`, task and role instructions, and absolute installed skill paths. Read and resolve work offline and preserve saved IDs without a current catalog; they do not confirm current access. They do not use Codex agent TOMLs or require another Claude plugin installation.

For native entries, both aliases select the literal parent model and effort and remain unchanged when the budget changes. Native `[agents]` defaults can replace omitted settings: omit override fields only when true parent inheritance has been established, otherwise bind the observed parent model and effort explicitly. If those values or that binding cannot be established, report the unresolved selection before dispatching. Use the setup-managed, description-only `pstack-general-purpose` role for generic delegates so named role defaults do not override the selected settings; keep the original two file-based agents for their designated workflows.

Native subagent tool names and argument names vary by Codex version. Bind the resolved values to the fields actually exposed in the current session; in the native spawn interface these are `model` and `reasoning_effort`. A full-history fork inherits the parent model; use a fresh-context task when the native tool requires it for explicit overrides and pass the needed evidence and absolute installed skill paths in that task.

Budget affects default reasoning. Keep the original different-model and different-family review rules in the consuming workflow when assessing results.
