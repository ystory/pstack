# Prepare worker CLIs and login

Check Node.js and the executors selected for this Codex host. Detection and model catalog commands do not install software or authenticate. Run an installer when that installation is authorized, then let the user complete interactive login.

## Node.js and Codex

Run `node --version` and `codex --version`. The setup helpers need Node.js 24.12 or newer from the [official Node.js downloads](https://nodejs.org/en/download).

For a missing Codex CLI, follow the [official installation guide](https://developers.openai.com/codex/cli). Its npm route is `npm install -g @openai/codex`. Run `codex login` in a terminal. In a headless environment, or when a localhost browser callback cannot complete, use `codex login --device-auth` as described in the [authentication guide](https://learn.chatgpt.com/docs/auth). Device login may require account or workspace enablement.

ChatGPT login uses the account's Codex plan. API-key login uses OpenAI API billing. Follow the official auth flow for the chosen method outside the conversation. Do not print credentials or read credential caches into the chat. Recheck login status and the actual model catalog after login.

## Claude Code workers

When the user selects the existing external Claude route, run the bundled `run-claude.mjs detect`. If the CLI is missing, use the [official Claude installation guide](https://code.claude.com/docs/en/setup). On macOS, Linux, or WSL, its native installer is `curl -fsSL https://claude.ai/install.sh | bash`. Use that guide's Windows commands on Windows.

Run `claude auth status` to inspect login. If logged out, guide `claude auth login` in a terminal, or `/login` inside Claude Code. The [authentication guide](https://code.claude.com/docs/en/authentication) describes subscription, Console, and provider methods. Reuse the user's intended account and organization settings.

Rerun the existing capability detector after installation or login. The external route requires a supported exact model choice and the required CLI options. Detection reports global effort syntax and does not enumerate account models. Confirm each nondefault model and its supported efforts separately as described in the [model contract](models-contract.md#model-capability-records). CLI capability, login state, model access, and successful execution remain separate evidence. Claude-only setup does not replace or change the Codex host's own authentication.
