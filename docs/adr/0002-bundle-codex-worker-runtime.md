---
status: accepted
---

# Bundle the Codex worker runtime with the Claude Code distribution

Include the official Codex plugin's worker execution code in the Claude Code distribution, pinned to a reviewed source revision. This project owns the included source, license notices, updates, and host adaptations. The worker runner launches the separate official `codex-app-server --session-source app-server` binary. It shares the existing Codex account, configuration, and persistent rollout/state storage through inherited `CODEX_HOME`.

Depending on a separate installation of the official plugin would require users to manage two plugins and this project to track their internal helper compatibility. Bundling the required execution code puts that dependency within the repository's source-lock and verification process. The included code supports the worker executors users select through setup and preserves pstack's workflow behavior. The runtime is integrated behind the foreground worker runner. Its source pin and verified scope are recorded in [Design and compatibility](../spec.md).

The standalone server is a separate platform dependency, not a bundled binary or an npm CLI installation. Users extract the complete matching-platform package from [official Codex releases](https://github.com/openai/codex/releases) and retain its companion executables and directory layout. They put its `bin` directory on PATH or select an absolute binary path. The no-extension `codex-app-server` asset is a DotSlash manifest. The plugin adds no downloader, updater, wrapper process, or private profile. The Codex CLI remains the human login tool.

For the observed [0.167.0 Apple silicon package](https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-app-server-package-aarch64-apple-darwin.tar.gz), the gzip download is 132,409,690 bytes and the complete extracted payload is 342,231,687 bytes. The same target's zstd archive is 94,025,162 bytes. These are version-specific package costs, not plugin artifact sizes or estimates for other platforms. The package includes `bin/codex-app-server`, `codex-code-mode-host`, `codex-exec-server`, and `codex-path/rg`.

The previous `threadSource: chatgpt_hidden` adaptation failed the observed Desktop list path. The standalone session source replaces that policy without moving old threads or discarding persistent history. Generic bundled clients retain their `codex app-server` default when `appServerArgs` is omitted. Pstack passes the standalone arguments at the existing launch and availability boundaries. Capability probes, automated fixtures, and the named live workflow checks establish their recorded contracts. Final Desktop screen observation and release approval remain separate gates.
