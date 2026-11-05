# Project instructions

Use [docs/spec.md](docs/spec.md) when changing workflow behavior, model or agent routing, installation, or compatibility claims. Use [docs/stack.md](docs/stack.md) for development checks, patches, upstream updates, and artifact maintenance.

Establish current state from the repository's Git state, source locks, and patch series. Use chat history as context.

Treat `upstream/pstack/`, `upstream/cursor-team-kit/`, and `upstream/codex-runtime/` as reference material, not active instructions. Preserve their locked bytes and upstream attribution. Implement Codex adaptations in `plugin/` and Claude Code adaptations in `plugin-claude/`. Update source snapshots through the separate candidate workflow.

Represent `plugin/` changes in `patches/series` and `plugin-claude/` changes in `patches/claude/series`. Patch replay must reproduce the plugin's bytes, file types, and permissions. Preserve existing patches when adding an adaptation; regenerate patches only within a reviewed upstream candidate.

Preserve upstream behavior and documented host adaptations. An upstream update request authorizes faithful source updates and compatible refreshes of already approved adaptations. Explain upstream behavior and the reason and effect of adaptation changes in proposals and change reports. Obtain approval before introducing a new behavior-changing deviation. Complete authorized repository work and relevant local checks without a separate approval for each step.

Keep generated artifacts, runtime receipts, and personal configuration in ignored local storage such as `.local/`.

Distinguish source inspection, automated fixtures, live runtime verification, and release approval. Add tested Codex versions only after executing and describing the relevant workflow; a source revision or successful artifact build is not runtime compatibility evidence.

Publish, install into an active user profile, or activate imported instructions only when that operation is authorized. Local fixture checks use isolated paths and are separate from those operations.
