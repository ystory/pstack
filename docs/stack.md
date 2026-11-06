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

Replace `NNNN` with the next unused four-digit number in the selected target's series. Codex uses `patches/series`; Claude uses `patches/claude/series`. Omitting `--target` retains the Codex command behavior. `--paths` accepts comma-separated files or directories relative to the selected target tree; omitting it includes all unrecorded changes. Existing patches are not overwritten. Replay applies the ordered series to a temporary copy of the combined upstream baseline and must reproduce every plugin byte, file type, and permission.

Before publishing changes to `plugin-claude/`, increment the version in `plugin-claude/.claude-plugin/plugin.json`. Claude's native updater can retain cached plugin bytes when only the Git revision changes. Record the version bump in a new Claude patch. The Codex manifest and maintainer package have independent versions.

## Record a shared adaptation

How, its explainer template, and No comments have common workflow bodies. Their source changes live once under `patches/shared/`; both target series reference the same `shared/NNNN-name.patch` at the intended point. Each target's `skills/poteto-mode/references/execution.md` supplies native calls, registration, paths, and worker transports. Personal preferences remain independent.

Edit a common file in one target, then record that edit once:

```sh
node dist/cli.js generate-shared-patch --from codex --name NNNN-next-shared-adaptation.patch --paths skills/how/SKILL.md
node dist/cli.js verify-patches --target all
```

`--from`, `--name`, and `--paths` are required. `--from claude-code` reads the Claude output instead. This selects the edited input, not a preferred host or model. The command verifies one patch against both replayed inputs, materializes the other output, and appends both series references. Unrelated working changes remain. A conflicting unrecorded edit in the selected other files is reported before the patch is recorded.

Commit the shared patch, both series references, and both materialized outputs. Keep native changes in target patches. Initial transfer uses target-specific deletion patches followed by one shared addition, so different old host bodies do not have to match. Those full-file deletion inputs also expose upstream changes during candidate replay. Do not replace the locked original or add a third whole skill tree.

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

5. Resolve adaptation conflicts inside the candidate. Preserve the original failure reports and receipts. Refresh patches only in this reviewed candidate, keeping each target's order, logical ownership, and unaffected bytes. Regeneration handles both complete target series and retains the independent runtime pin. If you use the regeneration helper, choose a new output directory:

   ```sh
   node dist/cli.js regenerate-patches --candidate "$PWD/.local/candidates/update" --output "$PWD/.local/regenerated-patches"
   ```

   Read `regeneration-report.json` and every changed patch before copying the generated series into the candidate's `patches/`. For local-only candidates, the helper groups changes by existing patch paths. Shared candidates preserve per-patch intermediate file states and regenerate each shared node once for both targets. Edited shared bodies stay in shared patches. An original patch that still produces its intended node output retains its exact bytes. If a suffix cannot be reversed, an actually replayable original prefix can establish its prior state. If neither establishes the state, the helper reports the exact node and paths instead of inferring intent. Resolve that patch in the reviewed candidate before rerunning. Unowned changes can become an explicit target remainder. Shared paths do not justify moving a later adaptation into an earlier patch.

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
