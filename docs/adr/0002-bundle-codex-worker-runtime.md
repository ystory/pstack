---
status: accepted
---

# Bundle the Codex worker runtime with the Claude Code distribution

Include the official Codex plugin's worker execution code in the Claude Code distribution, pinned to a reviewed source revision. This project owns the included source, license notices, updates, and host adaptations. The worker runner launches the separate official `codex-app-server --session-source app-server` binary. It shares the existing Codex account, configuration, and persistent rollout/state storage through inherited `CODEX_HOME`.

Depending on a separate installation of the official plugin would require users to manage two plugins and this project to track their internal helper compatibility. Bundling the required execution code puts that dependency within the repository's source-lock and verification process. The included code supports the worker executors users select through setup and preserves pstack's workflow behavior. The runtime is integrated behind the foreground worker runner. Its source pin and verified scope are recorded in [Design and compatibility](../spec.md).

The native standalone server is an ordinary external dependency. The host running setup reuses or installs it from [official Codex sources](https://github.com/openai/codex/releases), prepares its availability to future workers, and checks the capabilities needed by the runner. Pstack does not redistribute or pin native server releases, choose a private installation layout, manage upgrades, or promise compatibility across all versions. Installation uses the host's normal tools rather than a pstack package manager. This native dependency is separate from the included JavaScript client source pinned above.

The named workflow was verified with official server 0.167.0 on Apple silicon macOS. That is an observation, not an installation pin or a version support matrix.

The previous `threadSource: chatgpt_hidden` adaptation failed the observed Desktop list path. The standalone session source replaces that policy without moving old threads or discarding persistent history. Generic bundled clients retain their `codex app-server` default when `appServerArgs` is omitted. Pstack passes the standalone arguments at the existing launch and availability boundaries. Capability probes, automated fixtures, and the named live workflow checks establish their recorded contracts. Final Desktop screen observation and release approval remain separate gates.
