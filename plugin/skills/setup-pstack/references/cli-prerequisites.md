# Prepare worker CLIs and login

Check Node.js and the executors selected for this Codex host. Detection and model catalog commands do not install software or authenticate. Run an installer when that installation is authorized, then let the user complete interactive login.

## Node.js and Codex

Run `node --version`. Check `codex --version` only when native Codex workers are selected. The setup helpers need Node.js 24.12 or newer from the [official Node.js downloads](https://nodejs.org/en/download).

For a missing Codex CLI, follow the [official installation guide](https://developers.openai.com/codex/cli). Its npm route is `npm install -g @openai/codex`. Run `codex login` in a terminal. In a headless environment, or when a localhost browser callback cannot complete, use `codex login --device-auth` as described in the [authentication guide](https://learn.chatgpt.com/docs/auth). Device login may require account or workspace enablement.

ChatGPT login uses the account's Codex plan. API-key login uses OpenAI API billing. Follow the official auth flow for the chosen method outside the conversation. Do not print credentials or read credential caches into the chat. Recheck login status and the actual model catalog after login.

## Claude Code workers

When the user selects the existing external Claude route, run the bundled `run-claude.mjs detect`. If the CLI is missing, use the [official Claude installation guide](https://code.claude.com/docs/en/setup). On macOS, Linux, or WSL, its native installer is `curl -fsSL https://claude.ai/install.sh | bash`. Use that guide's Windows commands on Windows.

Run `claude auth status` to inspect login. If logged out, guide `claude auth login` in a terminal, or `/login` inside Claude Code. The [authentication guide](https://code.claude.com/docs/en/authentication) describes subscription, Console, and provider methods. Reuse the user's intended account and organization settings.

Rerun the existing capability detector after installation or login. The external route requires a supported exact model choice and the required CLI options. Detection reports global effort syntax and does not enumerate account models. Confirm each exact model and its supported efforts separately as described in the [model contract](models-contract.md#model-capability-records). CLI capability, login state, model access, and successful execution remain separate evidence. Choosing Claude workers leaves the Codex parent's authentication unchanged. Codex-only setup never invokes the Claude detector.

## Antigravity workers

Prepare Antigravity only when selected. Use the official [Antigravity installation guide](https://antigravity.google/docs/getting-started/) and its `https://antigravity.google/cli/install.sh` installer. The bundled runner requires the official agy CLI 1.5.8 or newer. Run the sibling `poteto-mode/scripts/run-agy.mjs detect` through the PATH inherited by future workers. An absolute `--executable` overrides one invocation for diagnostics and is never saved. No unofficial extension is required.

Let the user choose the authentication method, follow the official guide for it, and never switch methods silently. Reuse a working method the user keeps. Do not inspect or copy credential files or save personal model defaults. The official CLI supports three methods:

- Subscription login uses the official interactive agy login in the user's terminal. Detection reports `inherited-default`.
- The Gemini API key method follows the [official agy installation page](https://antigravity.google/docs/install.md). When the user chooses it, set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and keep every other setting. The user makes `GEMINI_API_KEY` available in the environment inherited by this host and future workers, outside the conversation. Never ask for, print, or copy the key. The key alone has no effect. With `modelProvider` set and no key, agy exits at startup with a message naming `GEMINI_API_KEY`. Detection reports `gemini-api-key`.
- ADC uses existing Google Application Default Credentials with `AGY_ADC_AUTH=true` in the inherited environment. Detection reports `adc`.

agy checks `modelProvider` before `AGY_ADC_AUTH`, so `"modelProvider": "gemini"` selects the API key method even when ADC is enabled. When the user chooses another method while that value is set, remove only `modelProvider`.

Rerun detection after preparing the method. Confirm `auth.method`, and for the Gemini API key method confirm `auth.geminiApiKeyPresent`, before collecting the catalog. If the key is reported absent, this host did not inherit it. The runner reports only these safe fields and passes no authentication option to agy. A version probe and these fields do not prove authentication or model access.

Run `poteto-mode/scripts/run-agy.mjs catalog --cwd ABS --run-dir ABS_NEW_LOCAL_DIRECTORY`. This collects sanitized exact model IDs, labels, per-model capability sources, and the runtime version without a task prompt. A fixed-effort label supplies only its reported variant effort. Unclassified models remain candidates until per-model evidence supplies supported efforts. Catalog availability does not establish successful inference. The catalog lists the models of the active method, so collect it again after a method change. Antigravity-only setup skips every other executor's probes and catalog inputs.
