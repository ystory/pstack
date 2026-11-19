# Prepare worker runtimes and login

The host running setup prepares the selected executors. Reuse working installations; otherwise use official installation guidance and the host's normal tools to install what the authorized setup needs. Prepare the environment used by future workers, then rerun detection. Leave only genuinely interactive steps, such as login or operating-system approval, to the user. Detection and catalog helpers remain read-only.

## Node.js

Check `node --version`. Install Node.js 24.12 or newer from the [official Node.js downloads](https://nodejs.org/en/download), then rerun the version check. Node is needed for the bundled setup and Codex runtime helpers. It is independent of Claude's native installer.

## Claude Code

Check `claude --version` only when native Claude workers are selected. Skip its login and capability probes whenever native Claude workers are unselected. Use the direct Codex runner for Codex detection when Claude is unselected. On macOS, Linux, or WSL, the [official installation guide](https://code.claude.com/docs/en/setup) uses this command.

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

For Windows, use that guide's PowerShell or CMD instructions. After installation, rerun detection. Native pstack effort selection needs a host that exposes the Agent effort parameter, documented from Claude Code 2.1.292.

Use `claude auth status` to inspect login state. If logged out, run `claude auth login` in a terminal, or use the host's `/login` flow. The [Claude authentication guide](https://code.claude.com/docs/en/authentication) describes subscription, Console, and provider authentication. Reuse the selected account and organization configuration. Do not copy tokens into setup files.

Detection checks the existing CLI login through the inherited environment, including any existing `CLAUDE_CONFIG_DIR`. The helper flag `--claude-home` selects where setup inspects and saves configuration. It does not change the CLI authentication environment. The detection receipt reports both locations. To use a different CLI profile, launch setup with that profile's environment and use its normal login flow if needed.

## Codex workers

Codex is optional when every worker uses native Claude. The saved `codexWorkers` setting selects the worker server.

With `hidden`, the default, prepare the official standalone `codex-app-server` from [Codex releases](https://github.com/openai/codex/releases). Reuse a working installation or obtain the complete package for this machine. Preserve its companion files. The no-extension `codex-app-server` release asset is a DotSlash manifest, not the native binary. Pstack calls `codex-app-server --session-source app-server`, so worker threads stay out of Codex Desktop lists and `codex resume`. The CLI's `codex app-server` does not provide this source selection.

With `visible`, workers use the [Codex CLI](https://developers.openai.com/codex/cli) through `codex app-server`. Install it with `npm i -g @openai/codex`. That server records worker threads with the `vscode` session source, so they appear in Codex Desktop lists and `codex resume`. Use `visible` only where the standalone package cannot be obtained, such as a cloud container that blocks GitHub release downloads.

As part of setup, make the selected server available on the PATH inherited by Claude Code and future workers. Choose an appropriate normal installation location; pstack does not prescribe its own layout. Verify detection without an override before completing Codex setup. Absolute-path options are per-invocation diagnostics overrides, not saved installation settings. The setup host performs ordinary dependency installation; pstack does not bundle or pin native server releases, host downloads, manage upgrades, or maintain a version compatibility matrix.

The Codex CLI is also the human login tool. With `hidden`, installing it through npm does not install the standalone worker package. Run `codex login` in a terminal. In Claude Code, the user can run `!codex login` to open the CLI flow. In a headless environment or when a localhost callback cannot complete, use the documented device flow.

```sh
codex login --device-auth
```

Device login may need to be enabled by the account or workspace. See the [official Codex authentication guide](https://learn.chatgpt.com/docs/auth).

The CLI and the worker server must inherit the same `CODEX_HOME`, or both use its default `~/.codex`. Workers share that configuration, account, and persistent rollout/state storage. Do not create a separate profile or copy credentials to hide workers.

ChatGPT login uses the account's Codex plan. API-key login uses OpenAI API billing. Let the user choose the intended method, and follow the official auth guide for API-key setup outside the conversation. Never print a key, credential cache, or full authentication response. The bundled runner reports safe status and method fields.

Rerun detection and collect the catalog after login. Runtime capability, login state, model catalog, and successful worker execution are separate evidence.

## Antigravity workers

Prepare Antigravity only when selected. Use the official [Antigravity installation guide](https://antigravity.google/docs/getting-started/) and its `https://antigravity.google/cli/install.sh` installer. The bundled runner requires the official agy CLI 1.5.8 or newer. Run the sibling `poteto-mode/scripts/run-agy.mjs detect` through the PATH inherited by future workers. An absolute `--executable` overrides one invocation for diagnostics and is never saved. No unofficial extension is required.

Let the user choose the authentication method, follow the official guide for it, and never switch methods silently. Reuse a working method the user keeps. Do not inspect or copy credential files or save personal model defaults. The official CLI supports three methods:

- Subscription login uses the official interactive agy login in the user's terminal. Detection reports `inherited-default`.
- The Gemini API key method follows the [official agy installation page](https://antigravity.google/docs/install.md). When the user chooses it, set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and keep every other setting. The user makes `GEMINI_API_KEY` available in the environment inherited by this host and future workers, outside the conversation. Never ask for, print, or copy the key. The key alone has no effect. With `modelProvider` set and no key, agy exits at startup with a message naming `GEMINI_API_KEY`. Detection reports `gemini-api-key`.
- ADC uses existing Google Application Default Credentials with `AGY_ADC_AUTH=true` in the inherited environment. Detection reports `adc`.

agy checks `modelProvider` before `AGY_ADC_AUTH`, so `"modelProvider": "gemini"` selects the API key method even when ADC is enabled. When the user chooses another method while that value is set, remove only `modelProvider`.

Rerun detection after preparing the method. Confirm `auth.method`, and for the Gemini API key method confirm `auth.geminiApiKeyPresent`, before collecting the catalog. If the key is reported absent, this host did not inherit it. The runner reports only these safe fields and passes no authentication option to agy. A version probe and these fields do not prove authentication or model access.

Run `poteto-mode/scripts/run-agy.mjs catalog --cwd ABS --run-dir ABS_NEW_LOCAL_DIRECTORY`. This collects sanitized exact model IDs, labels, per-model capability sources, and the runtime version without a task prompt. A fixed-effort label supplies only its reported variant effort. Unclassified models remain candidates until per-model evidence supplies supported efforts. Catalog availability does not establish successful inference. The catalog lists the models of the active method, so collect it again after a method change. Antigravity-only setup skips every other executor's probes and catalog inputs.
