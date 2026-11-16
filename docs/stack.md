# Development and maintenance

The [design document](spec.md) describes source integrity, adaptations, and compatibility boundaries. The [README](../README.md) covers plugin installation and use.

## Development checks

Maintainers need Node.js 24.12+, Corepack with the pnpm version pinned in [package.json](../package.json), and Git. Setup checks also require Python 3.11 or later for the standard-library TOML parser. Consumers installing the committed plugin from GitHub do not need Corepack, pnpm, or a build.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` checks formatting, TypeScript, tests, the JavaScript build, independent packaging, source integrity, and patch replay. After dependencies are installed, these checks run offline. The package test preserves nested `.gitignore` files in a tar archive and exercises the built CLI and setup in temporary consumer directories without changing the active user profile. Live Codex/Claude runs and native plugin installation are separate checks.

Use affected checks while iterating. Documentation-only changes need formatting and link checks; distribution changes need source, patch, and artifact verification. Run the full `verify` pipeline before preparing a release artifact. Read [package.json](../package.json) for individual check scripts and run `node dist/cli.js --help` for maintainer CLI options.

The code is a single ESM TypeScript package with no Node runtime dependencies. `src/cli.ts` handles commands, `src/upstream/` handles source contracts and candidates, and `src/distribution/` handles policy, patches, artifacts, and marketplace selection. TypeScript emits the distributable JavaScript; `node:test` and Prettier provide tests and formatting. The formatting configuration excludes imported snapshots and target trees. Each product's series orders its host adaptations and explicit references to shared patches.

Generated patches and candidate source diffs stay as bytes, including text that is not UTF-8. Finite Git input uses a temporary read-only file descriptor. This avoids the synchronous pipe EOF stall reproduced on Node.js 24.22.2 on macOS. A [Node.js issue](https://github.com/nodejs/node/issues/67280) reports a matching EOF failure. The internal runtime cause and a fixed Node.js release remain unconfirmed. The 30-second Git limit stays unchanged, and the runner does not retry. The command closes and removes its temporary input after each invocation. Normally completed Git application failures produce the legacy `patch-conflict` candidate report, including malformed patches. Process launch failures, timeouts, and signal termination fail the command. During series replay, both paths retain the patch name and original error cause. Direct regeneration calls can report the raw Git or filesystem error instead. Distribution-policy conflicts keep their existing report.

## Record an adaptation

Implement Codex changes in `plugin/` and Claude changes in `plugin-claude/`, preserving all locked source snapshots. Describe the upstream behavior and the intended difference for review. Record the change in a new patch:

```sh
node dist/cli.js generate-patch --name NNNN-next-adaptation.patch --paths skills/SKILL_SLUG
node dist/cli.js verify-patches
```

For the Claude target, select it explicitly:

```sh
node dist/cli.js generate-patch --target claude-code --name NNNN-next-adaptation.patch --paths skills/SKILL_SLUG
node dist/cli.js verify-patches --target all
```

Replace `NNNN` with the next unused four-digit number in the selected target's series. The new patch may change a path that an earlier patch owns; [a compaction](#compact-the-patch-series) later folds it into that path's themed patch. Codex uses `patches/series`; Claude uses `patches/claude/series`. Omitting `--target` retains the Codex command behavior. `--paths` accepts comma-separated files or directories relative to the selected target tree; omitting it includes all unrecorded changes. Existing patches are not overwritten. Replay applies the ordered series to a temporary copy of the combined upstream baseline and must reproduce every plugin byte, file type, and permission.

Before publishing changes to `plugin-claude/`, increment the version in `plugin-claude/.claude-plugin/plugin.json`. Claude's native updater can retain cached plugin bytes when only the Git revision changes. Record the version bump in a new Claude patch. The Codex manifest and maintainer package have independent versions.

## Record a shared adaptation

How and No comments have common workflow bodies. Their source changes live once under `patches/shared/`; both target series reference the same `shared/NNNN-name.patch` at the intended point. Each target's `skills/poteto-mode/references/execution.md` supplies native calls, registration, paths, and worker transports. Personal preferences remain independent.

Edit a common file in one target, then record that edit once:

```sh
node dist/cli.js generate-shared-patch --from codex --name NNNN-next-shared-adaptation.patch --paths skills/how/SKILL.md
node dist/cli.js verify-patches --target all
```

`--from`, `--name`, and `--paths` are required. `--from claude-code` reads the Claude output instead. This selects the edited input, not a preferred host or model. The command verifies one patch against both replayed inputs, materializes the other output, and appends both series references. Unrelated working changes remain. A conflicting unrecorded edit in the selected other files is reported before the patch is recorded.

Commit the shared patch, both series references, and both materialized outputs. Keep native changes in target patches. Initial transfer uses target-specific deletion patches followed by one shared addition, so different old host bodies do not have to match. Those full-file deletion inputs also expose upstream changes during candidate replay. Do not replace the locked original or add a third whole skill tree.

## Compact the patch series

Recorded adaptations append to a series, so over time many patches change the same file. An upstream update then has to move every one of them onto the new source. A compaction rewrites both series so that each changed path belongs to exactly one patch in each target. An upstream change to a file can then conflict with one patch only.

Run a compaction as its own change, separate from any adaptation or upstream update. It changes no byte under `plugin/`, `plugin-claude/`, or `upstream/`. It discards the per-patch history of the series, so name the commit that holds the previous series in the change description.

1. Build the CLI and record the two tree digests that `node dist/cli.js verify-patches --target all` prints.

2. Write the compacted series to a new directory in ignored storage:

   ```sh
   node dist/cli.js compact-patches --output "$PWD/.local/compacted-patches"
   ```

   The command first replays the current series and stops if it does not reproduce a target tree. It then diffs each target tree against its pristine baseline and gives every changed path to the first matching theme in `pstackThemes` in [compact.ts](../src/distribution/compact.ts). A path that a shared patch changes today goes to a shared theme instead. Its pristine and final bytes and mode must be the same in both targets. A theme keeps its number in both series, and a theme with no path in a target is left out of that series. Each series lists its target themes first and the shared patches last. The command replays the new series and writes output only when each target reaches its previous tree digest.

   | Theme                                | Paths                                                                                 |
   | ------------------------------------ | ------------------------------------------------------------------------------------- |
   | `identity-and-distribution`          | manifests, `README.md`, `PRIVACY.md`, `TERMS.md`, licenses, assets                    |
   | `agents-and-invocation`              | `agents/` and each skill's `agents/` metadata                                         |
   | `setup-and-models`                   | the rest of `skills/setup-pstack/`                                                    |
   | `poteto-mode-references-and-scripts` | `skills/poteto-mode/references/` and `skills/poteto-mode/scripts/`                    |
   | `poteto-mode-playbooks`              | the rest of `skills/poteto-mode/`                                                     |
   | `workflow-skills`                    | every other skill                                                                     |
   | `guides`                             | `docs/`                                                                               |
   | `vendored-codex-runtime`             | `vendor/`, which only the Claude target has                                           |
   | `shared/workflow-bodies`             | the common How and No comments bodies                                                 |
   | `shared/worker-execution`            | common files under `skills/poteto-mode/references/` and `skills/poteto-mode/scripts/` |

   A changed path that no theme matches stops the command. Add or widen a theme in the same change. A shared path that differs between targets also stops it. Restore the common body with a recorded adaptation before compacting.

3. Read `compaction-report.json`, which lists every patch with its paths. Replace `patches/` with the output's `patches/` directory. Run `node dist/cli.js verify-patches --target all` and require the digests from step 1. Confirm that `git status` shows no change under `plugin/`, `plugin-claude/`, or `upstream/`.

4. Run `corepack pnpm verify`. No plugin version changes, because no plugin byte changes.

Patch numbers restart at `0001` in a compaction. A branch that added a patch to the previous series must record its adaptation again on the compacted series.

Between compactions, `generate-patch` and `generate-shared-patch` append as before. A new patch may change a path that a themed patch already owns. The one-path-one-patch property holds again after the next compaction.

## Build and select an artifact

Build the maintainer CLI before using the artifact commands:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Choose a new output directory for each artifact. A build verifies its inputs and puts the selected tree under `plugin/`. Codex builds produce `.agents/plugins/marketplace.json` and schema-1 `artifact.json`. Claude builds produce `.claude-plugin/marketplace.json` and schema-2 `artifact.json` with the runtime lock.

```sh
mkdir -p .local/artifacts
node dist/cli.js build-plugin --output "$PWD/.local/artifacts/example"
node dist/cli.js verify-plugin --artifact "$PWD/.local/artifacts/example"
```

Build the separate Claude product with an explicit target:

```sh
node dist/cli.js build-plugin --target claude-code --output "$PWD/.local/claude-artifacts/example"
node dist/cli.js verify-plugin --artifact "$PWD/.local/claude-artifacts/example"
```

`verify-plugin` and `promote-plugin` infer the target from validated artifact metadata. Keep a separate fixed marketplace root for each product. Claude's local marketplace and plugin identity are `pstack-cc`; the repository marketplace points at `plugin-claude/`, while a generated marketplace points at its inner `plugin/` directory.

`--marketplace` selects the verified child artifact through a fixed physical marketplace directory. The selection changes atomically after successful verification; failures preserve the previous selection and existing artifacts. Omitting `--marketplace` creates an artifact without changing the selection. Artifacts and marketplace paths must use real directories rather than symlinks; an existing artifact cannot itself become the mutable marketplace root.

Select or restore an existing child artifact with:

```sh
node dist/cli.js promote-plugin --artifact "$PWD/.local/artifacts/ARTIFACT_NAME" --marketplace "$PWD/.local/artifacts"
```

Replace `ARTIFACT_NAME` with an existing directory name. Promotion verifies the artifact before changing the marketplace. Building, verifying, or selecting an artifact does not install it, update an installed cache, activate instructions, or establish runtime compatibility.

To install a selected local artifact, add the fixed local marketplace and install its plugin:

```sh
codex plugin marketplace add "$PWD/.local/artifacts"
codex plugin add pstack-codex@pstack-codex
```

After building or promoting another artifact, repeat `codex plugin add pstack-codex@pstack-codex`, then rerun setup. For a selected local Claude artifact, use `/plugin marketplace add /absolute/claude-marketplace` and `/plugin install pstack-cc@pstack-cc` in Claude Code, then rerun `/pstack-cc:setup-pstack`. For the GitHub installation routes and setup, see the [README](../README.md). Both routes use the same marketplace identity; use the route you intend to maintain.

## Review an upstream update

Keep candidates, artifacts, and verification receipts in ignored `.local/` storage. Follow these steps for each update.

1. Inspect `git status`, all source locks, [distribution-policy.json](../distribution-policy.json), both [Codex](../patches/series) and [Claude](../patches/claude/series) patch series, and [the design document](spec.md). Preserve unrelated worktree changes throughout the update. Use the checked-out repository to establish current state.

2. Build the current maintainer CLI as described in [Build and select an artifact](#build-and-select-an-artifact). Resolve the intended target in a real `cursor/plugins` Git checkout with the expected origin. `check-upstream` reports public GitHub revisions but does not fetch that checkout. Resolve the full target commit and inspect the last commits for both source paths:

   ```sh
   node dist/cli.js check-upstream
   git -C /absolute/path/to/cursor-plugins rev-parse 'TARGET_REF^{commit}'
   git -C /absolute/path/to/cursor-plugins log -1 --format=%H FULL_COMMIT_SHA -- pstack
   git -C /absolute/path/to/cursor-plugins log -1 --format=%H FULL_COMMIT_SHA -- cursor-team-kit
   ```

   Replace `TARGET_REF` with the intended ref and `FULL_COMMIT_SHA` with its resolved 40-character SHA. The lock's `revision` identifies the selected source commit. Each `pathRevision` identifies the last commit affecting its source path.

3. Create a candidate in a new output directory:

   ```sh
   node dist/cli.js upstream-candidate --source /absolute/path/to/cursor-plugins --revision FULL_COMMIT_SHA --output "$PWD/.local/candidates/update"
   ```

   The command exports both source snapshots and locks, applies the current adaptations, and records source diffs, patch failures, unapplied patches, and policy conflicts. Current pins and marketplace selection stay unchanged. A complete Claude target also exports its target tree, adaptation series, and unchanged pinned runtime into the candidate. Incomplete Claude inputs fail explicitly. Confirm the candidate locks match the selected commit and path revisions. A candidate starts with an empty Codex tested-version list.

4. Read `candidate-report.json`, both complete source diffs, and the candidate's actual `plugin/` and `plugin-claude/` trees. Separate upstream changes, mechanical refreshes of existing host mappings, and proposed new behavior-changing deviations. Apply the approval policy in [AGENTS.md](../AGENTS.md) before introducing a new deviation. Preserve source skill bodies except where approved host mappings require changes.

   Review the full skill inventory and descriptions for both targets. Check the Claude delegation-site inventory against every role and platform mapping. Check every new skill's frontmatter and Codex invocation metadata, links, namespaces, and mapped paths. Confirm that model routing, executors, agents, distribution-policy exclusions, and attribution still match the documented adaptations.

5. Resolve adaptation conflicts inside the candidate. Preserve the original failure reports and receipts. Refresh patches only in this reviewed candidate, keeping each target's order, logical ownership, and unaffected bytes. Both helpers below handle both complete target series, retain the independent runtime pin, write only to a new output directory, and leave current pins and series unchanged.

   When upstream changed lines that existing patches also touch, rebase the pinned series onto the candidate source:

   ```sh
   node dist/cli.js rebase-patches --candidate "$PWD/.local/candidates/update" --output "$PWD/.local/rebased-patches"
   ```

   The command reads the original series and old source from the repository, or from `--project`, and the new source and both reviewed target trees from the candidate. The candidate's own `patches/` are not read. Each existing patch keeps only its own historical change, moved onto the new source. A line only upstream changed takes upstream's version. A line both changed keeps the patch's text. A line upstream deleted stays deleted, and a hunk whose file upstream deleted or rewrote is dropped. Where upstream replaced lines with a different number of lines, a line counts as edited only if a replacement line shares enough of its words. Otherwise it counts as deleted, and the patch's edit of it is dropped. A file a patch deleted or rewrote is adaptation-owned from that patch on and keeps its historical bytes, so its deletion or rewrite patch shows the new upstream text as removed lines. A patch whose result is unchanged keeps its exact bytes, and a patch with no remaining change leaves the series. A shared patch must come out identical for both targets.

   Everything else in the reviewed trees lands in new patches appended to each series: one `shared/NNNN-NAME.patch` for paths that shared patches own, then one `NNNN-NAME.patch` per target. `NAME` defaults to `upstream-VERSION-refresh` and `--name` replaces it. Shared paths must match in both candidate trees. The command never moves an update's change into an existing patch.

   Read `rebase-report.json`, every regenerated patch, and the refresh patches before copying the generated `patches/` into the candidate. The report lists each patch as kept, regenerated, or dropped, with conflict and upstream-rewrite counts. Conflicts are resolved line by line without judging meaning. The command exits with an error status when a regenerated patch adds a line that neither its original nor the new source contains, and the report lists those lines as `unexplainedAdditions`. A rewritten file's own lines are not counted.

   When the candidate's patches still reverse cleanly, the regeneration helper can instead group the candidate's changes into its existing patches:

   ```sh
   node dist/cli.js regenerate-patches --candidate "$PWD/.local/candidates/update" --output "$PWD/.local/regenerated-patches"
   ```

   Read `regeneration-report.json` and every changed patch before copying the generated series into the candidate's `patches/`. For local-only candidates, the helper groups changes by existing patch paths. Shared candidates preserve per-patch intermediate file states and regenerate each shared node once for both targets. Edited shared bodies stay in shared patches. An original patch that still produces its intended node output retains its exact bytes. If a suffix cannot be reversed, an actually replayable original prefix can establish its prior state. A reconstruction error names the node and paths when neither establishes the state; use `rebase-patches` in that case. Git or filesystem errors can abort earlier with their raw diagnostic. Upstream path-type conflicts can require editing the failed candidate patches as well as the output trees before rerunning. Unowned changes can become an explicit target remainder. Shared paths do not justify moving a later adaptation into an earlier patch.

6. Verify the candidate's source policy and integrity, then verify patch replay and a fresh artifact:

   ```sh
   node dist/cli.js verify-patches --target all --project "$PWD/.local/candidates/update"
   node dist/cli.js build-plugin --project "$PWD/.local/candidates/update" --output "$PWD/.local/artifacts/update-candidate"
   node dist/cli.js verify-plugin --artifact "$PWD/.local/artifacts/update-candidate"
   node dist/cli.js build-plugin --target claude-code --project "$PWD/.local/candidates/update" --output "$PWD/.local/claude-artifacts/update-candidate"
   node dist/cli.js verify-plugin --artifact "$PWD/.local/claude-artifacts/update-candidate"
   ```

   Require equality of actual bytes, file types, and permissions. An applied-patch count alone proves neither equality nor preservation of workflow meaning. Run applicable isolated or live workflow checks and record their scope separately.

7. Integrate the reviewed snapshots, locks, both target trees, and their separate patch series as one coherent change. Copy reviewed exports rather than editing locked snapshots by hand. Run `corepack pnpm verify` after integration, then build and verify a fresh artifact from the repository. Omit `--marketplace` when verifying an artifact. For later changes confined to maintainer documentation, use the formatting and link checks described in [Development checks](#development-checks).

8. Report the source version and target SHA, semantic differences, patch changes, and automated checks. State which live workflows ran or remain untested. Report artifact verification, marketplace selection, installation, and activation separately. Preserve the configured Git identity and signing settings when committing. Promote or install only within the authorized scope. Existing authorization covers its routine steps without another approval.

## Maintain the pinned Codex runtime

`codex-runtime.lock.json` records the official repository revision, version, selected source-to-target mappings, and snapshot digest. Its source snapshot preserves repo-relative paths under `upstream/codex-runtime/`. The Claude baseline maps those files into `vendor/codex-plugin-cc/` before replaying its adaptations. Preserve upstream licenses and notices.

`check-upstream` reports the runtime repository's current revision separately from the pstack source. `verify-upstream` checks every pinned snapshot. The pstack candidate workflow carries the current runtime pin unchanged; it does not silently update the runtime. To refresh it, export reviewed files from the selected official revision, update the lock and mapped target together, inspect the source and adaptation diff, then verify both series and artifacts. No runtime-sync command is provided. Record source evidence, fixture lifecycle checks, and bounded live execution separately.

## Check the official agy runner

Run the reusable direct check only with an already-authorized exact model, effort, and inherited official CLI authentication. It submits one fresh task and one exact continuation. It performs no installation, login, settings change, or native host onboarding.

```sh
node scripts/check-agy-live.ts \
	--evidence-dir /absolute/new-local-evidence \
	--fresh-runner /absolute/codex-artifact/plugin/skills/poteto-mode/scripts/run-agy.mjs \
	--resume-runner /absolute/claude-artifact/plugin/skills/poteto-mode/scripts/run-agy.mjs \
	--model APPROVED_EXACT_AGY_ID --effort APPROVED_SUPPORTED_EFFORT \
	--inherited-auth APPROVED_INHERITED_METHOD
```

Both runner paths and the new evidence directory are required absolute paths. Use the final source copies or built artifact copies. No model or effort is a default. `--inherited-auth` acknowledges the already-authorized inherited method: `gemini-api-key` when agy's settings set `modelProvider` to `gemini`, `adc` for the existing `AGY_ADC_AUTH=true` environment, or `inherited-default` otherwise. The script derives the method the same way as the runner before invoking the CLI, stops when it differs, and never switches it. An optional `--executable ABS` selects the installed official CLI for this invocation. `--timeout-ms N` bounds each task and defaults to 120000.

The check creates an unpredictable marker behind a pointer file in a neutral temporary workspace. The fresh runner must read both files through native tool events and return the exact marker. The other runner copy continues the exact receipt and recalls the marker. The check requires matching requested and CLI-observed model, unknown effective effort, completed status, orderly zero-exit process closure, and conversation-cumulative usage labels. It verifies both personal pstack preference hashes before and after execution and returns retained evidence paths.

Read the evidence before reporting success. This proves the named direct official CLI path only. Native host asynchronous dispatch, first setup, active plugin installation, Desktop behavior, other models, and release approval remain separate. Cancellation is covered by subprocess fixtures rather than an additional paid task.
