# Claude setup helper contract

The helpers are standalone Node.js scripts. They need no package installation or build. Resolve their paths from the installed setup skill. Paths supplied as arguments are absolute. `--claude-home ABS` selects the configuration home for settings inspection, preferences, and agent registration. Otherwise the configuration home is `CLAUDE_CONFIG_DIR`, or `~/.claude` when unset.

## Saved choices

Preferences are in `pstack-cc/models.json` under the Claude home.

```json
{
  "schemaVersion": 1,
  "host": "claude-code",
  "budget": "large",
  "roles": {
    "bug-fix": {
      "executor": "codex",
      "model": "EXACT_CODEX_ID",
      "reasoningEffort": "xhigh"
    },
    "judgment and prose": {
      "executor": "claude-code",
      "model": "EXACT_CLAUDE_ID",
      "reasoningEffort": "high"
    },
    "hillclimb": "inherit-parent",
    "arena runners": [
      "auto",
      {
        "executor": "codex",
        "model": "EXACT_CODEX_ID",
        "reasoningEffort": "high"
      },
      "auto"
    ]
  }
}
```

This excerpt shows the shapes. A first save supplies all 17 roles. Later partial proposals retain saved choices for omitted roles. An omitted executor in an object normalizes to native `claude-code`. Explicit persisted model entries retain their executor and effort. Aliases can be strings or native entries with `model` and no effort.

The scalar keys are `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, and `swarm workers`.

The list keys are `arena runners`, `arena cross-judge pool`, `architect runners`, and `interrogate reviewers`. Lists retain order and duplicates. The cross-judge list is a pool. The other lists describe fan-out counts.

## Catalogs

`models.mjs catalog --input ABS --native-catalog ABS` accepts raw Codex `model/list` data, a normalized combined catalog, or the output of `detect.mjs catalog`. It rejects an uncollected next page. The runtime collects pages before normalization.

A native catalog has this shape. The values below are placeholders, not model recommendations.

```json
{
  "source": {
    "kind": "manual-confirmation",
    "description": "The user confirmed this exact model and these supported efforts."
  },
  "models": [
    {
      "model": "EXACT_CLAUDE_ID",
      "supportedReasoningEfforts": ["low", "medium", "high"]
    }
  ]
}
```

Source kinds are `host`, `configuration`, and `manual-confirmation`. Each source needs a description. A configuration source records confirmed exact model and capability metadata. An unverified configured candidate is not a catalog entry. Native moving aliases are rejected. Supported efforts stay separate from model IDs.

Normalized entries have `executor`, `model`, and `supportedReasoningEfforts`. Native entries also carry their source. Executor identity participates in validation, so identical strings from two executors remain separate choices.

## Commands

- `models.mjs read` returns `file`, `exists`, `sha256`, valid saved `config`, full `proposal`, `droppedRoles`, and `needsChoice`. The proposal's unresolved upstream Grok suggestions use `upstreamModel` and `upstreamSpeed`. They cannot be persisted as selected entries.
- `models.mjs resolve --role ROLE [--kind KIND] [--defaults]` returns an `entries` array for dispatch, plus the original `cardinality`, source, budget, and an empty `needsChoice`. Scalars still yield one dispatch entry. `--defaults` returns the native execution fallbacks even when that role has a saved choice. Missing roles use the same fallbacks. Grok maps to `model: "inherit-parent"`; Opus maps to `model: "opus"` with `modelKind: "native-alias"` and the budget effort. Both carry `upstreamModel` for disclosure and select static plugin definitions. These mappings require no setup, generated variants, or Codex CLI. Saved exact entries remain exact.
- `models.mjs budget --budget LABEL --catalog ABS` returns a preview `config` and `needsChoice`. It never writes. A role with no supported effort at or below the target requires a choice.
- `models.mjs write --input ABS --catalog ABS --expected-hash HASH_OR_ABSENT [--dry-run]` validates all choices and saves atomically. The input is a config, or a result object containing `config`. Unresolved `needsChoice` results are rejected. A dry run creates no destination.
- `register-agents.mjs [--input ABS] [--dry-run] [--unregister]` manages owned native definitions. With no input, it uses saved preferences. Removal retains preferences.
- `detect.mjs detect` reports Node, Claude, Codex, capability and auth evidence, configured native candidates, and applicable install or login guidance.
- `detect.mjs catalog --cwd ABS` also asks the bundled Codex runner to collect every model page. `--claude-executable ABS` and `--codex-executable ABS` select existing CLI executables for either detection command.

Detection reports the configuration target in `configuration.claudeHome`. Claude version, help, and authentication checks use the unchanged inherited CLI environment. `claude.cli.environment.source` is `inherited`. Its `claudeConfigDir` contains the inherited `CLAUDE_CONFIG_DIR` value, or `null` when the CLI uses its default lookup. `--claude-home` does not relocate credentials or select another authentication profile. A profile selected through the inherited environment keeps its own login state. Detection copies no credentials and writes no setup files.

`KIND` is `general-purpose`, `poteto-agent`, `comment-sicko`, or `read-only`. An explicit Claude selection resolves to `pstack-cc-KIND-HASH`, where `HASH` is the first 16 hexadecimal characters of the exact model ID's SHA-256. Definitions are in `agents/pstack-cc/` under the Claude home. Parent aliases and unsaved native defaults resolve to `pstack-cc:KIND`. The readonly kind disallows `Write`, `Edit`, and `NotebookEdit` and retains the general-purpose body. Codex entries do not receive a native agent type.

## Registration ownership

`pstack-cc/agent-registration.json` records owned paths, hashes, permissions, original kind, exact model, and plugin version. A pending `.agent-registration.pending.json` records the before and after state for an interrupted transaction. Recovery accepts only those states and refuses independent edits. A live registration lock prevents concurrent registrars. A later invocation removes a dead process's lock and completes pending work.

Registration adds or refreshes the proposed variants and retains every other owned variant unchanged. Its `agents` receipt lists the proposal's variants, and `retained` lists earlier owned files. An interrupted setup or a stale preference hash cannot remove definitions needed by saved choices or another staged proposal. Unused variants accumulate until explicit unregister.

The registrar changes neither Claude settings nor plugin cache files. Unregister checks every owned definition before removing any. A native host must load the resulting definitions before they can be invoked. Registration alone is not live compatibility evidence.
