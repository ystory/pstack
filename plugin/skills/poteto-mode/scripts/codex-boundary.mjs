#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const methods = new Set([
  'config/read',
  'configRequirements/read',
  'hooks/list',
  'experimentalFeature/list',
  'config/batchWrite',
]);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function serializeToml(value) {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(serializeToml).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([key, entry]) => JSON.stringify(key) + '=' + serializeToml(entry))
        .join(',') +
      '}'
    );
  throw new Error('Unsupported TOML override value.');
}

export function boundaryConfigArgs(configOverrides = {}) {
  return Object.entries(configOverrides).flatMap(([key, value]) => [
    '-c',
    key + '=' + serializeToml(value),
  ]);
}

function reject(receipt, reason, message) {
  Object.assign(receipt, { status: 'failed', reason });
  const error = new Error(message);
  error.code = 'COMMAND_BOUNDARY_UNAVAILABLE';
  error.commandBoundary = receipt;
  throw error;
}

async function withConfigClient(options, configOverrides, action) {
  options.signal?.throwIfAborted();
  const child = spawn(
    options.executable ?? 'codex',
    [...boundaryConfigArgs(configOverrides), 'app-server'],
    {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  options.onDiagnostic?.({ event: 'boundary/spawn', pid: child.pid ?? null });
  const pending = new Map();
  let nextId = 1,
    closed = false,
    lineBuffer = '';
  const fail = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const handleLine = (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message:
                'Configuration inspection does not accept server requests.',
            },
          }) + '\n',
        );
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      options.onDiagnostic?.({
        event: 'boundary/receive',
        id: message.id,
        method: entry.method,
        outcome: message.error ? 'error' : 'ok',
      });
      pending.delete(message.id);
      if (message.error)
        entry.reject(
          Object.assign(new Error(message.error.message), {
            data: message.error,
          }),
        );
      else entry.resolve(message.result ?? {});
    } catch (error) {
      fail(error);
      child.kill();
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk;
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = lineBuffer.indexOf('\n');
    }
  });
  child.stdout.on('end', () => {
    if (lineBuffer) {
      const line = lineBuffer;
      lineBuffer = '';
      handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) =>
    options.onDiagnostic?.({
      event: 'boundary/stderr',
      bytes: Buffer.byteLength(chunk),
    }),
  );
  child.on('error', fail);
  child.stdin.on('error', fail);
  const exited = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      closed = true;
      options.onDiagnostic?.({
        event: 'boundary/exit',
        pid: child.pid ?? null,
        code,
        signal,
      });
      fail(new Error('Codex configuration connection closed.'));
      resolve();
    }),
  );
  const request = (method, params) => {
    if (method !== 'initialize' && !methods.has(method))
      throw new Error('Only boundary configuration methods are supported.');
    if (closed) throw new Error('Codex configuration connection is closed.');
    const id = nextId++;
    options.onDiagnostic?.({ event: 'boundary/send', id, method });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  const abort = () => {
    fail(options.signal.reason ?? new Error('Boundary inspection aborted.'));
    child.kill();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    fail(new Error('Codex boundary inspection timed out.'));
    child.kill();
  }, 10000);
  try {
    options.signal?.throwIfAborted();
    await request('initialize', {
      clientInfo: { name: 'pstack-boundary', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      JSON.stringify({ method: 'initialized', params: {} }) + '\n',
    );
    return await action({ request });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 50);
    await exited;
    clearTimeout(kill);
  }
}

function baseReceipt(options, scope) {
  return {
    requested: {
      platform: options.platform ?? process.platform,
      scope,
      guardPath: options.guardPath ?? null,
      pluginId: options.pluginId ?? null,
    },
    status: 'pending',
    reason: null,
    hook: null,
    feature: null,
    conflicts: [],
  };
}

function commandHandler(command) {
  const match =
    /^(node|\/[^\s'";]+|'[^']+'|"[^"$`]+")\s+(?:'([^']+)'|"([^"$`]+)"|(\/[^\s'";]+))$/.exec(
      command,
    );
  if (!match) return null;
  const interpreter = match[1].replace(/^['"]|['"]$/g, '');
  if (interpreter !== 'node') {
    try {
      if (fs.realpathSync(interpreter) !== fs.realpathSync(process.execPath))
        return null;
    } catch {
      return null;
    }
  }
  return { interpreter, guardPath: match[2] ?? match[3] ?? match[4] };
}

function guardSelfTest(options, receipt, interpreter = process.execPath) {
  options.signal?.throwIfAborted();
  const env = { ...(options.env ?? process.env), PSTACK_CODEX_WORKER: '1' };
  const invoke = (args, input) =>
    spawnSync(interpreter, args, {
      cwd: options.cwd,
      env,
      input,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  const version = invoke([
    '-p',
    'JSON.stringify({executable:process.execPath,version:process.versions.node})',
  ]);
  let runtime;
  try {
    runtime = JSON.parse(version.stdout);
  } catch {}
  const [major, minor] = String(runtime?.version).split('.').map(Number);
  if (
    version.status !== 0 ||
    !path.isAbsolute(runtime?.executable ?? '') ||
    !(major > 24 || (major === 24 && minor >= 12))
  )
    reject(
      receipt,
      'guard-self-test',
      'The owned hook interpreter must resolve to Node 24.12 or later in the receiving environment.',
    );
  const command = ': pstack-boundary-self-test';
  const tested = invoke(
    [options.guardPath],
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'pstack-boundary-self-test',
      turn_id: 'pstack-boundary-self-test',
      cwd: options.cwd,
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'pstack-boundary-self-test',
    }),
  );
  let output;
  try {
    output = JSON.parse(tested.stdout);
  } catch {}
  const hook = output?.hookSpecificOutput,
    wrapped = hook?.updatedInput?.command;
  if (
    tested.status !== 0 ||
    hook?.hookEventName !== 'PreToolUse' ||
    hook?.permissionDecision !== 'allow' ||
    typeof wrapped !== 'string' ||
    wrapped === command ||
    !wrapped.endsWith(command) ||
    !['CODEX_SANDBOX', 'seatbelt', 'exit 125', 'PSTACK_REVIEW_REQUIRED'].every(
      (marker) => wrapped.slice(0, -command.length).includes(marker),
    )
  )
    reject(
      receipt,
      'guard-self-test',
      'The exact owned hook failed its bounded shell-boundary self-test. No task command was executed.',
    );
  receipt.selfTest = {
    status: 'passed',
    interpreter: runtime.executable,
    nodeVersion: runtime.version,
  };
}

function sameGuard(hook, guardPath) {
  if (
    !hook.pluginId?.startsWith('pstack-codex@') &&
    !hook.pluginId?.startsWith('pstack-cc@')
  )
    return false;
  const candidate = commandHandler(hook.command ?? '')?.guardPath;
  if (!candidate || path.basename(candidate) !== 'shell-boundary.mjs')
    return false;
  try {
    return fs.readFileSync(candidate).equals(fs.readFileSync(guardPath));
  } catch {
    return false;
  }
}

function hookRows(response, cwd, receipt) {
  const rows = response.data?.filter((entry) => entry.cwd === cwd);
  if (
    rows?.length !== 1 ||
    !Array.isArray(rows[0].hooks) ||
    rows[0].errors?.length
  )
    reject(
      receipt,
      'hook-list-error',
      'Codex did not return an unambiguous hook list for this worktree.',
    );
  return rows[0].hooks;
}

function validateHooks(response, options, receipt, expected, requireTrusted) {
  const hooks = hookRows(response, options.cwd, receipt);
  const matches = hooks.filter((hook) =>
    options.pluginId
      ? hook.pluginId === options.pluginId &&
        hook.eventName === 'preToolUse' &&
        hook.matcher === '^Bash$'
      : hook.source === 'sessionFlags' && hook.command === options.command,
  );
  if (matches.length !== 1)
    reject(
      receipt,
      'missing-hook',
      'The exact owned shell boundary hook is missing or ambiguous.',
    );
  const hook = matches[0];
  receipt.hook = hook;
  if (
    hook.eventName !== 'preToolUse' ||
    hook.handlerType !== 'command' ||
    hook.matcher !== '^Bash$' ||
    hook.async !== false ||
    hook.timeoutSec !== 5 ||
    typeof hook.key !== 'string' ||
    !/^sha256:[a-f0-9]{64}(?:\/sha256:[a-f0-9]{64})?$/.test(
      hook.currentHash ?? '',
    )
  )
    reject(
      receipt,
      'wrong-hook',
      'The owned shell boundary hook identity is invalid.',
    );
  if (
    options.pluginId &&
    (hook.source !== 'plugin' ||
      commandHandler(hook.command)?.guardPath !== options.guardPath)
  )
    reject(
      receipt,
      'wrong-hook',
      'The installed hook does not point to the requested guard.',
    );
  if (
    expected &&
    (hook.key !== expected.key ||
      hook.currentHash !== expected.currentHash ||
      hook.command !== expected.command ||
      hook.sourcePath !== expected.sourcePath)
  )
    reject(
      receipt,
      'wrong-hash',
      'The shell boundary hook changed after trust discovery.',
    );
  if (requireTrusted && hook.trustStatus !== 'trusted')
    reject(
      receipt,
      'untrusted-hook',
      'The owned shell boundary hook is not trusted.',
    );
  if (
    hook.enabled !== true &&
    (requireTrusted || hook.trustStatus === 'trusted')
  )
    reject(
      receipt,
      'disabled-hook',
      'The owned shell boundary hook is disabled.',
    );
  if (!['trusted', 'untrusted', 'modified'].includes(hook.trustStatus))
    reject(
      receipt,
      'untrusted-hook',
      'The owned shell boundary hook cannot be trusted in this configuration.',
    );
  const conflicts = hooks.filter((other) => {
    if (
      other.key === hook.key ||
      other.eventName !== 'preToolUse' ||
      !other.enabled
    )
      return false;
    let matchesBash;
    try {
      matchesBash = !other.matcher || new RegExp(other.matcher).test('Bash');
    } catch {
      matchesBash = true;
    }
    return (
      matchesBash &&
      !(
        other.handlerType === 'command' &&
        other.matcher === '^Bash$' &&
        other.async === false &&
        sameGuard(other, options.guardPath)
      )
    );
  });
  receipt.conflicts = conflicts.map((entry) => entry.key);
  if (conflicts.length)
    reject(
      receipt,
      'conflicting-hook',
      'Another enabled Bash hook could replace the owned command boundary.',
    );
  return hook;
}

async function requireFeature(client, receipt) {
  let cursor = null,
    feature = null;
  const seen = new Set();
  do {
    const page = await client.request('experimentalFeature/list', {
      cursor,
      limit: 100,
    });
    feature ??= page.data?.find((entry) => entry.name === 'hooks');
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor))
      reject(
        receipt,
        'feature-list-error',
        'Codex repeated the feature pagination cursor.',
      );
    seen.add(cursor);
  } while (cursor);
  receipt.feature = feature;
  if (feature?.enabled !== true)
    reject(
      receipt,
      'disabled-feature',
      'Codex hooks are unavailable or disabled.',
    );
}

async function readConfiguration(client, options, receipt) {
  const requirements = (await client.request('configRequirements/read', {}))
    .requirements;
  if (
    requirements?.featureRequirements?.hooks === false ||
    requirements?.feature_requirements?.hooks === false ||
    requirements?.allowManagedHooksOnly === true ||
    requirements?.allow_managed_hooks_only === true
  )
    reject(
      receipt,
      'managed-disabled',
      'Managed policy does not permit the pstack command boundary.',
    );
  const { config } = await client.request('config/read', {
    cwd: options.cwd,
    includeLayers: false,
  });
  if (!config || config.features?.hooks === false)
    reject(
      receipt,
      'disabled-feature',
      'The current configuration disables Codex hooks.',
    );
  return config;
}

export async function prepareWorkerBoundary(options) {
  const commandBoundary = baseReceipt(options, 'worker-process');
  if (commandBoundary.requested.platform !== 'darwin') {
    commandBoundary.status = 'notApplicable';
    return {
      commandBoundary,
      configOverrides: {},
      env: options.env ?? process.env,
    };
  }
  try {
    fs.readFileSync(options.guardPath);
    guardSelfTest(options, commandBoundary);
    const command = quote(process.execPath) + ' ' + quote(options.guardPath);
    const identity = { ...options, command };
    await withConfigClient(options, {}, (client) =>
      readConfiguration(client, options, commandBoundary),
    );
    const configOverrides = {
      'features.hooks': true,
      'hooks.PreToolUse': [
        {
          matcher: '^Bash$',
          hooks: [{ type: 'command', command, timeout: 5 }],
        },
      ],
    };
    const hook = await withConfigClient(
      options,
      configOverrides,
      async (client) => {
        await requireFeature(client, commandBoundary);
        return validateHooks(
          await client.request('hooks/list', { cwds: [options.cwd] }),
          identity,
          commandBoundary,
          null,
          false,
        );
      },
    );
    configOverrides['hooks.state'] = {
      [hook.key]: {
        trusted_hash: hook.currentHash,
      },
    };
    commandBoundary.status = 'prepared';
    const env = { ...(options.env ?? process.env), PSTACK_CODEX_WORKER: '1' };
    return {
      commandBoundary,
      configOverrides,
      env,
      async preTurnPreflight(client) {
        try {
          await requireFeature(client, commandBoundary);
          validateHooks(
            await client.request('hooks/list', { cwds: [options.cwd] }),
            identity,
            commandBoundary,
            hook,
            true,
          );
          commandBoundary.status = 'active';
        } catch (error) {
          if (!error.commandBoundary)
            reject(commandBoundary, 'preflight-error', error.message);
          throw error;
        }
      },
    };
  } catch (error) {
    if (!error.commandBoundary)
      reject(commandBoundary, 'preflight-error', error.message);
    throw error;
  }
}

async function nativeBoundary(options, trust) {
  const receipt = baseReceipt(options, 'native-plugin');
  if (receipt.requested.platform !== 'darwin') {
    receipt.status = 'notApplicable';
    return receipt;
  }
  try {
    if (!options.pluginId || !path.isAbsolute(options.guardPath ?? ''))
      reject(
        receipt,
        'invalid-identity',
        'Native inspection requires an exact plugin ID and absolute guard path.',
      );
    return await withConfigClient(options, {}, async (client) => {
      fs.readFileSync(options.guardPath);
      const config = await readConfiguration(client, options, receipt);
      await requireFeature(client, receipt);
      const hook = validateHooks(
        await client.request('hooks/list', { cwds: [options.cwd] }),
        options,
        receipt,
        null,
        false,
      );
      guardSelfTest(options, receipt, commandHandler(hook.command).interpreter);
      if (config.hooks?.state?.[hook.key]?.disabled === true)
        reject(receipt, 'disabled-hook', 'The user disabled the owned hook.');
      if (!trust) {
        receipt.status =
          hook.enabled && hook.trustStatus === 'trusted'
            ? 'active'
            : 'untrusted';
        return receipt;
      }
      await client.request('config/batchWrite', {
        edits: [
          {
            keyPath:
              'hooks.state.' + JSON.stringify(hook.key) + '.trusted_hash',
            value: hook.currentHash,
            mergeStrategy: 'replace',
          },
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      });
      validateHooks(
        await client.request('hooks/list', { cwds: [options.cwd] }),
        options,
        receipt,
        hook,
        true,
      );
      receipt.status = 'active';
      return receipt;
    });
  } catch (error) {
    if (!error.commandBoundary)
      reject(receipt, 'preflight-error', error.message);
    throw error;
  }
}

export const inspectNativeBoundary = (options) =>
  nativeBoundary(options, false);
export const trustNativeBoundary = (options) => nativeBoundary(options, true);

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2),
      options = {};
    const names = {
      '--cwd': 'cwd',
      '--plugin-id': 'pluginId',
      '--guard': 'guardPath',
      '--executable': 'executable',
    };
    if (!['inspect', 'trust'].includes(command))
      throw new Error(
        'Use inspect or trust with --cwd, --plugin-id and --guard.',
      );
    for (let index = 0; index < args.length; index += 2) {
      const name = names[args[index]],
        value = args[index + 1];
      if (!name || !value || options[name])
        throw new Error('Invalid boundary inspection argument.');
      options[name] = value;
    }
    if (
      !path.isAbsolute(options.cwd ?? '') ||
      (options.executable && !path.isAbsolute(options.executable))
    )
      throw new Error('Paths must be absolute.');
    const receipt = await (command === 'trust'
      ? trustNativeBoundary(options)
      : inspectNativeBoundary(options));
    console.log(JSON.stringify(receipt, null, 2));
    if (!['active', 'notApplicable'].includes(receipt.status))
      process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        error.commandBoundary ?? { status: 'failed', reason: error.message },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
