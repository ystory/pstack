---
status: accepted
---

# Select the Codex worker server with a saved visibility setting

Setup saves `codexWorkers` in the Claude host preferences. `hidden`, the default, keeps the official standalone `codex-app-server --session-source app-server` from [ADR 0002](0002-bundle-codex-worker-runtime.md). `visible` launches the Codex CLI's `codex app-server`. The runner reads the saved value for every run, so workflows and skills never pass a runtime setting.

The standalone server keeps worker threads out of Codex Desktop lists and `codex resume`, which the user requires on a personal Mac. Claude cloud sessions cannot download its release package because their network policy blocks GitHub release downloads for unattached repositories, while the npm CLI installs. The CLI server has no session source option and records worker threads as `vscode`, so they appear in Codex history. The setting makes that trade explicit per host instead of hiding it.

Setup decides from the host's actual state. It chooses `hidden` when the standalone server works or can be installed and `visible` only when it cannot be obtained and the CLI works, then tells the user which value it saved and why. A missing value means `hidden`, so existing installations keep their behavior without a rerun.

Neither value falls back to the other server at run time. A silent fallback would make worker visibility depend on what happens to be on PATH. Making the CLI the only server was rejected because it would show every worker in Codex history on the Mac.
