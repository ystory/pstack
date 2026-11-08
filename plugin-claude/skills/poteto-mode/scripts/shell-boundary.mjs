#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHELL_BOUNDARY_CONTEXT =
  'Pstack protects this macOS worker before every shell operation. CODEX_SANDBOX=seatbelt stops the command with exit 125 and PSTACK_REVIEW_REQUIRED before any child starts. Retry the same task operation through native reviewed escalation with the command unchanged. The native reviewer decides whether it runs. Keep verification in this delegate.';
export const SHELL_BOUNDARY_PREFIX =
  "if [ \"${CODEX_SANDBOX-}\" = seatbelt ]; then printf '%s\\n' 'PSTACK_REVIEW_REQUIRED: No command started. Retry the same task operation through native reviewed escalation with the command unchanged. The native reviewer decides whether it runs.' >&2; exit 125; fi\n";

const blockStart = '# >>> pstack-codex managed agents v1\n';
const blockEnd = '# <<< pstack-codex managed agents v1\n';
const roleName = /^[A-Za-z0-9_-]+$/;
const roleHeader = /^\[agents\.([A-Za-z0-9_-]+)\]$/;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeRegistration(record) {
  const roles = new Set();
  if (record?.pluginName === 'pstack-codex') {
    if (object(record.agents))
      for (const name of Object.keys(record.agents))
        if (roleName.test(name)) roles.add(name);
    if (typeof record.config?.block === 'string')
      for (const line of record.config.block.split('\n')) {
        const match = roleHeader.exec(line);
        if (match) roles.add(match[1]);
      }
  }
  const unsupported = (reason) => ({
    status: 'unsupported',
    roles: [...roles],
    reason: `Pstack agent registration is unsupported. ${reason} Rerun setup-pstack to repair the owned registration.`,
  });
  if (!record) return { status: 'absent', roles: [] };
  if (record.pluginName !== 'pstack-codex')
    return unsupported('The ownership record belongs to another plugin.');
  if (record.schemaVersion !== 2)
    return unsupported('Expected ownership schemaVersion 2.');
  if (
    typeof record.pluginVersion !== 'string' ||
    !record.pluginVersion ||
    !object(record.agents) ||
    !Object.keys(record.agents).length ||
    Object.entries(record.agents).some(
      ([name, agent]) =>
        !roleName.test(name) ||
        !object(agent) ||
        !/^[a-f0-9]{64}$/.test(agent.sha256 ?? '') ||
        (agent.mode !== undefined &&
          (!Number.isInteger(agent.mode) ||
            agent.mode < 0 ||
            agent.mode > 0o777)),
    )
  )
    return unsupported('The agent file ownership map is invalid.');
  const config = record.config;
  if (
    !object(config) ||
    typeof config.block !== 'string' ||
    !config.block.startsWith(blockStart) ||
    !config.block.endsWith(blockEnd) ||
    !['', '\n'].includes(config.prefix) ||
    typeof config.created !== 'boolean'
  )
    return unsupported('The managed config ownership block is invalid.');
  const declared = new Map();
  let current;
  for (const line of config.block
    .slice(blockStart.length, -blockEnd.length)
    .split('\n')) {
    if (!line) continue;
    const header = roleHeader.exec(line);
    if (header) {
      if (declared.has(header[1]))
        return unsupported('The managed config repeats an agent role.');
      current = {};
      declared.set(header[1], current);
      continue;
    }
    const field = /^(description|config_file) = (".*")$/.exec(line);
    if (!current || !field || Object.hasOwn(current, field[1]))
      return unsupported('The managed config has an unexpected field or line.');
    try {
      const value = JSON.parse(field[2]);
      if (typeof value !== 'string') throw new Error('Expected a string.');
      current[field[1]] = value;
    } catch {
      return unsupported('The managed config has an invalid string.');
    }
  }
  if (
    !declared.size ||
    [...declared].some(
      ([name, role]) =>
        typeof role.description !== 'string' ||
        (Object.hasOwn(record.agents, name)
          ? typeof role.config_file !== 'string' ||
            !path.isAbsolute(role.config_file)
          : Object.hasOwn(role, 'config_file')),
    ) ||
    Object.keys(record.agents).some((name) => !declared.has(name))
  )
    return unsupported('Agent file and managed config ownership disagree.');
  return { status: 'ready', roles: [...declared.keys()] };
}

export function classifyScope({
  platform,
  externalWorker = false,
  agentType,
  registration = { status: 'absent', roles: [] },
}) {
  if (platform !== 'darwin') return 'out-of-scope';
  if (externalWorker) return 'external-worker';
  if (!agentType || !registration.roles.includes(agentType))
    return 'out-of-scope';
  if (registration.status !== 'ready') throw new Error(registration.reason);
  return 'registered-native-worker';
}

export function rewriteCommand(command) {
  return command.startsWith(SHELL_BOUNDARY_PREFIX)
    ? command
    : SHELL_BOUNDARY_PREFIX + command;
}

function validateInput(input) {
  if (!object(input)) throw new Error('Hook input must be an object.');
  if (
    input.hook_event_name !== undefined &&
    input.hook_event_name !== 'PreToolUse'
  )
    throw new Error('Hook input must describe PreToolUse.');
  if (input.tool_name !== 'Bash')
    throw new Error('Hook input tool_name must be Bash.');
  if (!object(input.tool_input) || typeof input.tool_input.command !== 'string')
    throw new Error('Hook input requires a string tool_input.command.');
  if (
    input.agent_type !== undefined &&
    input.agent_type !== null &&
    typeof input.agent_type !== 'string'
  )
    throw new Error('Hook input agent_type must be a string when supplied.');
}

export function shellBoundaryOutput(input, options = {}) {
  validateInput(input);
  const scope = classifyScope({
    platform: options.platform ?? process.platform,
    externalWorker: options.externalWorker,
    agentType: input.agent_type,
    registration: options.registration,
  });
  if (scope === 'out-of-scope') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        command: rewriteCommand(input.tool_input.command),
      },
      additionalContext: SHELL_BOUNDARY_CONTEXT,
    },
  };
}

async function readRegistration(env) {
  const home = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(home)) throw new Error('CODEX_HOME must be absolute.');
  const file = path.join(home, 'pstack-codex', 'agent-registration.json');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Agent registration must be a regular owned file.');
    return normalizeRegistration(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeRegistration(undefined);
    throw error;
  }
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  validateInput(input);
  const externalWorker = process.env.PSTACK_CODEX_WORKER === '1';
  const registration =
    process.platform === 'darwin' && !externalWorker && input.agent_type
      ? await readRegistration(process.env)
      : undefined;
  process.stdout.write(
    `${JSON.stringify(shellBoundaryOutput(input, { externalWorker, registration }))}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(`PSTACK_SHELL_BOUNDARY: ${error.message}\n`);
    process.exitCode = 2;
  });
