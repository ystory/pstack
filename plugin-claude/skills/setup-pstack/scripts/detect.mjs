#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, claudeHome, inspect, run } from './state.mjs';

const runner = fileURLToPath(
  new URL('../../poteto-mode/scripts/run-codex.mjs', import.meta.url),
);
const invoke = (executable, args, env) =>
  spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
const succeeded = (result) => !result.error && result.status === 0;
async function executableFor(selected, name) {
  if (selected && !path.isAbsolute(selected))
    throw new Error(`${name} executable requires an absolute path.`);
  const candidates = selected
    ? [selected]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((directory) =>
          path.resolve(
            directory,
            process.platform === 'win32' ? `${name}.exe` : name,
          ),
        );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}
function jsonOutput(result) {
  if (!succeeded(result)) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}
function versionAtLeast(version, minimum) {
  const actual = version
    ?.match(/\d+\.\d+\.\d+/)?.[0]
    ?.split('.')
    .map(Number);
  if (!actual) return false;
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1)
    if (actual[i] !== required[i]) return actual[i] > required[i];
  return true;
}
async function nativeCandidates(home) {
  const candidates = [];
  const settingsFile = path.join(home, 'settings.json');
  if (await inspect(settingsFile)) {
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    } catch {
      throw new Error('Claude settings.json is not valid JSON.');
    }
    for (const model of [
      settings.model,
      ...(Array.isArray(settings.availableModels)
        ? settings.availableModels
        : []),
    ])
      if (typeof model === 'string')
        candidates.push({
          model,
          source: settingsFile,
          confirmationRequired: true,
        });
  }
  for (const name of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ])
    if (process.env[name])
      candidates.push({
        model: process.env[name],
        source: name,
        confirmationRequired: true,
      });
  return candidates;
}

await run(async () => {
  const options = argumentsFor(
    process.argv.slice(2),
    ['detect', 'catalog'],
    [
      '--claude-home',
      '--claude-executable',
      '--codex-executable',
      '--cwd',
      '--executors',
    ],
  );
  if (options.help) {
    process.stdout.write(
      'Usage: node detect.mjs detect|catalog [--claude-home ABS] [--claude-executable ABS] [--codex-executable ABS] [--cwd ABS] [--executors claude-code|claude-code,codex]\n',
    );
    return;
  }
  if (options.cwd && !path.isAbsolute(options.cwd))
    throw new Error('--cwd requires an absolute path.');
  const executors = (options.executors ?? 'claude-code').split(',');
  if (
    !executors.includes('claude-code') ||
    new Set(executors).size !== executors.length ||
    executors.some((executor) => !['claude-code', 'codex'].includes(executor))
  )
    throw new Error('--executors selects claude-code or claude-code,codex.');
  const includeCodex = executors.includes('codex');
  const home = claudeHome(options.claudeHome);
  await inspect(home, true);
  const executable = await executableFor(options.claudeExecutable, 'claude');
  const versionResult =
    executable && invoke(executable, ['--version'], process.env);
  const helpResult = executable && invoke(executable, ['--help'], process.env);
  const version =
    versionResult && succeeded(versionResult)
      ? (versionResult.stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ??
        null)
      : null;
  const authResult =
    executable && invoke(executable, ['auth', 'status'], process.env);
  let auth;
  if (authResult && !authResult.error && [0, 1].includes(authResult.status)) {
    try {
      auth = JSON.parse(authResult.stdout);
    } catch {}
  }
  const method = auth?.authMethod ?? auth?.method;
  const native = {
    cli: {
      available: Boolean(executable),
      executable,
      version,
      agentDefinitions: Boolean(
        helpResult &&
        succeeded(helpResult) &&
        helpResult.stdout.includes('--agents'),
      ),
      perCallEffort: versionAtLeast(version, '2.1.292'),
      environment: {
        source: 'inherited',
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      },
    },
    auth: {
      verified: Boolean(auth && typeof auth.loggedIn === 'boolean'),
      loggedIn: typeof auth?.loggedIn === 'boolean' ? auth.loggedIn : null,
      method:
        typeof method === 'string' && /^[\w-]+$/.test(method) ? method : null,
    },
    modelCandidates: await nativeCandidates(home),
    modelCatalog: {
      discovered: false,
      confirmationRequired: true,
      guidance:
        'Use the actual host model catalog and supported efforts. If unavailable, confirm exact model IDs and efforts manually. Configuration entries are candidates, not entitlement evidence.',
    },
    execution: { verified: false },
  };
  const args = [
    runner,
    options.command,
    ...(options.codexExecutable
      ? ['--executable', options.codexExecutable]
      : []),
    ...(options.command === 'catalog' && options.cwd
      ? ['--cwd', options.cwd]
      : []),
  ];
  const codexResult =
    includeCodex && invoke(process.execPath, args, process.env);
  const codex = !includeCodex
    ? undefined
    : (jsonOutput(codexResult) ?? {
        cli: { available: false },
        auth: { verified: false, loggedIn: null, method: null },
        error:
          'Codex runtime detection was unavailable. Run the bundled run-codex.mjs detect for diagnostics.',
      });
  const guidance = [];
  if (!native.cli.available)
    guidance.push({
      executor: 'claude-code',
      action: 'install',
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      url: 'https://code.claude.com/docs/en/setup',
    });
  else if (native.auth.loggedIn === false)
    guidance.push({
      executor: 'claude-code',
      action: 'login',
      command: 'claude auth login',
      interactiveCommand: '/login',
      url: 'https://code.claude.com/docs/en/authentication',
    });
  if (includeCodex && !codex.cli?.available)
    guidance.push({
      executor: 'codex',
      action: 'install',
      runtime: 'codex-app-server',
      url: 'https://github.com/openai/codex/releases',
      detail:
        'During setup, install the complete matching-platform official codex-app-server package when needed and prepare PATH for this host and future workers. Recheck without overrides. --codex-executable ABS is only a per-call diagnostic override.',
      requiredFor: 'Codex workers only',
    });
  else if (includeCodex && codex.auth?.loggedIn === false)
    guidance.push({
      executor: 'codex',
      action: 'login',
      command: 'codex login',
      headlessCommand: 'codex login --device-auth',
      url: 'https://learn.chatgpt.com/docs/auth',
      requiredFor: 'Codex workers only',
    });
  return {
    schemaVersion: 1,
    configuration: { claudeHome: home },
    executors,
    node: {
      executable: process.execPath,
      version: process.version,
      available: true,
    },
    claude: native,
    ...(includeCodex ? { codex } : {}),
    guidance,
    authentication: {
      chatgpt: 'Codex ChatGPT subscription login uses the account plan.',
      apiKey:
        'Codex API-key login uses OpenAI API billing. Never paste a key into setup output.',
    },
  };
});
