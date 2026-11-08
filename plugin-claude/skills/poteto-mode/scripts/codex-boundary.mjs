#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
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

const protocol = 'pstack-shell-boundary/v1';
const gateAbi =
  'd63e6549a63a357fac67bb936de14296de65725790b25708182ebd1e20f61aad';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function homeDirectory(options) {
  const home =
    options.codexHome ??
    options.env?.CODEX_HOME ??
    process.env.CODEX_HOME ??
    path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(home)) throw new Error('CODEX_HOME must be absolute.');
  return home;
}

function nativeRoles(roles) {
  if (
    !Array.isArray(roles) ||
    !roles.length ||
    roles.some(
      (role) => typeof role !== 'string' || !/^[A-Za-z0-9_-]+$/.test(role),
    ) ||
    new Set(roles).size !== roles.length
  )
    throw new Error(
      'Native boundary requires the actual registered role names.',
    );
  return [...roles].sort();
}

function sourceModule(source) {
  return (
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
}

function frozenProgram(source, mode, roles) {
  return `import { createHash } from 'node:crypto';
const boundary = await import(${JSON.stringify(sourceModule(source))});
if (typeof boundary.SHELL_BOUNDARY_PREFIX !== 'string' || createHash('sha256').update(boundary.SHELL_BOUNDARY_PREFIX).digest('hex') !== ${JSON.stringify(gateAbi)}) throw new Error('Unsupported shell boundary ABI.');
await boundary.runShellBoundary(${JSON.stringify({ mode, nativeRoles: roles })});
`;
}

function commandV1(interpreter, program) {
  return quote(interpreter) + ' --input-type=module --eval ' + quote(program);
}

function compileProgram(options, mode, roles = []) {
  const interpreter = options.nodeExecutable ?? process.execPath;
  if (!path.isAbsolute(interpreter))
    throw new Error('The hook Node interpreter must be absolute.');
  const source = fs.readFileSync(options.guardPath, 'utf8');
  const program = frozenProgram(source, mode, roles);
  const command = commandV1(interpreter, program);
  return {
    interpreter,
    source,
    program,
    command,
    commandSha256: digest(command),
    nativeRoles: roles,
  };
}

function guardSelfTest(options, receipt, compiled, mode) {
  options.signal?.throwIfAborted();
  const env = { ...(options.env ?? process.env) };
  delete env.PSTACK_CODEX_WORKER;
  const invoke = (args, input, extraEnv = {}) =>
    spawnSync(compiled.interpreter, args, {
      cwd: options.cwd,
      env: { ...env, ...extraEnv },
      input,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 128 * 1024,
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
      'The owned hook interpreter must run Node 24.12 or later. No task command was executed.',
    );
  const exported = invoke([
    '--input-type=module',
    '--eval',
    `const boundary = await import(${JSON.stringify(sourceModule(compiled.source))}); process.stdout.write(JSON.stringify(boundary.SHELL_BOUNDARY_PREFIX));`,
  ]);
  let prefix;
  try {
    prefix = JSON.parse(exported.stdout);
  } catch {}
  if (
    exported.status !== 0 ||
    typeof prefix !== 'string' ||
    digest(prefix) !== gateAbi
  )
    reject(
      receipt,
      'guard-self-test',
      'The frozen source does not implement the supported shell gate ABI.',
    );
  const original =
    'cat <<\'PSTACK_BOUNDARY_EOF\'\n$literal `bytes` "quotes"\nPSTACK_BOUNDARY_EOF';
  const input = (agentType) =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: original, description: 'preserve' },
      ...(agentType ? { agent_type: agentType } : {}),
    });
  const run = (agentType, extraEnv) => {
    const result = invoke(
      ['--input-type=module', '--eval', compiled.program],
      input(agentType),
      extraEnv,
    );
    try {
      if (result.status !== 0) throw new Error();
      return JSON.parse(result.stdout);
    } catch {
      reject(
        receipt,
        'guard-self-test',
        'The frozen hook did not return valid bounded output. No task command was executed.',
      );
    }
  };
  const roles =
    mode === 'native' ? compiled.nativeRoles : [undefined, 'unrelated'];
  for (const role of roles) {
    const output = run(
      role,
      mode === 'external' ? { PSTACK_CODEX_WORKER: '1' } : {},
    );
    const hook = output?.hookSpecificOutput;
    if (
      hook?.hookEventName !== 'PreToolUse' ||
      hook?.permissionDecision !== 'allow' ||
      hook?.updatedInput?.command !== prefix + original ||
      hook?.updatedInput?.description !== 'preserve'
    )
      reject(
        receipt,
        'guard-self-test',
        'The frozen hook did not preserve the exact shell gate and original input. No task command was executed.',
      );
  }
  if (
    mode === 'native' &&
    [
      run(undefined, {}),
      run('__pstack_unrelated_probe__', {}),
      run(compiled.nativeRoles[0], { PSTACK_CODEX_WORKER: '1' }),
    ].some((output) => !object(output) || Object.keys(output).length)
  )
    reject(
      receipt,
      'guard-self-test',
      'The native hook did not preserve unrelated or external worker scope.',
    );
  const stopped = spawnSync('/bin/sh', ['-c', prefix + 'exit 99'], {
    env: { ...env, CODEX_SANDBOX: 'seatbelt' },
    encoding: 'utf8',
    timeout: 3000,
  });
  if (
    stopped.status !== 125 ||
    !stopped.stderr.includes('PSTACK_REVIEW_REQUIRED')
  )
    reject(
      receipt,
      'guard-self-test',
      'The frozen hook gate did not stop a Seatbelt shell.',
    );
  receipt.selfTest = {
    status: 'passed',
    interpreter: compiled.interpreter,
    nodeVersion: runtime.version,
  };
}

function metadataDirectory(options) {
  return path.join(
    homeDirectory(options),
    'pstack-codex/native-command-boundary',
  );
}

function persistFact(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink()
  )
    throw new Error('Boundary ownership storage must be a regular directory.');
  const bytes = JSON.stringify(value) + '\n';
  const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (
        !fs.lstatSync(file).isFile() ||
        fs.lstatSync(file).isSymbolicLink() ||
        fs.readFileSync(file, 'utf8') !== bytes
      )
        throw new Error('Boundary ownership fact changed.');
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readFact(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Boundary ownership facts must be regular files.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(value))
      throw new Error('Boundary ownership facts must be objects.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readBindings(options, wantedFiles) {
  if (wantedFiles?.size === 0) return [];
  const directory = metadataDirectory(options);
  let files;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        'Boundary ownership storage must be a regular directory.',
      );
    files = fs
      .readdirSync(directory)
      .filter(
        (file) =>
          file.endsWith('.intent.json') &&
          (!wantedFiles || wantedFiles.has(file)),
      );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files
    .map((name) => {
      const file = path.join(directory, name),
        intent = readFact(file);
      if (
        intent?.schemaVersion !== 1 ||
        intent.protocol !== protocol ||
        !path.isAbsolute(intent.sourcePath ?? '') ||
        !Number.isSafeInteger(intent.groupIndex) ||
        intent.groupIndex < 0 ||
        intent.mode !== 'native' ||
        intent.wireVersion !== 1 ||
        typeof intent.source !== 'string' ||
        intent.sourceSha256 !== digest(intent.source) ||
        typeof intent.program !== 'string' ||
        intent.programSha256 !== digest(intent.program) ||
        !path.isAbsolute(intent.interpreter ?? '') ||
        intent.gateAbi !== gateAbi
      )
        throw new Error('Unsupported native boundary ownership record.');
      const roles = nativeRoles(intent.nativeRoles);
      if (JSON.stringify(roles) !== JSON.stringify(intent.nativeRoles))
        throw new Error('Native boundary scope record changed.');
      const program = intent.program,
        command = commandV1(intent.interpreter, program);
      if (
        intent.command !== command ||
        intent.commandSha256 !== digest(command) ||
        name !== intent.groupIndex + '-' + intent.commandSha256 + '.intent.json'
      )
        throw new Error('Native boundary ownership command identity changed.');
      const base = file.slice(0, -'.intent.json'.length);
      const installed = readFact(base + '.installed.json'),
        retiring = readFact(base + '.retiring.json'),
        retired = readFact(base + '.retired.json');
      for (const fact of [installed, retiring, retired])
        if (
          fact &&
          (typeof fact.key !== 'string' ||
            !fact.key ||
            (installed && fact.key !== installed.key) ||
            typeof fact.currentHash !== 'string' ||
            !fact.currentHash ||
            (installed && fact.currentHash !== installed.currentHash))
        )
          throw new Error('Invalid native boundary lifecycle fact.');
      if ((retiring || retired) && !installed)
        throw new Error('Retirement has no installed ownership fact.');
      return { ...intent, file, base, program, installed, retiring, retired };
    })
    .sort((a, b) => a.groupIndex - b.groupIndex);
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

function validateIdentity(hook, expected, receipt) {
  if (
    !hook ||
    hook.eventName !== 'preToolUse' ||
    hook.handlerType !== 'command' ||
    hook.matcher !== '^Bash$' ||
    hook.async !== false ||
    hook.timeoutSec !== 5 ||
    typeof hook.currentHash !== 'string' ||
    !hook.currentHash ||
    hook.command !== expected.command ||
    hook.key !== expected.key ||
    hook.sourcePath !== expected.sourcePath ||
    hook.source !== expected.source
  )
    reject(
      receipt,
      'wrong-hook',
      'The exact owned shell boundary descriptor changed.',
    );
  if (expected.currentHash && hook.currentHash !== expected.currentHash)
    reject(receipt, 'wrong-hash', 'The immutable shell boundary hash changed.');
  return hook;
}

function slotKey(binding) {
  return binding.sourcePath + ':pre_tool_use:' + binding.groupIndex + ':0';
}

function supportedKey(hook, sourcePath) {
  const prefix = sourcePath + ':pre_tool_use:';
  return (
    typeof hook.key === 'string' &&
    hook.key.startsWith(prefix) &&
    /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(hook.key.slice(prefix.length))
  );
}

function observeBindings(bindings, hooks, config, receipt, retiring = false) {
  return bindings.map((binding) => {
    if (binding.sourcePath !== config.file)
      reject(
        receipt,
        'source-moved',
        'Native boundary ownership belongs to another user config path.',
      );
    const matching = hooks.filter(
      (row) =>
        row.source === 'user' &&
        row.sourcePath === config.file &&
        row.command === binding.command,
    );
    if (matching.some((row) => !supportedKey(row, config.file)))
      reject(
        receipt,
        'unsupported-key-abi',
        'The owning runtime returned an unsupported user hook key format.',
      );
    const expectedKey = binding.installed?.key ?? slotKey(binding);
    const hook = hooks.find(
      (row) => row.key === expectedKey && row.source === 'user',
    );
    if (!hook || hook.command !== binding.command) {
      const shifted = hooks.some(
        (row) =>
          row.command === binding.command &&
          row.source === 'user' &&
          row.key !== expectedKey &&
          (binding.installed ||
            !bindings.some(
              (other) =>
                (other.installed?.key ?? slotKey(other)) === row.key &&
                other.command === row.command,
            )),
      );
      if (shifted)
        reject(
          receipt,
          'slot-shifted',
          'The user moved an immutable boundary entry. Restore its original slot before setup.',
        );
      if (binding.installed)
        reject(
          receipt,
          hook ? 'modified-hook' : 'removed-hook',
          'The user removed or modified an installed boundary entry. Setup will not rebuild it.',
        );
      return { binding, hook: null };
    }
    const group = config.config.hooks?.PreToolUse?.[binding.groupIndex];
    if (
      group?.matcher !== '^Bash$' ||
      group.hooks?.length !== 1 ||
      group.hooks[0].command !== binding.command
    )
      reject(receipt, 'modified-hook', 'The owned user hook position changed.');
    validateIdentity(
      hook,
      {
        ...binding,
        source: 'user',
        key: expectedKey,
        currentHash: binding.installed?.currentHash,
      },
      receipt,
    );
    const state = config.config.hooks?.state?.[hook.key];
    if (
      state?.enabled === false &&
      !binding.retiring &&
      !binding.retired &&
      !retiring
    )
      reject(
        receipt,
        'disabled-hook',
        'The user disabled the native boundary. Setup will not re-enable it.',
      );
    if (binding.retired && state?.enabled !== false)
      reject(
        receipt,
        'retired-hook-changed',
        'A retired boundary tombstone changed.',
      );
    if (
      binding.installed &&
      !binding.retiring &&
      !binding.retired &&
      !retiring &&
      (!hook.enabled || hook.trustStatus !== 'trusted')
    )
      reject(
        receipt,
        'untrusted-hook',
        'An installed native boundary is no longer active. Setup will not replace its trust.',
      );
    return { binding, hook };
  });
}

function enabledBashHook(hook) {
  if (!hook.enabled || hook.eventName !== 'preToolUse') return false;
  try {
    return !hook.matcher || new RegExp(hook.matcher).test('Bash');
  } catch {
    return true;
  }
}

function validateConflicts(hooks, allowed, receipt) {
  const conflicts = hooks.filter(
    (hook) => enabledBashHook(hook) && !allowed.has(hook.key),
  );
  receipt.conflicts = conflicts.map((hook) => hook.key);
  if (conflicts.length)
    reject(
      receipt,
      'conflicting-hook',
      'Another enabled Bash hook could replace the owned command boundary.',
    );
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
  receipt.feature = { enabled: feature?.enabled === true };
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
  const response = await client.request('config/read', {
    cwd: options.cwd,
    includeLayers: true,
  });
  if (!response.config || response.config.features?.hooks === false)
    reject(
      receipt,
      'disabled-feature',
      'The current configuration disables Codex hooks.',
    );
  const layers = response.layers?.filter(
    (layer) =>
      layer.name?.type === 'user' &&
      layer.name.file === path.join(homeDirectory(options), 'config.toml'),
  );
  if (
    layers?.length !== 1 ||
    typeof layers[0].version !== 'string' ||
    !layers[0].version ||
    !object(layers[0].config)
  )
    reject(
      receipt,
      'missing-user-layer',
      'Codex did not expose an exact versioned user configuration layer.',
    );
  const layer = layers[0];
  if (
    layer.config.hooks?.PreToolUse !== undefined &&
    !Array.isArray(layer.config.hooks.PreToolUse)
  )
    reject(
      receipt,
      'invalid-user-hooks',
      'User PreToolUse hooks must be an array.',
    );
  return {
    config: layer.config,
    file: layer.name.file,
    version: layer.version,
  };
}

async function writeConfiguration(client, config, edits) {
  return client.request('config/batchWrite', {
    edits,
    filePath: config.file,
    expectedVersion: config.version,
    reloadUserConfig: true,
  });
}

async function readHookState(client, options, receipt) {
  const config = await readConfiguration(client, options, receipt);
  const hooks = hookRows(
    await client.request('hooks/list', { cwds: [options.cwd] }),
    options.cwd,
    receipt,
  );
  return { config, hooks };
}

async function snapshot(client, options, receipt, retiring = false) {
  const state = await readHookState(client, options, receipt);
  const observed = observeBindings(
    readBindings(options),
    state.hooks,
    state.config,
    receipt,
    retiring,
  );
  return { ...state, observed };
}

async function workerSnapshot(client, options, receipt, ownCommand) {
  const state = await readHookState(client, options, receipt);
  const overlapping = state.hooks.filter(
    (hook) =>
      enabledBashHook(hook) &&
      !(hook.source === 'sessionFlags' && hook.command === ownCommand),
  );
  const candidates = overlapping.filter(
    (hook) =>
      hook.source === 'user' &&
      typeof hook.command === 'string' &&
      hook.sourcePath === state.config.file &&
      supportedKey(hook, state.config.file),
  );
  const wantedFiles = new Set(
    candidates
      .map((hook) => {
        const position = hook.key.slice(
          (state.config.file + ':pre_tool_use:').length,
        );
        const [group, handler] = position.split(':');
        return handler === '0'
          ? group + '-' + digest(hook.command) + '.intent.json'
          : null;
      })
      .filter(Boolean),
  );
  const bindings = readBindings(options, wantedFiles);
  const observed = [];
  for (const hook of candidates) {
    const binding = bindings.find(
      (binding) =>
        (binding.installed?.key ?? slotKey(binding)) === hook.key &&
        binding.sourcePath === hook.sourcePath &&
        binding.command === hook.command,
    );
    if (!binding || hook.trustStatus !== 'trusted') continue;
    const group = state.config.config.hooks?.PreToolUse?.[binding.groupIndex];
    if (
      group?.matcher !== '^Bash$' ||
      group.hooks?.length !== 1 ||
      group.hooks[0].command !== binding.command
    )
      continue;
    validateIdentity(
      hook,
      {
        ...binding,
        source: 'user',
        key: hook.key,
        currentHash: binding.installed?.currentHash,
      },
      receipt,
    );
    observed.push({ binding, hook });
  }
  return { ...state, observed };
}

function ownedHook(receipt, hook) {
  receipt.hook = {
    key: hook.key,
    command: hook.command,
    source: hook.source,
    sourcePath: hook.sourcePath,
    currentHash: hook.currentHash,
    trustStatus: hook.trustStatus,
    enabled: hook.enabled,
  };
}

function verifyNativePrograms(options, receipt, observed) {
  const selfTest = receipt.selfTest;
  for (const { binding, hook } of observed)
    if (hook) guardSelfTest(options, receipt, binding, 'native');
  receipt.selfTest = selfTest;
}

function boundaryOptions(options) {
  return {
    ...options,
    env: {
      ...(options.env ?? process.env),
      CODEX_HOME: homeDirectory(options),
    },
  };
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
    options = boundaryOptions(options);
    const compiled = compileProgram(options, 'external');
    guardSelfTest(options, commandBoundary, compiled, 'external');
    await withConfigClient(options, {}, async (client) => {
      const state = await workerSnapshot(
        client,
        options,
        commandBoundary,
        compiled.command,
      );
      await requireFeature(client, commandBoundary);
      verifyNativePrograms(options, commandBoundary, state.observed);
      validateConflicts(
        state.hooks,
        new Set(
          state.observed
            .filter((entry) => entry.hook)
            .map((entry) => entry.hook.key),
        ),
        commandBoundary,
      );
    });
    const configOverrides = {
      'features.hooks': true,
      'hooks.PreToolUse': [
        {
          matcher: '^Bash$',
          hooks: [{ type: 'command', command: compiled.command, timeout: 5 }],
        },
      ],
    };
    const hook = await withConfigClient(
      options,
      configOverrides,
      async (client) => {
        await requireFeature(client, commandBoundary);
        const state = await workerSnapshot(
          client,
          options,
          commandBoundary,
          compiled.command,
        );
        const matches = state.hooks.filter(
          (hook) =>
            hook.source === 'sessionFlags' && hook.command === compiled.command,
        );
        if (matches.length !== 1)
          reject(
            commandBoundary,
            'missing-hook',
            'The process-only boundary is missing or ambiguous.',
          );
        const hook = validateIdentity(
          matches[0],
          {
            command: compiled.command,
            key: matches[0].key,
            source: 'sessionFlags',
            sourcePath: matches[0].sourcePath,
          },
          commandBoundary,
        );
        validateConflicts(
          state.hooks,
          new Set([
            hook.key,
            ...state.observed
              .filter((entry) => entry.hook)
              .map((entry) => entry.hook.key),
          ]),
          commandBoundary,
        );
        return hook;
      },
    );
    configOverrides['hooks.state'] = {
      [hook.key]: { trusted_hash: hook.currentHash },
    };
    ownedHook(commandBoundary, hook);
    commandBoundary.status = 'prepared';
    const env = { ...options.env, PSTACK_CODEX_WORKER: '1' };
    return {
      commandBoundary,
      configOverrides,
      env,
      async preTurnPreflight(client) {
        try {
          await requireFeature(client, commandBoundary);
          const state = await workerSnapshot(
            client,
            options,
            commandBoundary,
            compiled.command,
          );
          verifyNativePrograms(options, commandBoundary, state.observed);
          const actual = validateIdentity(
            state.hooks.find(
              (row) => row.key === hook.key && row.source === 'sessionFlags',
            ),
            hook,
            commandBoundary,
          );
          if (!actual.enabled || actual.trustStatus !== 'trusted')
            reject(
              commandBoundary,
              'untrusted-hook',
              'The process boundary is disabled or untrusted.',
            );
          validateConflicts(
            state.hooks,
            new Set([
              hook.key,
              ...state.observed
                .filter((entry) => entry.hook)
                .map((entry) => entry.hook.key),
            ]),
            commandBoundary,
          );
          ownedHook(commandBoundary, actual);
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

async function retireObserved(client, state, options, receipt) {
  const active = state.observed.filter(
    ({ binding, hook }) => hook && !binding.retired,
  );
  for (const { binding, hook } of active) {
    persistFact(binding.base + '.installed.json', {
      key: hook.key,
      currentHash: hook.currentHash,
    });
    persistFact(binding.base + '.retiring.json', {
      key: hook.key,
      currentHash: hook.currentHash,
    });
  }
  const edits = active
    .filter(
      ({ hook }) =>
        state.config.config.hooks?.state?.[hook.key]?.enabled !== false,
    )
    .map(({ hook }) => ({
      keyPath: 'hooks.state.' + JSON.stringify(hook.key) + '.enabled',
      value: false,
      mergeStrategy: 'replace',
    }));
  if (edits.length) await writeConfiguration(client, state.config, edits);
  const current = await snapshot(client, options, receipt);
  for (const { binding, hook } of current.observed.filter(
    (entry) => entry.hook && entry.binding.retiring && !entry.binding.retired,
  )) {
    if (
      hook.enabled ||
      current.config.config.hooks?.state?.[hook.key]?.enabled !== false
    )
      reject(
        receipt,
        'retirement-failed',
        'The runtime did not disable the exact owned boundary key.',
      );
    persistFact(binding.base + '.retired.json', {
      key: hook.key,
      currentHash: hook.currentHash,
    });
  }
}

async function nativeBoundary(options, operation) {
  const receipt = baseReceipt(options, 'native-user-config');
  receipt.activation = 'fresh-root-session-required';
  if (receipt.requested.platform !== 'darwin') {
    receipt.status = 'notApplicable';
    return receipt;
  }
  try {
    options.signal?.throwIfAborted();
    options = boundaryOptions(options);
    return await withConfigClient(options, {}, async (client) => {
      await requireFeature(client, receipt);
      let state = await snapshot(
        client,
        options,
        receipt,
        operation === 'retire',
      );
      validateConflicts(
        state.hooks,
        new Set(
          state.observed
            .filter((entry) => entry.hook)
            .map((entry) => entry.hook.key),
        ),
        receipt,
      );
      if (operation === 'retire') {
        await retireObserved(client, state, options, receipt);
        receipt.status = 'retired';
        return receipt;
      }
      if (operation === 'inspect') {
        const latest = state.observed
          .filter((entry) => entry.hook && !entry.binding.retired)
          .at(-1);
        if (!latest) {
          receipt.status = state.observed.some((entry) => entry.binding.retired)
            ? 'retired'
            : 'missing';
          return receipt;
        }
        guardSelfTest(options, receipt, latest.binding, 'native');
        ownedHook(receipt, latest.hook);
        receipt.status = latest.binding.retiring
          ? 'retiring'
          : latest.hook.enabled && latest.hook.trustStatus === 'trusted'
            ? 'active'
            : 'untrusted';
        return receipt;
      }
      if (
        state.observed.some(
          (entry) => entry.binding.retiring && !entry.binding.retired,
        )
      ) {
        await retireObserved(client, state, options, receipt);
        state = await snapshot(client, options, receipt);
      }
      const roles = nativeRoles(
        options.nativeRoles ?? state.observed.at(-1)?.binding.nativeRoles,
      );
      const compiled = compileProgram(options, 'native', roles);
      let selected = state.observed.findLast(
        (entry) =>
          entry.hook &&
          !entry.binding.retired &&
          entry.binding.sourceSha256 === digest(compiled.source) &&
          entry.binding.interpreter === compiled.interpreter &&
          JSON.stringify(entry.binding.nativeRoles) === JSON.stringify(roles),
      );
      guardSelfTest(options, receipt, selected?.binding ?? compiled, 'native');
      if (!selected) {
        if (
          state.hooks.some(
            (hook) =>
              hook.command === compiled.command &&
              !state.observed.some((entry) => entry.hook?.key === hook.key),
          )
        )
          reject(
            receipt,
            'unowned-hook',
            'Equivalent boundary bytes without exact ownership cannot be adopted.',
          );
        const groupIndex = (state.config.config.hooks?.PreToolUse ?? []).length;
        const intent = {
          schemaVersion: 1,
          protocol,
          sourcePath: state.config.file,
          groupIndex,
          mode: 'native',
          wireVersion: 1,
          command: compiled.command,
          commandSha256: compiled.commandSha256,
          program: compiled.program,
          programSha256: digest(compiled.program),
          sourceSha256: digest(compiled.source),
          interpreter: compiled.interpreter,
          source: compiled.source,
          nativeRoles: roles,
          gateAbi: gateAbi,
        };
        const file = path.join(
          metadataDirectory(options),
          groupIndex + '-' + compiled.commandSha256 + '.intent.json',
        );
        persistFact(file, intent);
        const groups = [
          ...(state.config.config.hooks?.PreToolUse ?? []),
          {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: compiled.command, timeout: 5 }],
          },
        ];
        await writeConfiguration(client, state.config, [
          {
            keyPath: 'hooks.PreToolUse',
            value: groups,
            mergeStrategy: 'replace',
          },
        ]);
        state = await snapshot(client, options, receipt);
        selected = state.observed.find(
          (entry) => entry.binding.file === file && entry.hook,
        );
        if (!selected)
          reject(
            receipt,
            'missing-hook',
            'The appended boundary was not observed at its intended user-config slot.',
          );
      }
      const { binding, hook } = selected;
      if (hook.trustStatus !== 'trusted') {
        await writeConfiguration(client, state.config, [
          {
            keyPath:
              'hooks.state.' + JSON.stringify(hook.key) + '.trusted_hash',
            value: hook.currentHash,
            mergeStrategy: 'replace',
          },
        ]);
        state = await snapshot(client, options, receipt);
      }
      const actual = validateIdentity(
        state.hooks.find((row) => row.key === hook.key),
        { ...hook, source: 'user' },
        receipt,
      );
      if (!actual.enabled || actual.trustStatus !== 'trusted')
        reject(
          receipt,
          'untrusted-hook',
          'The exact native boundary did not become active.',
        );
      persistFact(binding.base + '.installed.json', {
        key: actual.key,
        currentHash: actual.currentHash,
      });
      ownedHook(receipt, actual);
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
  nativeBoundary(options, 'inspect');
export const trustNativeBoundary = (options) =>
  nativeBoundary(options, 'trust');
export const retireNativeBoundary = (options) =>
  nativeBoundary(options, 'retire');

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2),
      options = {};
    const operations = {
      inspect: inspectNativeBoundary,
      trust: trustNativeBoundary,
      retire: retireNativeBoundary,
    };
    const names = {
      '--cwd': 'cwd',
      '--plugin-id': 'pluginId',
      '--guard': 'guardPath',
      '--executable': 'executable',
      '--codex-home': 'codexHome',
      '--native-roles': 'nativeRoles',
    };
    if (!Object.hasOwn(operations, command))
      throw new Error(
        'Use inspect, trust or retire with --cwd and --codex-home.',
      );
    for (let index = 0; index < args.length; index += 2) {
      const name = names[args[index]],
        value = args[index + 1];
      if (!name || !value || options[name])
        throw new Error('Invalid boundary argument.');
      options[name] = name === 'nativeRoles' ? JSON.parse(value) : value;
    }
    if (
      !path.isAbsolute(options.cwd ?? '') ||
      (options.executable && !path.isAbsolute(options.executable))
    )
      throw new Error('Paths must be absolute.');
    const receipt = await operations[command](options);
    console.log(JSON.stringify(receipt, null, 2));
    if (!['active', 'retired', 'notApplicable'].includes(receipt.status))
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
