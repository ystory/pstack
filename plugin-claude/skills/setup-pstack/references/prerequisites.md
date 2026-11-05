# Prepare worker CLIs and login

Check only the executors the user intends to use. Detection and catalog commands do not install software or start authentication. Run an installer when that installation is authorized. Keep login interactive and let the user complete it.

## Node.js

Check `node --version`. Install Node.js 24.12 or newer from the [official Node.js downloads](https://nodejs.org/en/download), then rerun the version check. Node is needed for the bundled setup and Codex runtime helpers. It is independent of Claude's native installer.

## Claude Code

Check `claude --version`. On macOS, Linux, or WSL, the [official installation guide](https://code.claude.com/docs/en/setup) uses this command.

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

For Windows, use that guide's PowerShell or CMD instructions. After installation, rerun detection. Native pstack effort selection needs a host that exposes the Agent effort parameter, documented from Claude Code 2.1.292.

Use `claude auth status` to inspect login state. If logged out, run `claude auth login` in a terminal, or use the host's `/login` flow. The [Claude authentication guide](https://code.claude.com/docs/en/authentication) describes subscription, Console, and provider authentication. Reuse the selected account and organization configuration. Do not copy tokens into setup files.

## Codex workers

Codex is optional when every worker uses native Claude. Check `codex --version` and the bundled runner's `detect` result. The [official Codex CLI guide](https://developers.openai.com/codex/cli) provides installation options, including this npm command.

```sh
npm install -g @openai/codex
```

After installation, run `codex login` in a terminal. In Claude Code, the user can run `!codex login` to open the CLI flow. In a headless environment or when a localhost callback cannot complete, use the documented device flow.

```sh
codex login --device-auth
```

Device login may need to be enabled by the account or workspace. See the [official Codex authentication guide](https://learn.chatgpt.com/docs/auth).

ChatGPT login uses the account's Codex plan. API-key login uses OpenAI API billing. Let the user choose the intended method, and follow the official auth guide for API-key setup outside the conversation. Never print a key, credential cache, or full authentication response. The bundled runner reports safe status and method fields.

Rerun detection and collect the catalog after login. CLI capability, login state, model catalog, and successful worker execution are separate evidence.
