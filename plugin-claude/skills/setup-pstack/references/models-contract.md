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

This excerpt shows the shapes. Sparse accepted saves are valid. Partial proposals retain saved choices for omitted roles. Missing roles stay unconfigured and resolve to the actual native parent. An omitted executor in an object normalizes to native `claude-code`. Explicit persisted model entries retain their executor and effort. Aliases can be strings or native entries with `model` and no effort.

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

- `models.mjs read` returns `file`, `exists`, `sha256`, valid saved `config`, full `proposal`, and `needsChoice`. Missing proposal slots contain only their target `reasoningEffort`, without a model or executor. Scalars start with one slot and panels or pools with two. These unresolved objects cannot be saved as selected entries.
- `models.mjs resolve --role ROLE [--kind KIND]` returns an `entries` array, original `cardinality`, source, budget, and empty `needsChoice`. Scalars yield one entry. Missing roles yield one or two native `inherit-parent` entries at their original count, with source `unconfigured` and static inherited definitions. Saved exact entries remain exact.
- `models.mjs budget --budget LABEL --catalog ABS` returns a preview `config` and `needsChoice`. It never writes. A role with no supported effort at or below the target requires a choice.
- `models.mjs write --input ABS --catalog ABS --expected-hash HASH_OR_ABSENT [--dry-run]` validates all choices and saves atomically. The input is a config, or a result object containing `config`. Unresolved `needsChoice` results are rejected. A dry run creates no destination.
- `register-agents.mjs [--input ABS] [--dry-run] [--unregister]` manages owned native definitions. With no input, it uses saved preferences. Removal retains preferences.
- `detect.mjs detect --executors claude-code` reports native CLI, safe auth evidence, model candidates and guidance. `--executors claude-code,codex` also probes the standalone Codex server. Unselected Codex is never invoked or required.
- `detect.mjs catalog --executors claude-code,codex --cwd ABS` also asks the bundled Codex runner to collect every model page. `--claude-executable ABS` selects the Claude CLI. `--codex-executable ABS` selects the standalone server for either detection command.

Detection retains `schemaVersion: 1` and the legacy `codex.cli` container. Its `kind` is `standalone-app-server`; `executable`, `args`, and `version` identify the selected launch. The default executable is `codex-app-server` on inherited PATH. The argument array is `['--session-source', 'app-server']` for probes and actual connections. Version and source-help probes are bounded. `available` requires successful probes and help that advertises `--session-source`. This capability check does not prove actual source semantics or Desktop visibility. Missing or unsupported servers produce official release guidance, with no fallback to `codex app-server`.

The same server handles safe `account/read` and all `model/list` pages. Auth and persistent history use the inherited `CODEX_HOME`, without credential-file reads or a separate profile. Run requests record the executable and arguments. Results add the probe version, and spawn diagnostics identify the executable and arguments actually launched. Successful detection or catalog access leaves `execution.verified` false.

Detection reports the configuration target in `configuration.claudeHome`. Claude version, help, and authentication checks use the unchanged inherited CLI environment. `claude.cli.environment.source` is `inherited`. Its `claudeConfigDir` contains the inherited `CLAUDE_CONFIG_DIR` value, or `null` when the CLI uses its default lookup. `--claude-home` does not relocate credentials or select another authentication profile. A profile selected through the inherited environment keeps its own login state. Detection copies no credentials and writes no setup files.

`KIND` is `general-purpose`, `poteto-agent`, `comment-sicko`, or `read-only`. An explicit Claude selection resolves to `pstack-cc-KIND-HASH`, where `HASH` is the first 16 hexadecimal characters of the exact model ID's SHA-256. Definitions are in `agents/pstack-cc/` under the Claude home. Parent aliases and unconfigured roles resolve to `pstack-cc:KIND`. The readonly kind disallows `Write`, `Edit`, and `NotebookEdit` and retains the general-purpose body. Codex entries do not receive a native agent type.

## Registration ownership

`pstack-cc/agent-registration.json` records owned paths, hashes, permissions, original kind, exact model, and plugin version. A pending `.agent-registration.pending.json` records the before and after state for an interrupted transaction. Recovery accepts only those states and refuses independent edits. A live registration lock prevents concurrent registrars. A later invocation removes a dead process's lock and completes pending work.

Registration adds or refreshes the proposed variants and retains every other owned variant unchanged. Its `agents` receipt lists the proposal's variants, and `retained` lists earlier owned files. An interrupted setup or a stale preference hash cannot remove definitions needed by saved choices or another staged proposal. Unused variants accumulate until explicit unregister.

The registrar changes neither Claude settings nor plugin cache files. Unregister checks every owned definition before removing any. A native host must load the resulting definitions before they can be invoked. Registration alone is not live compatibility evidence.

Unknown role keys fail boundary validation without dropping or migrating them. Preferences remain unchanged.
