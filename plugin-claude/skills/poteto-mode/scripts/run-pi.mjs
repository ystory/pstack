#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  piEntry,
  piCapability,
  piEfforts,
  routeKey,
  piMinimumVersion,
  supportedPiVersion,
} from './pi-route.mjs';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const builtins = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function closedWithin(closed, ms) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const contains = (root, file) =>
  file === root || file.startsWith(`${root}${path.sep}`);

class PiFailure extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

function optionsFor(argv) {
  const options = { command: argv[0], instruction: [], skill: [] };
  if (['--help', '-h'].includes(argv[0])) return { command: 'help' };
  if (!['run', 'catalog'].includes(options.command))
    throw new Error('Choose run or catalog.');
  const names = {
    '--cwd': 'cwd',
    '--run-dir': 'runDir',
    '--provider': 'provider',
    '--model': 'model',
    '--effort': 'effort',
    '--tools': 'tools',
    '--role': 'role',
    '--instruction': 'instruction',
    '--skill': 'skill',
    '--resume': 'resume',
    '--prompt-file': 'promptFile',
    '--executable': 'executable',
    '--timeout-ms': 'timeoutMs',
    '--startup-timeout-ms': 'startupTimeoutMs',
    '--command-timeout-ms': 'commandTimeoutMs',
    '--shutdown-grace-ms': 'shutdownGraceMs',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const key = names[argv[index]];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith('--'))
      throw new Error(`Invalid option ${argv[index]}.`);
    if (Array.isArray(options[key])) options[key].push(value);
    else if (options[key] !== undefined)
      throw new Error(`Repeated option ${argv[index]}.`);
    else options[key] = value;
  }
  for (const [key, fallback] of Object.entries({
    startupTimeoutMs: 30000,
    commandTimeoutMs: 15000,
    shutdownGraceMs: 5000,
    timeoutMs: null,
  })) {
    if (options[key] === undefined) options[key] = fallback;
    else {
      options[key] = Number(options[key]);
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new Error(`${key} must be a positive integer.`);
    }
  }
  if (options.command === 'run') {
    options.requested = piEntry({
      executor: 'pi',
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.effort,
    });
    if (!options.tools)
      throw new Error(
        'run requires --tools with an explicit built-in tool selection, or none.',
      );
    const tools = options.tools === 'none' ? [] : options.tools.split(',');
    if (
      tools.some((tool) => !builtins.has(tool)) ||
      new Set(tools).size !== tools.length
    )
      throw new Error('Choose exact, distinct built-in Pi tools.');
    options.toolList = tools;
  } else if (
    options.resume ||
    options.model ||
    options.provider ||
    options.effort ||
    options.tools ||
    options.role ||
    options.instruction.length ||
    options.skill.length ||
    options.promptFile
  )
    throw new Error(
      'catalog accepts only paths, executable and deadline options.',
    );
  return options;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value))
    throw new Error(`${label} requires an absolute path.`);
  return path.resolve(value);
}

async function regular(file) {
  absolute(file, 'File');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Expected a regular canonical file: ${file}`);
  return fs.readFile(file);
}

async function canonicalNew(file) {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(
      await canonicalNew(path.dirname(file)),
      path.basename(file),
    );
  }
}

async function preparePaths(options) {
  if (process.platform === 'win32')
    throw new PiFailure(
      'capability',
      'Pi process group ownership requires a POSIX host.',
    );
  const cwd = await fs.realpath(absolute(options.cwd, '--cwd'));
  if (!(await fs.stat(cwd)).isDirectory())
    throw new Error('--cwd requires a directory.');
  const runDir = await canonicalNew(absolute(options.runDir, '--run-dir'));
  const roots = [
    pluginRoot,
    path.resolve(pluginRoot, '../plugin'),
    path.resolve(pluginRoot, '../plugin-claude'),
  ];
  if (roots.some((root) => contains(root, runDir)))
    throw new Error('--run-dir must be outside plugin trees.');
  try {
    await fs.lstat(runDir);
    throw new Error('--run-dir already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { cwd, runDir };
}

async function readBrief() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function promptFor(options) {
  const contexts = [];
  for (const [kind, files] of [
    ['role', options.role ? [options.role] : []],
    ['instruction', options.instruction],
    ['skill', options.skill],
  ]) {
    for (const file of files) {
      const bytes = await regular(file);
      contexts.push({
        kind,
        path: file,
        sha256: hash(bytes),
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      });
    }
  }
  const workerFile = fileURLToPath(
    new URL('../references/worker-context.md', import.meta.url),
  );
  const worker = await regular(workerFile);
  const brief = options.promptFile
    ? await regular(options.promptFile)
    : await readBrief();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(brief);
  if (!text.trim()) throw new Error('A nonempty task brief is required.');
  return {
    prompt: [
      'Receiving executor: pi. You are a Pi worker. Native parent subagent tools, MCP, permissions and full conversation are not inherited. Pi has no established native nested delegation. Report required missing capabilities.',
      worker.toString('utf8'),
      ...contexts.map(
        (context) =>
          `Complete ${context.kind} body from ${context.path}\n${context.text}`,
      ),
      `Task\n${text}`,
    ].join('\n\n'),
    contexts: [
      ...contexts.map(({ text: _text, ...entry }) => entry),
      { kind: 'receiving-context', path: workerFile, sha256: hash(worker) },
    ],
    briefSha256: hash(brief),
  };
}

function selectedState(state) {
  return {
    provider:
      typeof state?.model?.provider === 'string' ? state.model.provider : null,
    model: typeof state?.model?.id === 'string' ? state.model.id : null,
    reasoningEffort: state?.thinkingLevel ?? null,
    sessionId: state?.sessionId ?? null,
    sessionFile: state?.sessionFile ?? null,
    isStreaming: state?.isStreaming ?? null,
    isCompacting: state?.isCompacting ?? null,
    pendingMessageCount: state?.pendingMessageCount ?? null,
  };
}

function safeRecord(record) {
  if (record.type !== 'response') return record;
  const base = {
    type: 'response',
    id: record.id,
    command: record.command,
    success: record.success,
  };
  if (!record.success)
    return {
      ...base,
      error:
        'Pi rejected the command. See the structured rejection in result.json.',
    };
  if (record.command === 'get_state')
    return { ...base, data: selectedState(record.data) };
  if (record.command === 'set_model')
    return {
      ...base,
      data: { provider: record.data?.provider, id: record.data?.id },
    };
  if (record.command === 'get_available_models')
    return {
      ...base,
      data: {
        models: record.data?.models?.map((model) => ({
          provider: model.provider,
          id: model.id,
        })),
      },
    };
  return { ...base, data: record.data };
}

function commandFailure(record) {
  const message = typeof record.error === 'string' ? record.error : '';
  const kind =
    /no api key|authenticat|oauth|unauthorized|invalid_refresh_token|credential/i.test(
      message,
    )
      ? 'authentication'
      : /^model not found(?:[.:\s]|$)/i.test(message)
        ? 'model-not-found'
        : 'command-rejected';
  return new PiFailure(
    kind,
    kind === 'authentication'
      ? 'Pi authentication is unavailable for this command.'
      : kind === 'model-not-found'
        ? 'Pi could not find the exact model.'
        : `Pi rejected ${record.command}.`,
    { command: record.command },
  );
}

function assertSelected(selected, requested) {
  if (
    selected.provider !== requested.provider ||
    selected.model !== requested.model ||
    selected.reasoningEffort !== requested.reasoningEffort
  )
    throw new PiFailure(
      'selection-changed',
      'Pi changed the exact route or effort during the task.',
      { selected },
    );
  if (
    selected.isStreaming !== false ||
    selected.isCompacting !== false ||
    selected.pendingMessageCount !== 0
  )
    throw new PiFailure(
      'interference',
      'Pi has active or queued work after settlement.',
    );
}

class RpcProcess {
  constructor(executable, args, options, onEvent) {
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
    this.failure = null;
    this.exit = null;
    this.closing = false;
    this.stdoutFd = openSync(
      path.join(options.runDir, 'events.jsonl'),
      'wx',
      0o600,
    );
    this.stderrFd = openSync(
      path.join(options.runDir, 'stderr.txt'),
      'wx',
      0o600,
    );
    this.failed = new Promise((_, reject) => {
      this.rejectFailure = reject;
    });
    this.failed.catch(() => {});
    this.child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.buffer = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    this.child.stdout.on('data', (chunk) => {
      try {
        this.buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          if (
            Buffer.byteLength(line) > 8 * 1024 * 1024 ||
            !line ||
            line.endsWith('\r')
          )
            throw new Error('Expected bounded LF JSONL records.');
          const record = JSON.parse(line);
          if (
            !record ||
            typeof record !== 'object' ||
            Array.isArray(record) ||
            typeof record.type !== 'string'
          )
            throw new Error('Invalid RPC record.');
          writeSync(this.stdoutFd, `${JSON.stringify(safeRecord(record))}\n`);
          if (record.type === 'response') {
            const pending = this.pending.get(record.id);
            if (!pending || pending.type !== record.command)
              throw new Error('Unexpected or mismatched RPC response.');
            this.pending.delete(record.id);
            clearTimeout(pending.timer);
            if (record.success === true) pending.resolve(record.data);
            else pending.reject(commandFailure(record));
          } else if (record.type === 'extension_ui_request')
            throw new PiFailure(
              'capability',
              'Unexpected Pi extension UI request.',
            );
          else onEvent(record);
        }
        if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024)
          throw new Error('RPC record exceeds the framing limit.');
      } catch (error) {
        this.fail(
          error instanceof PiFailure
            ? error
            : new PiFailure(
                'protocol',
                error instanceof SyntaxError
                  ? 'Invalid Pi RPC JSON record.'
                  : error.message,
              ),
        );
      }
    });
    this.child.stdout.on('end', () => {
      try {
        this.buffer += decoder.decode();
        if (this.buffer)
          this.fail(
            new PiFailure(
              'protocol',
              'Pi closed with an unterminated JSONL record.',
            ),
          );
      } catch (error) {
        this.fail(
          new PiFailure(
            'protocol',
            error instanceof SyntaxError
              ? 'Invalid Pi RPC JSON record.'
              : error.message,
          ),
        );
      }
    });
    for (const stream of [
      this.child.stdout,
      this.child.stderr,
      this.child.stdin,
    ])
      stream.on('error', (error) =>
        this.fail(new PiFailure('stream', error.message)),
      );
    this.child.stderr.on('data', (chunk) => {
      try {
        writeSync(this.stderrFd, chunk);
      } catch (error) {
        this.fail(new PiFailure('artifact', error.message));
      }
    });
    this.child.on('error', (error) =>
      this.fail(new PiFailure('spawn', error.message)),
    );
    this.child.on('close', (exitCode, signal) => {
      this.exit = { exitCode, signal };
      if (!this.closing)
        this.fail(
          new PiFailure(
            'process-exit',
            'Pi exited before the owned task closed.',
            this.exit,
          ),
        );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new PiFailure('process-exit', 'Pi exited during an RPC command.'),
        );
      }
      this.pending.clear();
      closeSync(this.stdoutFd);
      closeSync(this.stderrFd);
      this.resolveClosed(this.exit);
    });
  }

  fail(error) {
    this.failure ??= error;
    this.rejectFailure(this.failure);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  request(
    type,
    body = {},
    timeoutMs = this.options.commandTimeoutMs,
    cleanup = false,
  ) {
    if (this.failure && !cleanup) return Promise.reject(this.failure);
    if (
      this.exit ||
      this.child.stdin.destroyed ||
      this.child.stdin.writableEnded
    )
      return Promise.reject(
        new PiFailure('process-exit', 'Pi input is closed.'),
      );
    const id = `pstack-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new PiFailure(
          'command-timeout',
          `Pi ${type} deadline expired.`,
          { command: type },
        );
        reject(error);
        if (!cleanup) this.fail(error);
      }, timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ id, type, ...body })}\n`,
        (error) => {
          if (error) this.fail(new PiFailure('stdin', error.message));
        },
      );
    });
  }

  async close(cancel) {
    this.closing = true;
    if (cancel && !this.exit) {
      for (const command of ['clear_queue', 'abort']) {
        await Promise.race([
          this.request(
            command,
            {},
            Math.min(1000, this.options.shutdownGraceMs),
            true,
          ).catch(() => {}),
          this.closed,
        ]);
      }
    }
    this.child.stdin.end();
    let shutdown = 'orderly';
    if (
      !this.exit &&
      !(await closedWithin(this.closed, this.options.shutdownGraceMs))
    ) {
      shutdown = 'forced';
      this.signalGroup('SIGTERM');
      if (!(await closedWithin(this.closed, 2000))) {
        this.signalGroup('SIGKILL');
        if (!(await closedWithin(this.closed, 2000))) shutdown = 'unconfirmed';
      }
    }
    if (shutdown !== 'unconfirmed') await this.closed;
    if (this.groupExists()) {
      shutdown = 'forced';
      this.signalGroup('SIGTERM');
      await delay(50);
      if (this.groupExists()) this.signalGroup('SIGKILL');
      for (let attempt = 0; attempt < 20 && this.groupExists(); attempt += 1)
        await delay(50);
      if (this.groupExists()) shutdown = 'unconfirmed';
    }
    return {
      pid: this.child.pid ?? null,
      ...(this.exit ?? { exitCode: null, signal: null }),
      shutdown,
    };
  }

  signalGroup(signal) {
    if (!this.child.pid) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH')
        this.fail(new PiFailure('shutdown', error.message));
    }
  }

  groupExists() {
    if (!this.child.pid) return false;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  }
}

function currentTurn() {
  const state = {
    userSeen: false,
    assistant: null,
    settled: null,
    usage: null,
  };
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    state,
    done,
    event(record) {
      if (record.type === 'message_start' && record.message?.role === 'user') {
        if (state.userSeen)
          throw new PiFailure('interference', 'Unexpected second user turn.');
        state.userSeen = true;
      }
      if (
        record.type === 'message_end' &&
        record.message?.role === 'assistant' &&
        state.userSeen
      ) {
        const message = record.message;
        const usage = usageFor(message.usage);
        state.usage = addUsage(state.usage, usage);
        state.assistant = {
          stopReason: message.stopReason ?? null,
          error: Boolean(message.errorMessage),
          provider:
            typeof message.provider === 'string' ? message.provider : null,
          model: typeof message.model === 'string' ? message.model : null,
          text: Array.isArray(message.content)
            ? message.content
                .filter(
                  (block) =>
                    block.type === 'text' && typeof block.text === 'string',
                )
                .map((block) => block.text)
                .join('\n')
            : '',
          usage,
        };
      }
      if (record.type === 'agent_settled') {
        state.settled = { aborted: record.aborted };
        finish();
      }
    },
  };
}

function addUsage(total, usage) {
  if (!usage) return total;
  const sum = total ?? { source: 'pi-provider-estimate', assistantMessages: 0 };
  sum.assistantMessages += 1;
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'cost') {
      sum.cost ??= {};
      for (const [name, amount] of Object.entries(value))
        sum.cost[name] = (sum.cost[name] ?? 0) + amount;
    } else sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}

function usageFor(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'totalTokens',
  ])
    if (Number.isFinite(usage[key])) result[key] = usage[key];
  if (usage.cost && typeof usage.cost === 'object') {
    result.cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'])
      if (Number.isFinite(usage.cost[key])) result.cost[key] = usage.cost[key];
  }
  return result;
}

function verdict(turn) {
  if (!turn.userSeen)
    throw new PiFailure('terminal', 'No new user turn was observed.');
  if (turn.settled?.aborted !== false)
    throw new PiFailure('terminal', 'Pi did not settle without an abort.');
  const assistant = turn.assistant;
  if (
    !assistant ||
    assistant.stopReason !== 'stop' ||
    assistant.error ||
    !assistant.text.trim()
  )
    throw new PiFailure(
      'terminal',
      'Pi settled without a nonempty successful current-turn assistant answer.',
      { stopReason: assistant?.stopReason ?? null },
    );
  return assistant.text;
}

async function sessionSnapshot(state, cwd) {
  if (
    typeof state?.sessionFile !== 'string' ||
    !state.sessionFile ||
    typeof state.sessionId !== 'string' ||
    !state.sessionId
  )
    return null;
  const file = absolute(state.sessionFile, 'Pi session');
  if ((await canonicalNew(file)) !== file)
    throw new PiFailure(
      'session',
      'Pi persisted session path is not canonical.',
    );
  let bytes;
  try {
    bytes = await regular(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let header;
  try {
    header = JSON.parse(bytes.toString('utf8').split('\n')[0]);
  } catch {
    throw new PiFailure('session', 'Pi session header is invalid.');
  }
  if (
    header.type !== 'session' ||
    header.id !== state.sessionId ||
    header.cwd !== cwd
  )
    throw new PiFailure(
      'session',
      'Pi persisted session identity does not match the selected state.',
    );
  return { id: header.id, file, cwd, sha256: hash(bytes) };
}

function resumability(selected, requested, session, closure) {
  if (!session)
    return { available: false, reason: 'No verified persisted session.' };
  if (
    !closure ||
    !['orderly', 'forced'].includes(closure.shutdown) ||
    !Number.isInteger(closure.pid) ||
    (closure.exitCode === null && !closure.signal)
  )
    return {
      available: false,
      reason: 'Owned process closure is unconfirmed.',
    };
  if (
    !requested ||
    !selected ||
    selected.provider !== requested.provider ||
    selected.model !== requested.model ||
    selected.reasoningEffort !== requested.reasoningEffort
  )
    return {
      available: false,
      reason:
        'The final selected route and effort were not verified for continuation. Prior receipt hashes may have changed.',
    };
  return {
    available: true,
    reason:
      'Exact selected route, persisted session and process closure are recorded.',
  };
}

async function resumeFor(options) {
  if (!options.resume) return null;
  const prior = JSON.parse(
    (await regular(absolute(options.resume, '--resume'))).toString('utf8'),
  );
  if (
    prior.executor !== 'pi' ||
    !prior.session ||
    !['completed', 'failed', 'rejected', 'interrupted', 'timed-out'].includes(
      prior.status,
    ) ||
    JSON.stringify(prior.requested) !== JSON.stringify(options.requested) ||
    prior.session.cwd !== options.cwd ||
    !resumability(prior.selected, prior.requested, prior.session, prior.process)
      .available
  )
    throw new PiFailure(
      'resume',
      'Resume requires the exact terminal Pi receipt, route, effort, canonical cwd and confirmed process closure.',
    );
  const session = await sessionSnapshot(
    { sessionFile: prior.session.file, sessionId: prior.session.id },
    options.cwd,
  );
  if (!session || session.sha256 !== prior.session.sha256)
    throw new PiFailure(
      'resume',
      'The persisted Pi session is missing or changed.',
    );
  const lease = `${session.file}.pstack-lease`;
  let handle;
  try {
    handle = await fs.open(lease, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new PiFailure(
        'session-lease',
        'Another continuation owns the Pi session lease.',
      );
    throw error;
  }
  try {
    await handle.writeFile(
      json({
        pid: process.pid,
        receipt: options.resume,
        runDir: options.runDir,
      }),
    );
    await handle.close();
    const locked = await sessionSnapshot(
      { sessionFile: session.file, sessionId: session.id },
      options.cwd,
    );
    if (!locked || locked.sha256 !== session.sha256)
      throw new PiFailure(
        'resume',
        'Pi session changed before its exclusive continuation lease.',
      );
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(lease);
    throw error;
  }
  return { ...session, lease };
}

async function selectRoute(rpc, route) {
  try {
    await rpc.request('set_model', {
      provider: route.provider,
      modelId: route.model,
    });
  } catch (error) {
    if (error.kind === 'model-not-found')
      throw new PiFailure(
        'model-rejected',
        'Pi rejected the exact provider and model.',
        { provider: route.provider, model: route.model },
      );
    throw error;
  }
  const state = selectedState(await rpc.request('get_state'));
  if (state.provider !== route.provider || state.model !== route.model)
    throw new PiFailure(
      'selection-changed',
      'Pi selected a different provider or model.',
      { selected: state },
    );
  return state;
}

async function selectEffort(rpc, requested) {
  await selectRoute(rpc, requested);
  const levels = (await rpc.request('get_available_thinking_levels'))?.levels;
  if (
    !Array.isArray(levels) ||
    !levels.length ||
    levels.some((level) => !piEfforts.includes(level))
  )
    throw new PiFailure(
      'protocol',
      'Pi reported invalid supported thinking levels.',
    );
  if (!levels.includes(requested.reasoningEffort))
    throw new PiFailure(
      'effort-rejected',
      'Pi does not support the requested effort.',
      { availableLevels: levels },
    );
  try {
    await rpc.request('set_thinking_level', {
      level: requested.reasoningEffort,
    });
  } catch (error) {
    if (error.kind === 'command-rejected')
      throw new PiFailure(
        'effort-rejected',
        'Pi rejected the requested effort.',
        { availableLevels: levels },
      );
    throw error;
  }
  const selected = selectedState(await rpc.request('get_state'));
  if (
    selected.provider !== requested.provider ||
    selected.model !== requested.model
  )
    throw new PiFailure('selection-changed', 'Pi changed the selected route.', {
      selected,
    });
  if (selected.reasoningEffort !== requested.reasoningEffort)
    throw new PiFailure('effort-rejected', 'Pi clamped the requested effort.', {
      availableLevels: levels,
      selected,
    });
  if (
    selected.isStreaming !== false ||
    selected.isCompacting !== false ||
    selected.pendingMessageCount !== 0
  )
    throw new PiFailure('interference', 'Pi is not idle before the task.');
  return selected;
}

async function catalogFor(rpc, version) {
  const available = (await rpc.request('get_available_models'))?.models;
  if (!Array.isArray(available) || !available.length)
    throw new PiFailure('capability', 'Pi has no available configured models.');
  const models = [];
  const seen = new Set();
  for (const model of available) {
    const route = { executor: 'pi', provider: model.provider, model: model.id };
    const key = routeKey(route);
    if (seen.has(key))
      throw new PiFailure('protocol', 'Pi returned a duplicate model route.');
    seen.add(key);
    await selectRoute(rpc, route);
    const levels = (await rpc.request('get_available_thinking_levels'))?.levels;
    models.push(
      piCapability({
        ...route,
        supportedReasoningEfforts: levels,
        runtimeVersion: version,
        source: {
          kind: 'host',
          description: `Pi ${version} RPC exact selection and per-model thinking levels. Configured availability, inference unverified.`,
        },
      }),
    );
  }
  return { models };
}

async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function execute(options) {
  Object.assign(options, await preparePaths(options));
  const delivered = options.command === 'run' ? await promptFor(options) : null;
  const resumed = await resumeFor(options);
  let rpc;
  let timer;
  let interrupted = null;
  const cancel = (signal) => {
    interrupted ??= new PiFailure(
      signal === 'timeout' ? 'timed-out' : 'interrupted',
      `Pi task ${signal === 'timeout' ? 'deadline expired' : `received ${signal}`}.`,
    );
    rpc?.fail(interrupted);
  };
  const onInt = () => cancel('SIGINT');
  const onTerm = () => cancel('SIGTERM');
  try {
    await fs.mkdir(path.dirname(options.runDir), { recursive: true });
    await fs.mkdir(options.runDir, { mode: 0o700 });
    const executable = options.executable
      ? absolute(options.executable, '--executable')
      : 'pi';
    const versionProbe = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: options.startupTimeoutMs,
      maxBuffer: 4096,
    });
    const version =
      versionProbe.status === 0 ? versionProbe.stdout.trim() : null;
    const args = [
      '--mode',
      'rpc',
      '--offline',
      '--no-extensions',
      '--no-mcp',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-approve',
    ];
    if (options.command === 'catalog') args.push('--no-session', '--no-tools');
    else {
      if (options.toolList.length)
        args.push('--tools', options.toolList.join(','));
      else args.push('--no-tools');
      if (resumed) args.push('--session', resumed.file);
      else args.push('--session-dir', path.join(options.runDir, 'sessions'));
    }
    const request = {
      schemaVersion: 1,
      executor: 'pi',
      command: options.command,
      executable,
      version,
      cwd: options.cwd,
      requested: options.requested ?? null,
      tools: options.toolList ?? [],
      resumeReceipt: options.resume ?? null,
      args,
      contexts: delivered?.contexts ?? [],
      promptSha256: delivered ? hash(delivered.prompt) : null,
      briefSha256: delivered?.briefSha256 ?? null,
      capabilities: {
        nativeDelegation: false,
        inheritedMcp: false,
        inheritedConversation: false,
        osReadOnlyEnforcement: false,
      },
      startedAt: new Date().toISOString(),
    };
    await atomic(path.join(options.runDir, 'request.json'), request);
    if (delivered)
      await fs.writeFile(
        path.join(options.runDir, 'prompt.txt'),
        delivered.prompt,
        { flag: 'wx', mode: 0o600 },
      );
    const turn = currentTurn();
    let collecting = false;
    let selected = null;
    let startup = null;
    let result = null;
    let catalog = null;
    let failure = null;
    let session = null;
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    if (options.timeoutMs)
      timer = setTimeout(() => cancel('timeout'), options.timeoutMs);
    try {
      if (!supportedPiVersion(version))
        throw new PiFailure(
          'capability',
          `Pi ${piMinimumVersion} or newer with the required RPC controls is required.`,
        );
      rpc = new RpcProcess(executable, args, options, (record) => {
        if (collecting) turn.event(record);
      });
      startup = selectedState(
        await rpc.request('get_state', {}, options.startupTimeoutMs),
      );
      if (
        resumed &&
        (startup.sessionId !== resumed.id ||
          startup.sessionFile !== resumed.file ||
          startup.provider !== options.requested.provider ||
          startup.model !== options.requested.model ||
          startup.reasoningEffort !== options.requested.reasoningEffort)
      )
        throw new PiFailure(
          'resume',
          'Pi did not restore the exact persisted session and settings.',
        );
      if (options.command === 'catalog')
        catalog = await catalogFor(rpc, version);
      else {
        selected = await selectEffort(rpc, options.requested);
        if (
          resumed &&
          (selected.sessionId !== resumed.id ||
            selected.sessionFile !== resumed.file)
        )
          throw new PiFailure(
            'resume',
            'Pi changed session identity during exact selection.',
          );
        collecting = true;
        const accepted = await rpc.request('prompt', {
          message: delivered.prompt,
        });
        if (accepted?.disposition !== 'started')
          throw new PiFailure(
            'prompt-disposition',
            `Pi prompt was ${accepted?.disposition ?? 'unrecognized'}.`,
          );
        await Promise.race([turn.done, rpc.failed]);
        result = verdict(turn.state);
        selected = selectedState(await rpc.request('get_state'));
        assertSelected(selected, options.requested);
      }
    } catch (error) {
      failure = error;
    }
    const closure = rpc
      ? await rpc.close(Boolean(failure || interrupted))
      : { pid: null, exitCode: null, signal: null, shutdown: 'not-started' };
    clearTimeout(timer);
    failure = interrupted ?? failure ?? rpc?.failure;
    if (
      !failure &&
      (closure.shutdown !== 'orderly' ||
        closure.exitCode !== 0 ||
        closure.signal)
    )
      failure = new PiFailure(
        'shutdown',
        'Pi did not close orderly with exit code zero.',
        closure,
      );
    try {
      if (selected ?? startup)
        session = await sessionSnapshot(selected ?? startup, options.cwd);
    } catch (error) {
      failure ??= error;
    }
    const rejection = failure
      ? {
          kind: failure.kind ?? 'failure',
          message: failure.message,
          ...failure.details,
        }
      : null;
    const status = !failure
      ? 'completed'
      : failure.kind === 'interrupted'
        ? 'interrupted'
        : failure.kind === 'timed-out'
          ? 'timed-out'
          : ['effort-rejected', 'model-rejected'].includes(failure.kind)
            ? 'rejected'
            : 'failed';
    const receipt = {
      ...request,
      status,
      selected,
      startup,
      observedAssistant: turn.state.assistant
        ? {
            provider: turn.state.assistant.provider,
            model: turn.state.assistant.model,
          }
        : null,
      turn: {
        userSeen: turn.state.userSeen,
        settled: turn.state.settled,
        stopReason: turn.state.assistant?.stopReason ?? null,
      },
      usage: turn.state.usage,
      lastAssistantUsage: turn.state.assistant?.usage ?? null,
      result: failure ? null : result,
      rejection,
      session,
      resumability: resumability(selected, options.requested, session, closure),
      process: closure,
      artifacts: {
        request: path.join(options.runDir, 'request.json'),
        prompt: delivered ? path.join(options.runDir, 'prompt.txt') : null,
        events: path.join(options.runDir, 'events.jsonl'),
        stderr: path.join(options.runDir, 'stderr.txt'),
        result: path.join(options.runDir, 'result.json'),
      },
      completedAt: new Date().toISOString(),
    };
    if (!failure && catalog) {
      await atomic(path.join(options.runDir, 'catalog.json'), catalog);
      receipt.models = catalog.models;
    }
    if (!failure && result !== null)
      await fs.writeFile(path.join(options.runDir, 'final.txt'), result, {
        flag: 'wx',
        mode: 0o600,
      });
    await atomic(path.join(options.runDir, 'result.json'), receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode =
      status === 'completed' ? 0 : status === 'interrupted' ? 130 : 1;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (rpc && !rpc.closing) await rpc.close(true);
    if (resumed) await fs.unlink(resumed.lease);
  }
}

try {
  const options = optionsFor(process.argv.slice(2));
  if (options.command === 'help')
    process.stdout.write(
      'Usage: run-pi.mjs catalog|run --cwd ABS --run-dir ABS [--executable ABS]\nrun requires --provider EXACT --model EXACT --effort LEVEL --tools CSV|none.\nOptional --instruction ABS, --skill ABS, --role ABS, --prompt-file ABS, --resume ABS_RECEIPT, --timeout-ms N.\nContext flags repeat. Without --prompt-file, read the task from stdin.\n',
    );
  else await execute(options);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: 'failed', rejection: { kind: error.kind ?? 'input', message: error.message } })}\n`,
  );
  process.exitCode = 1;
}
