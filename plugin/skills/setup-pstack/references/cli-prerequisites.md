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

## Pi workers

Pi is optional. Prepare it only when selected. The runner requires Pi 1.5.2 or newer and checks the inspected RPC controls at runtime. Use the [Pi installation guide](https://pi.dev/) for the official `@earendil-works/pi-coding-agent` package, then check `pi --version` on the PATH inherited by future workers. An absolute `--executable` overrides one invocation for diagnostics and is never saved.

Reuse existing Pi authentication and provider configuration. Do not read or copy credential files, change personal defaults, or create a separate authentication home. Guide an interactive `/login` only when required and authorized for the user's selected provider. Existing cloud credentials can supply provider authentication through their normal environment. A model appearing in the catalog does not prove that its credentials can complete inference.

Run the sibling `poteto-mode/scripts/run-pi.mjs catalog --cwd ABS --run-dir ABS_NEW_LOCAL_DIRECTORY`. It disables discovered extensions, MCP, context files, skills, templates, and startup refresh. It uses inherited configuration and authentication, selects each exact provider/model, reads supported thinking levels, and writes only sanitized catalog evidence. No model prompt is sent. Session storage is isolated without replacing the user's Pi agent directory. If required RPC controls or selected routes fail, report the capability gap. Runtime detection, catalog availability, task execution, and release approval remain separate evidence.

## Antigravity workers

Prepare Antigravity only when selected. Use the official [Antigravity installation guide](https://antigravity.google/docs/getting-started/) and its `https://antigravity.google/cli/install.sh` installer. The bundled runner requires the official agy CLI 1.5.8 or newer. Run the sibling `poteto-mode/scripts/run-agy.mjs detect` through the PATH inherited by future workers. An absolute `--executable` overrides one invocation for diagnostics and is never saved. No unofficial extension is required.

Reuse the official CLI's inherited authentication and environment. `AGY_ADC_AUTH=true` selects inherited ADC mode. Other official login or API-key environments remain inherited defaults. Do not inspect or copy credential files, switch authentication routes, or save personal model defaults. Use the official interactive login flow only when needed and authorized. A version probe does not prove authentication or model access.

Run `poteto-mode/scripts/run-agy.mjs catalog --cwd ABS --run-dir ABS_NEW_LOCAL_DIRECTORY`. This collects sanitized exact model IDs, labels, per-model capability sources, and the runtime version without a task prompt. A fixed-effort label supplies only its reported variant effort. Unclassified models remain candidates until per-model evidence supplies supported efforts. Catalog availability does not establish successful inference. Antigravity-only setup skips every other executor's probes and catalog inputs.
