# Prepare worker runtimes and login

The host running setup prepares the selected executors. Reuse working installations; otherwise use official installation guidance and the host's normal tools to install what the authorized setup needs. Prepare the environment used by future workers, then rerun detection. Leave only genuinely interactive steps, such as login or operating-system approval, to the user. Detection and catalog helpers remain read-only.

## Node.js

Check `node --version`. Install Node.js 24.12 or newer from the [official Node.js downloads](https://nodejs.org/en/download), then rerun the version check. Node is needed for the bundled setup and Codex runtime helpers. It is independent of Claude's native installer.

## Claude Code

Check `claude --version` only when native Claude workers are selected. Skip its login and capability probes for Pi-only workers or Pi with Codex workers. Use the direct Codex runner for Codex detection when Claude is unselected. On macOS, Linux, or WSL, the [official installation guide](https://code.claude.com/docs/en/setup) uses this command.

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

For Windows, use that guide's PowerShell or CMD instructions. After installation, rerun detection. Native pstack effort selection needs a host that exposes the Agent effort parameter, documented from Claude Code 2.1.292.

Use `claude auth status` to inspect login state. If logged out, run `claude auth login` in a terminal, or use the host's `/login` flow. The [Claude authentication guide](https://code.claude.com/docs/en/authentication) describes subscription, Console, and provider authentication. Reuse the selected account and organization configuration. Do not copy tokens into setup files.

Detection checks the existing CLI login through the inherited environment, including any existing `CLAUDE_CONFIG_DIR`. The helper flag `--claude-home` selects where setup inspects and saves configuration. It does not change the CLI authentication environment. The detection receipt reports both locations. To use a different CLI profile, launch setup with that profile's environment and use its normal login flow if needed.

## Codex workers

Codex is optional when every worker uses native Claude. Prepare the official standalone `codex-app-server` from [Codex releases](https://github.com/openai/codex/releases). Reuse a working installation or obtain the complete package for this machine. Preserve its companion files. The no-extension `codex-app-server` release asset is a DotSlash manifest, not the native binary.

As part of setup, make the server available on the PATH inherited by Claude Code and future workers. Choose an appropriate normal installation location; pstack does not prescribe its own layout. Verify detection without an override before completing Codex setup. Absolute-path options are per-invocation diagnostics overrides, not saved installation settings.

Pstack calls `codex-app-server --session-source app-server` and checks the capabilities that this invocation needs. The umbrella `codex app-server` does not provide this source selection. The setup host performs ordinary dependency installation; pstack does not bundle or pin native server releases, host downloads, manage upgrades, or maintain a version compatibility matrix.

The [Codex CLI](https://developers.openai.com/codex/cli) remains the human login tool. Installing it through npm does not install the standalone worker package. Run `codex login` in a terminal. In Claude Code, the user can run `!codex login` to open the CLI flow. In a headless environment or when a localhost callback cannot complete, use the documented device flow.

```sh
codex login --device-auth
```

Device login may need to be enabled by the account or workspace. See the [official Codex authentication guide](https://learn.chatgpt.com/docs/auth).

The CLI and standalone server must inherit the same `CODEX_HOME`, or both use its default `~/.codex`. Workers share that configuration, account, and persistent rollout/state storage. Do not create a separate profile or copy credentials to hide workers.

ChatGPT login uses the account's Codex plan. API-key login uses OpenAI API billing. Let the user choose the intended method, and follow the official auth guide for API-key setup outside the conversation. Never print a key, credential cache, or full authentication response. The bundled runner reports safe status and method fields.

Rerun detection and collect the catalog after login. Runtime capability, login state, model catalog, and successful worker execution are separate evidence.

## Pi workers

Pi is optional. Prepare it only when selected. The runner requires Pi 1.5.2 or newer and checks the inspected RPC controls at runtime. Use the [Pi installation guide](https://pi.dev/) for the official `@earendil-works/pi-coding-agent` package, then check `pi --version` on the PATH inherited by future workers. An absolute `--executable` overrides one invocation for diagnostics and is never saved.

Reuse existing Pi authentication and provider configuration. Do not read or copy credential files, change personal defaults, or create a separate authentication home. Guide an interactive `/login` only when required and authorized for the user's selected provider. Existing cloud credentials can supply provider authentication through their normal environment. A model appearing in the catalog does not prove that its credentials can complete inference.

Run the sibling `poteto-mode/scripts/run-pi.mjs catalog --cwd ABS --run-dir ABS_NEW_LOCAL_DIRECTORY`. It disables discovered extensions, MCP, context files, skills, templates, and startup refresh. It uses inherited configuration and authentication, selects each exact provider/model, reads supported thinking levels, and writes only sanitized catalog evidence. No model prompt is sent. Session storage is isolated without replacing the user's Pi agent directory. If required RPC controls or selected routes fail, report the capability gap. Runtime detection, catalog availability, task execution, and release approval remain separate evidence.
