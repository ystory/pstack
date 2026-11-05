---
status: accepted
---

# Bundle the Codex worker runtime with the Claude Code distribution

Include the official Codex plugin's worker execution code in the Claude Code distribution, pinned to a reviewed source revision. Users use their existing Codex CLI and authentication. This project owns the included source, license notices, updates, and host adaptations.

Depending on a separate installation of the official plugin would require users to manage two plugins and this project to track their internal helper compatibility. Bundling the required execution code puts that dependency within the repository's source-lock and verification process. The included code supports the worker executors users select through setup and preserves pstack's workflow behavior. The runtime is integrated behind the foreground worker runner. Its source pin and verified scope are recorded in [Design and compatibility](../spec.md).
