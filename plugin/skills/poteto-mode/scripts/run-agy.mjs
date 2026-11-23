#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, writeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agyEntry,
  agyEfforts,
  AGY_MINIMUM_VERSION,
  inheritedAgyAuth,
  supportedAgyVersion,
  parseAgyModels,
} from './agy-capabilities.mjs';
import {
  childEnv,
  recordActivity,
  redact,
  redactValue,
  spawnSupervised,
  startRun,
  stopRecord,
  stopRun,
  turnCompleted,
  writeOnce,
} from './worker-runtime.mjs';

const executor = 'antigravity';
const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workerContext = fileURLToPath(
  new URL('../references/worker-context.md', import.meta.url),
);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const descendantExitGraceMs = 3000;
// Orca's ACP stop sends session/cancel and gives the turn this long to end before it
// closes the process (acp-structured-session-adapter-deps.ts:19-20). Headless agy's
// cancel is SIGINT.
const cancelGraceMs = 4000;
const cancellations = ['interrupted', 'terminated', 'timed-out'];
// The first stop signal the runner received; its exit status follows it.
let receivedSignal = null;
// agy runs its default model for a leveled ID whose level conflicts with --effort, so
// launch the family ID (agent-session-option-catalog-antigravity.ts:5-23).
const levelSuffix = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/;
const launchModelFor = (model, effort) => {
  const match = levelSuffix.exec(model);
  return match && match[2] !== effort ? match[1] : model;
};
// Orca antigravity-dialect.ts:151-159. agy retries an empty model reply and sends the
// retry notice each time; the failure notices end a turn as failed.
const retryNotice = /^\s*\u26a0 (Model produced invalid output\.)\s*$/;
const turnFailureNotice =
  /^\s*(?:\u26a0 (?:UNAUTHENTICATED \(code 401\)|agent executor error): [^\n]*|API key not valid\. Please pass a valid API key\.|Agent execution error: failed to create Gemini client: [^\n]*|Agent connection was lost and could not be re-established: Failed to rebuild agent: [\s\S]*)\s*$/;
const answerOf = (response) =>
  response
    .split('\n')
    .filter((line) => !retryNotice.test(line))
    .join('\n');
const contains = (root, target) =>
  target === root || target.startsWith(`${root}${path.sep}`);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const limitations = [
  'Native agy inherits its environment, credentials, tools and customizations; it does not inherit parent MCP, conversation or permissions and is not an OS read-only boundary.',
  'Native agy owns conversation storage. This receipt does not establish transcript integrity or protect against direct native clients.',
  'Requested effort is not independently observed effective effort. Native usage is conversation-cumulative, not per-turn or settled billing.',
];
const capabilities = {
  harness: 'official-agy-cli',
  parentMcpInherited: false,
  parentPermissionsInherited: false,
  parentConversationInherited: false,
  osReadOnlyEnforcement: false,
};
const usage =
  'Usage: run-agy.mjs detect [--executable ABS] | catalog --cwd ABS --run-dir ABS [--executable ABS] | run --cwd ABS --run-dir ABS --model EXACT_ID --effort LEVEL [--instruction ABS] [--skill ABS] [--role ABS] [--prompt-file ABS] [--resume ABS_PRIOR_RECEIPT] [--timeout-ms N] [--executable ABS] [--label TEXT]';

function optionsFor(argv) {
  const options = {
    command: argv[0],
    instruction: [],
    skill: [],
  };
  if (['--help', '-h'].includes(options.command)) return { command: 'help' };
  if (!['detect', 'catalog', 'run'].includes(options.command))
    throw new Error(usage);
  const names = {
    '--cwd': 'cwd',
    '--run-dir': 'runDir',
    '--model': 'model',
    '--effort': 'effort',
    '--instruction': 'instruction',
    '--skill': 'skill',
    '--role': 'role',
    '--prompt-file': 'promptFile',
    '--resume': 'resume',
    '--timeout-ms': 'timeoutMs',
    '--executable': 'executable',
    '--label': 'label',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const key = names[argv[index]],
      value = argv[index + 1];
    if (!key || !value || value.startsWith('--'))
      throw new Error(`Invalid option ${argv[index]}. ${usage}`);
    if (options.command === 'detect' && key !== 'executable')
      throw new Error('detect accepts only --executable.');
    if (
      options.command === 'catalog' &&
      !['cwd', 'runDir', 'executable', 'timeoutMs'].includes(key)
    )
      throw new Error('catalog accepts only paths, executable and timeout.');
    if (Array.isArray(options[key])) options[key].push(value);
    else if (options[key] !== undefined)
      throw new Error(`Repeated option ${argv[index]}.`);
    else options[key] = value;
  }
  if (options.timeoutMs !== undefined) {
    if (
      !/^\d+$/.test(options.timeoutMs) ||
      !Number.isSafeInteger(Number(options.timeoutMs)) ||
      Number(options.timeoutMs) < 1 ||
      Number(options.timeoutMs) > 2147483647
    )
      throw new Error('--timeout-ms must be a positive bounded integer.');
    options.timeoutMs = Number(options.timeoutMs);
  }
  if (options.command === 'run') {
    options.requested = agyEntry({
      executor,
      model: options.model,
      reasoningEffort: options.effort,
    });
    options.launchModel = launchModelFor(options.model, options.effort);
  }
  return options;
}

function absolute(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  )
    throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
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
async function regular(file, canonical = false) {
  const normalized = absolute(file, 'Input');
  const info = await fs.lstat(normalized);
  if (
    !info.isFile() ||
    (canonical && (await fs.realpath(normalized)) !== normalized)
  )
    throw new Error(
      `Expected a regular${canonical ? ' canonical' : ''} file: ${file}`,
    );
  return fs.readFile(normalized);
}
async function outsidePlugins(lexical, canonical) {
  const roots = [
    pluginRoot,
    path.resolve(pluginRoot, '../plugin'),
    path.resolve(pluginRoot, '../plugin-claude'),
  ];
  for (const root of roots) {
    if (
      contains(root, lexical) ||
      contains(root, canonical) ||
      contains(await canonicalNew(root), canonical)
    )
      throw new Error('Artifact paths must be outside plugin trees.');
  }
}
async function preparePaths(options) {
  if (process.platform === 'win32')
    throw new Error('Antigravity process group ownership requires POSIX.');
  const cwd = await fs.realpath(absolute(options.cwd, '--cwd'));
  if (!(await fs.stat(cwd)).isDirectory())
    throw new Error('--cwd must be a directory.');
  const lexical = absolute(options.runDir, '--run-dir');
  const runDir = await canonicalNew(lexical);
  await outsidePlugins(lexical, runDir);
  try {
    await fs.lstat(lexical);
    throw new Error('--run-dir already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { cwd, runDir };
}
async function executablePath(requested) {
  if (requested !== undefined) {
    const file = absolute(requested, '--executable');
    if (!(await fs.stat(file)).isFile())
      throw new Error('--executable must be a regular executable.');
    await fs.access(file, constants.X_OK);
    return file;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, 'agy');
    try {
      if (!(await fs.stat(file)).isFile()) continue;
      await fs.access(file, constants.X_OK);
      return file;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('agy was not found on PATH.');
}
function groupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function ownedProcess(executable, args, options) {
  const hasInput = typeof options.input === 'string' && options.input.length > 0;
  let child,
    firstError = null,
    cause = null,
    code = null,
    signal = null;
  let closed = false,
    sent = false,
    identityBeforeInput = false,
    output = '',
    diagnostics = '',
    stopping = false;
  const cleanupErrors = new Set();
  const sendSignal = (signal) => {
    try {
      signalGroup(child?.providerPid, signal);
    } catch (error) {
      cleanupErrors.add(error.message);
    }
  };
  const alive = () => {
    try {
      return groupExists(child?.providerPid);
    } catch (error) {
      cleanupErrors.add(error.message);
      return true;
    }
  };
  const timers = new Set();
  const outputDecoder = new TextDecoder('utf-8', { fatal: true });
  const diagnosticDecoder = new TextDecoder('utf-8', { fatal: true });
  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timers.add(timer);
    return timer;
  };
  let settle, markExited;
  const completion = new Promise((resolve) => {
    settle = resolve;
  });
  const exited = new Promise((resolve) => {
    markExited = resolve;
  });
  const cancelTurn = async () => {
    if (!child.providerPid || code !== null || signal !== null) return;
    try {
      process.kill(child.providerPid, 'SIGINT');
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupErrors.add(error.message);
    }
    await new Promise((resolve) => {
      later(resolve, cancelGraceMs);
      void exited.then(resolve);
    });
  };
  const fail = (message, kind = 'failed') => {
    firstError ??= message;
    cause ??= kind;
    if (child?.pid && !stopping) {
      stopping = true;
      // A cancelled turn gets to end first; the supervisor then runs the stop
      // ladder on the provider group.
      void (
        hasInput && cancellations.includes(kind)
          ? cancelTurn()
          : Promise.resolve()
      )
        .then(() => child.stop(kind === 'interrupted' ? 'SIGINT' : 'SIGTERM'))
        .then(() =>
          later(() => {
            child.stdin?.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            settle();
          }, 200),
        );
    }
  };
  const send = () => {
    if (!hasInput || sent || firstError || !child?.stdin) return;
    sent = true;
    child.stdin.end(options.input);
  };
  const interrupt = () => {
    receivedSignal ??= 'SIGINT';
    fail('Interrupted by SIGINT.', 'interrupted');
  };
  const terminate = () => {
    receivedSignal ??= 'SIGTERM';
    fail('Interrupted by SIGTERM.', 'terminated');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    child = spawnSupervised(executable, args, {
      cwd: options.cwd,
      env: childEnv(process.env, executor),
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      lifetime: 'one-shot',
    });
    child.once('error', (error) => {
      fail(error.message);
      settle();
    });
    child.stdin?.on('error', (error) => fail(`stdin: ${error.message}`));
    child.stdout.on('error', (error) => fail(`stdout: ${error.message}`));
    child.stderr.on('error', (error) => fail(`stderr: ${error.message}`));
    child.stdout.on('data', (bytes) => {
      try {
        options.stdout?.(bytes);
        if (options.receive) {
          options.receive(bytes, () => {
            identityBeforeInput = !sent;
            send();
          });
        } else {
          output += outputDecoder.decode(bytes, { stream: true });
          if (output.length > 8 * 1024 * 1024)
            throw new Error('CLI probe output exceeded its limit.');
        }
      } catch (error) {
        fail(error.message);
      }
    });
    child.stderr.on('data', (bytes) => {
      try {
        options.stderr?.(bytes);
        if (!options.receive) {
          diagnostics += diagnosticDecoder.decode(bytes, { stream: true });
          if (diagnostics.length > 8 * 1024 * 1024)
            throw new Error('CLI probe diagnostic output exceeded its limit.');
        }
      } catch (error) {
        fail(error.message);
      }
    });
    child.once('exit', (exitCode, exitSignal) => {
      code = exitCode;
      signal = exitSignal;
      markExited();
      if (code !== 0 || signal) fail(`agy exited ${code ?? signal}.`);
      later(() => {
        if (!closed) fail('Owned CLI exited with open descendant pipes.');
      }, 1000);
    });
    child.once('close', () => {
      closed = true;
      settle();
    });
    if (hasInput && options.waitForInit)
      later(() => {
        if (!sent)
          fail('Native init did not arrive before task input deadline.');
      }, 30000);
    else send();
    if (options.timeoutMs)
      later(
        () => fail('Antigravity deadline exceeded.', 'timed-out'),
        options.timeoutMs,
      );
    await completion;
    const graceDeadline = Date.now() + descendantExitGraceMs;
    while (alive() && Date.now() < graceDeadline) await pause(20);
    if (alive()) {
      fail('Owned CLI left descendant processes alive.');
      const deadline = Date.now() + 1300;
      while (alive() && Date.now() < deadline) {
        sendSignal('SIGKILL');
        await pause(20);
      }
    }
    try {
      if (options.end) options.end();
      else {
        output += outputDecoder.decode();
        diagnostics += diagnosticDecoder.decode();
      }
    } catch (error) {
      fail(error.message);
    }
    return {
      output,
      diagnostics,
      error: firstError,
      cause,
      inputSent: sent,
      identityBeforeInput,
      process: {
        pid: child.providerPid,
        exitCode: code,
        signal,
        closed,
        groupClosed: !alive(),
        descendantsReaped: child.descendantsReaped,
        cleanupErrors: [...cleanupErrors],
        // Killed descendants leave the run complete, as Orca only warns of them,
        // but the group did not empty on its own.
        shutdown:
          closed && !firstError && !child.descendantsReaped
            ? 'orderly'
            : 'terminated',
      },
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

// Workers use subscription login or ADC. agy's modelProvider setting selects the
// Gemini API-key route instead, so no catalog or worker starts under it.
function authStop(auth) {
  if (auth.method !== 'gemini-api-key') return null;
  return stopRecord({
    kind: 'not-started',
    code: 'unsupported-auth',
    cause:
      '"modelProvider": "gemini" in ~/.gemini/antigravity-cli/settings.json selects the Gemini API-key route, which workers do not use. Workers use subscription login or ADC.',
    continuable: false,
  });
}

async function detect(options) {
  const auth = await inheritedAgyAuth();
  const stop = authStop(auth);
  let executable;
  try {
    executable = await executablePath(options.executable);
  } catch (error) {
    if (
      !['ENOENT', 'ENOTDIR'].includes(error.code) &&
      !error.message.includes('not found on PATH')
    )
      throw error;
    return {
      executor,
      available: false,
      compatible: false,
      auth,
      stop,
      modelExecutionVerified: false,
    };
  }
  const versionProbe = await ownedProcess(executable, ['--version'], {
    timeoutMs: 5000,
  });
  const helpProbe = ['interrupted', 'terminated'].includes(versionProbe.cause)
    ? {
        output: '',
        diagnostics: '',
        error: versionProbe.error,
        cause: versionProbe.cause,
      }
    : await ownedProcess(executable, ['--help'], { timeoutMs: 5000 });
  const version =
    [versionProbe.output, versionProbe.diagnostics]
      .map(
        (text) =>
          text.trim().match(/^(?:agy\s+)?(\d+\.\d+\.\d+)(?:\s.*)?$/)?.[1],
      )
      .find(Boolean) ?? null;
  const help = helpProbe.output.trim()
    ? helpProbe.output
    : helpProbe.diagnostics;
  const requiredOptions = Object.fromEntries(
    [
      '--model',
      '--effort',
      '--input-format',
      '--output-format',
      '--conversation',
      '--dangerously-skip-permissions',
    ].map((flag) => [
      flag.slice(2),
      new RegExp(`(?:^|[\\s,])${flag}(?:[\\s=<]|$)`, 'm').test(help),
    ]),
  );
  requiredOptions.streamJson = /\bstream-json\b/.test(help);
  requiredOptions.models = /(?:^|\n)\s*models\b/.test(help);
  const effortStart = help.indexOf('--effort');
  const effortHelp =
    effortStart < 0 ? '' : help.slice(effortStart).split(/\n\s*--/)[0];
  const effortSyntax = agyEfforts.filter((level) =>
    new RegExp(`\\b${level}\\b`).test(effortHelp),
  );
  return {
    executor,
    executable,
    available: true,
    version,
    minimumVersion: AGY_MINIMUM_VERSION,
    requiredOptions,
    effortSyntax,
    compatible:
      !versionProbe.error &&
      !helpProbe.error &&
      supportedAgyVersion(version) &&
      Object.values(requiredOptions).every(Boolean) &&
      effortSyntax.length > 0,
    auth,
    stop,
    modelExecutionVerified: false,
    probeError: versionProbe.error ?? helpProbe.error ?? null,
    probeCause: versionProbe.cause ?? helpProbe.cause ?? null,
  };
}

async function contextFor(options) {
  const context = [];
  for (const [kind, files] of [
    ['instruction', options.instruction],
    ['skill', options.skill],
    ['role', options.role ? [options.role] : []],
    ['worker-context', [workerContext]],
  ]) {
    for (const file of files) {
      const bytes = await regular(file);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const content =
        kind === 'role'
          ? text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
          : text;
      context.push({
        kind,
        path: path.resolve(file),
        sha256: sha256(bytes),
        contentSha256: sha256(content),
        content,
      });
    }
  }
  const task = options.promptFile
    ? await regular(options.promptFile)
    : await new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (bytes) => chunks.push(bytes));
        process.stdin.once('error', reject);
        process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
      });
  const taskText = new TextDecoder('utf-8', { fatal: true }).decode(task);
  if (!taskText.trim())
    throw new Error('Supply a nonempty task on stdin or --prompt-file.');
  const prompt = [
    `Working directory: ${options.cwd}\nApply the complete supplied instruction, skill and role bodies to this task.`,
    ...context
      .filter((file) => file.kind !== 'worker-context')
      .map(
        (file) =>
          `## Complete ${file.kind} body from ${file.path}\n\n${file.content}`,
      ),
    `Receiving executor: ${executor}.\n\n${context.find((file) => file.kind === 'worker-context').content}`,
    limitations[0],
    `## Assigned task\n\n${taskText}`,
  ].join('\n\n');
  return {
    prompt,
    context: context.map(({ content, ...metadata }) => metadata),
    taskSha256: sha256(task),
  };
}

function conversationVerified(receipt, requested) {
  return (
    uuid(receipt.conversationId) &&
    receipt.observedModel === requested.model &&
    receipt.init?.conversation_id === receipt.conversationId &&
    receipt.init?.init?.cwd === requested.cwd &&
    receipt.init?.init?.model === requested.model &&
    (!receipt.terminalResult ||
      receipt.terminalResult.conversation_id === receipt.conversationId) &&
    (!receipt.resume ||
      receipt.resume.conversationId === receipt.conversationId) &&
    receipt.identityBeforeInput === true &&
    receipt.inputSent === true &&
    receipt.process?.closed === true &&
    receipt.process.groupClosed === true
  );
}

const interruptionCauses = {
  'timed-out': ['deadline', 'deadline'],
  interrupted: ['signal', 'SIGINT'],
  terminated: ['signal', 'SIGTERM'],
};

// Orca src/main/rate-limits/providers/antigravity/antigravity-usage-error.ts:5-88, with
// each failure kind named by its stop code. Structured AGY_ERROR lines outrank prose.
const agyErrorPrefix = 'AGY_ERROR:';
const agyErrorCodes = [
  [
    'not-signed-in',
    (status, code) => status === 'UNAUTHENTICATED' || code === 401,
  ],
  // Orca's no-subscription: authenticated, but not entitled to what was asked for.
  [
    'model-unavailable',
    (status, code) => status === 'PERMISSION_DENIED' || code === 403,
  ],
  [
    'usage-limit',
    (status, code) => status === 'RESOURCE_EXHAUSTED' || code === 429,
  ],
  ['provider', (_, code) => code !== null && code >= 500 && code < 600],
];
const signedOutPhrases = [
  'not logged into antigravity',
  'not logged in',
  'not signed in',
  'not authenticated',
  'not-authenticated',
  'unauthenticated',
  'run agy login',
  'please sign in',
  'please log in',
  'sign in to antigravity',
  'no credentials',
  'authentication required',
];

function failureCode(diagnostics) {
  for (const line of diagnostics.split('\n')) {
    const index = line.indexOf(agyErrorPrefix);
    const payload =
      index === -1 ? '' : line.slice(index + agyErrorPrefix.length).trim();
    if (!payload.startsWith('{')) continue;
    let error;
    try {
      error = JSON.parse(payload);
    } catch {
      continue;
    }
    const status =
      typeof error?.status === 'string' ? error.status.toUpperCase() : '';
    const code =
      typeof error?.error_code === 'number' ? error.error_code : null;
    const match = agyErrorCodes.find(([, applies]) => applies(status, code));
    if (match) return match[0];
  }
  const lowered = diagnostics.toLowerCase();
  return signedOutPhrases.some((phrase) => lowered.includes(phrase))
    ? 'not-signed-in'
    : 'failed';
}

// A run whose task input never reached agy has not started, whatever stopped it.
function stopFor(receipt, diagnostics) {
  const [kind, code, cause] =
    receipt.status in interruptionCauses
      ? ['interrupted', ...interruptionCauses[receipt.status]]
      : receipt.status === 'completed'
        ? ['completed', 'completed', 'completed']
        : receipt.status === 'unsupported-auth'
          ? ['not-started', 'unsupported-auth', receipt.error]
          : [
              'error',
              failureCode(diagnostics),
              receipt.error ?? receipt.status,
            ];
  return stopRecord({
    kind: kind === 'completed' || receipt.inputSent ? kind : 'not-started',
    code,
    cause,
    continuable: conversationVerified(receipt, {
      model: receipt.launchModel,
      cwd: receipt.cwd,
    }),
  });
}

async function tail(file, bytes = 64 * 1024) {
  let handle;
  try {
    handle = await fs.open(file);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, bytes));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function priorFor(options, auth) {
  if (!options.resume) return null;
  const file = absolute(options.resume, '--resume');
  await outsidePlugins(file, await fs.realpath(file));
  const bytes = await regular(file, true);
  const prior = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (
    path.basename(file) !== 'result.json' ||
    prior.resultPath !== file ||
    prior.runDir !== path.dirname(file) ||
    prior.schemaVersion !== 1 ||
    prior.command !== 'run' ||
    prior.executor !== executor
  )
    throw new Error('--resume requires an exact Antigravity run receipt.');
  if (
    JSON.stringify(agyEntry(prior.requested)) !==
    JSON.stringify(options.requested)
  )
    throw new Error('Resume model and effort must be identical.');
  if (prior.cwd !== options.cwd)
    throw new Error('Resume requires the same canonical cwd.');
  if (prior.authMode !== auth.method)
    throw new Error('Resume requires the same inherited auth method.');
  if (
    !prior.process?.closed ||
    !prior.process.groupClosed ||
    !Number.isInteger(prior.process.pid)
  )
    throw new Error(
      'Resume requires verified closed owned process and process group.',
    );
  if (
    !conversationVerified(prior, {
      model: options.launchModel,
      cwd: options.cwd,
    })
  )
    throw new Error(
      'Resume receipt lacks exact conversation identity evidence.',
    );
  const numTurns = prior.terminalResult?.num_turns ?? 0;
  if (!Number.isSafeInteger(numTurns) || numTurns < 0)
    throw new Error('Resume receipt has an invalid native turn count.');
  const continuedByPath = path.join(path.dirname(file), 'continued-by.json');
  try {
    await fs.lstat(continuedByPath);
    throw new Error('Prior receipt already has a permanent continuation edge.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    file,
    sha256: sha256(bytes),
    conversationId: prior.conversationId,
    numTurns,
    continuedByPath,
  };
}

function streamParser(options, prior) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    init = null,
    result = null,
    failedStep = null,
    toolErrors = [],
    userInput = false,
    count = 0;
  const toolSteps = new Set();
  const line = (text, ready) => {
    if (!text.trim()) return;
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.event !== 'string'
    )
      throw new Error('Expected an event-based stream object.');
    if (value.event === 'error' || value.error || value.is_error === true)
      throw new Error(`Native agy failure: ${JSON.stringify(value)}`);
    if (result) throw new Error('Stream continued after terminal result.');
    if (value.event === 'init') {
      if (init) throw new Error('Duplicate stream init.');
      init = value;
      if (
        !uuid(init.conversation_id) ||
        (prior && init.conversation_id !== prior.conversationId)
      )
        throw new Error(
          'Init conversation ID does not match the exact requested conversation.',
        );
      if (
        init.init?.model !== options.launchModel ||
        init.init?.cwd !== options.cwd
      )
        throw new Error('Init model or cwd does not match the exact request.');
      ready();
    } else if (value.event === 'step_update') {
      if (!init || value.step_update?.conversation_id !== init.conversation_id)
        throw new Error('Step conversation ID disagrees with init.');
      const { step_type, state, tool_name, tool_info } = value.step_update;
      if (step_type === 'tool' && !toolSteps.has(value.step_update.step_index)) {
        toolSteps.add(value.step_update.step_index);
        recordActivity(options.runDir, `tool: ${tool_name ?? tool_info?.name}`);
      }
      if (
        ['ERROR', 'FAILED', 'CANCELLED', 'CANCELED', 'ABORTED'].includes(
          state,
        ) ||
        value.step_update.error
      ) {
        const step = {
          step_type,
          state,
          tool_name: tool_name ?? null,
          parameters: tool_info?.parameters ?? null,
        };
        if (step_type === 'tool') toolErrors.push(step);
        else {
          failedStep = step;
          throw new Error('Native step reported failure.');
        }
      }
      if (
        value.step_update.step_type === 'user_input' &&
        value.step_update.state === 'DONE'
      )
        userInput = true;
    } else if (value.event === 'result') {
      count++;
      const terminal = value.result;
      turnCompleted(options.runDir, terminal?.status);
      result = terminal;
      const recovered =
        terminal?.status === 'ERROR' &&
        terminal.finished_reason === 'error' &&
        typeof terminal.error === 'string';
      if (
        !init ||
        !userInput ||
        !terminal ||
        terminal.conversation_id !== init.conversation_id ||
        (!recovered && (terminal.status !== 'SUCCESS' || terminal.error)) ||
        terminal.is_error === true ||
        terminal.success === false ||
        typeof terminal.response !== 'string' ||
        !answerOf(terminal.response).trim()
      )
        throw new Error(
          'Missing matching current-turn SUCCESS terminal result and nonempty response.',
        );
      if (turnFailureNotice.test(answerOf(terminal.response)))
        throw new Error(
          `agy ended the turn with a failure notice: ${answerOf(terminal.response).trim()}`,
        );
      if (
        !Number.isSafeInteger(terminal.num_turns) ||
        terminal.num_turns <= (prior?.numTurns ?? 0)
      )
        throw new Error(
          'Terminal result is stale or lacks current-turn count.',
        );
    } else throw new Error(`Unsupported native stream event ${value.event}.`);
  };
  return {
    receive(bytes, ready) {
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > 16 * 1024 * 1024)
        throw new Error('Stream line exceeded its limit.');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end).replace(/\r$/, ''), ready);
        pending = pending.slice(end + 1);
      }
    },
    end() {
      pending += decoder.decode();
      if (pending.length)
        throw new Error('Stream ended without a complete NDJSON line.');
      if (!init || !result || count !== 1)
        throw new Error('Stream lacks exactly one matching terminal result.');
    },
    evidence() {
      return {
        conversationId: init?.conversation_id ?? null,
        observedModel: init?.init?.model ?? null,
        init,
        terminalResult: result,
        failedStep,
        toolErrors,
      };
    },
  };
}

async function execute(options) {
  Object.assign(options, await preparePaths(options));
  const context = options.command === 'run' ? await contextFor(options) : null;
  const auth = await inheritedAgyAuth();
  const prior =
    options.command === 'run' ? await priorFor(options, auth) : null;
  const executable = await executablePath(options.executable);
  await fs.mkdir(path.dirname(options.runDir), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(options.runDir, { mode: 0o700 });
  const registry =
    context &&
    startRun(
      {
        runDir: options.runDir,
        executor,
        model: options.model,
        effort: options.effort,
        cwd: options.cwd,
        label: options.label ?? null,
      },
      prior ? { sessionId: prior.conversationId } : {},
    );
  const resultPath = path.join(options.runDir, 'result.json');
  const stdoutPath = path.join(
    options.runDir,
    options.command === 'run' ? 'stdout.jsonl' : 'stdout.log',
  );
  const stderrPath = path.join(options.runDir, 'stderr.log');
  const request = {
    schemaVersion: 1,
    executor,
    command: options.command,
    cwd: options.cwd,
    runDir: options.runDir,
    label: options.label ?? null,
    executable,
    requested: options.requested ?? null,
    launchModel: options.launchModel ?? null,
    auth,
    authMode: auth.method,
    permissions: 'all-native-tools-auto-approved',
    timeoutMs: options.timeoutMs ?? null,
    context: context?.context ?? [],
    taskSha256: context?.taskSha256 ?? null,
    resume: prior
      ? {
          receiptPath: prior.file,
          receiptSha256: prior.sha256,
          conversationId: prior.conversationId,
        }
      : null,
    startedAt: new Date().toISOString(),
    resultPath,
    stdoutPath,
    stderrPath,
    limitations,
    capabilities,
  };
  let stdoutFd,
    stderrFd,
    outcome = null,
    runtime = null,
    error = null,
    failureKind = null,
    evidence = {},
    catalog = null;
  let args = [];
  try {
    stdoutFd = openSync(stdoutPath, 'wx', 0o600);
    stderrFd = openSync(stderrPath, 'wx', 0o600);
    const refused = authStop(auth);
    if (refused)
      throw Object.assign(new Error(refused.cause), {
        kind: 'unsupported-auth',
      });
    runtime = await detect({ executable });
    if (!runtime.compatible) {
      const rejected = new Error(
        `Requires official agy >= ${AGY_MINIMUM_VERSION} with native stream, conversation and settings syntax. ${runtime.probeError ?? ''}`,
      );
      rejected.kind = runtime.probeCause;
      throw rejected;
    }
    if (context && !runtime.effortSyntax.includes(options.effort))
      throw new Error(
        'Requested effort is not supported by the detected CLI syntax.',
      );
    if (prior) {
      if (sha256(await regular(prior.file, true)) !== prior.sha256)
        throw new Error('Prior receipt changed before continuation claim.');
      await fs.writeFile(
        prior.continuedByPath,
        json({
          schemaVersion: 1,
          executor,
          priorReceipt: prior.file,
          priorReceiptSha256: prior.sha256,
          resultPath,
          runDir: options.runDir,
          claimedAt: request.startedAt,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (context) {
      args = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        options.launchModel,
        '--effort',
        options.effort,
        '--dangerously-skip-permissions',
      ];
      if (prior) args.push('--conversation', prior.conversationId);
      const promptPath = path.join(options.runDir, 'prompt.txt');
      await fs.writeFile(promptPath, context.prompt, {
        flag: 'wx',
        mode: 0o600,
      });
      request.promptPath = promptPath;
      request.promptSha256 = sha256(context.prompt);
    } else args = ['models'];
    request.args = args;
    await fs.writeFile(
      path.join(options.runDir, 'request.json'),
      json(request),
      { flag: 'wx', mode: 0o600 },
    );
    const parser = context ? streamParser(options, prior) : null;
    outcome = await ownedProcess(executable, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? (context ? null : 30000),
      input: context
        ? `${JSON.stringify({ event: 'user', message: { content: context.prompt } })}\n`
        : undefined,
      waitForInit: !!context,
      receive: parser?.receive,
      end: parser?.end,
      stdout: (bytes) => writeSync(stdoutFd, bytes),
      stderr: (bytes) => writeSync(stderrFd, bytes),
    });
    if (parser) evidence = parser.evidence();
    if (outcome.error) throw new Error(outcome.error);
    if (!outcome.process.closed || !outcome.process.groupClosed)
      throw new Error('Owned process closure is unconfirmed.');
    if (context) {
      request.finalPath = path.join(options.runDir, 'final.txt');
      await fs.writeFile(
        request.finalPath,
        answerOf(evidence.terminalResult.response),
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (!context) {
      catalog = {
        schemaVersion: 1,
        executor,
        runtime,
        ...parseAgyModels(outcome.output, runtime.version),
      };
      await fs.writeFile(
        path.join(options.runDir, 'catalog.json'),
        json(catalog),
        { flag: 'wx', mode: 0o600 },
      );
    }
  } catch (failure) {
    error = failure.message;
    failureKind = failure.kind;
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  const status = error
    ? (outcome?.cause ?? failureKind ?? 'failed')
    : 'completed';
  const receipt = {
    ...request,
    args,
    status,
    error: error && redact(error),
    runtime,
    process: outcome?.process ?? {
      pid: null,
      exitCode: null,
      signal: null,
      closed: true,
      groupClosed: true,
      descendantsReaped: null,
      shutdown: 'not-started',
    },
    ...evidence,
    // The native terminal result's error is provider text, which can carry a credential.
    terminalResult: evidence.terminalResult && {
      ...evidence.terminalResult,
      error: redactValue(evidence.terminalResult.error),
    },
    effectiveEffort: null,
    inputSent: outcome?.inputSent ?? false,
    identityBeforeInput: outcome?.identityBeforeInput ?? false,
    result: error
      ? null
      : answerOf(evidence.terminalResult?.response ?? '') || null,
    usage: evidence.terminalResult?.usage
      ? {
          scope: 'conversation-cumulative',
          source: 'native-agy-result',
          value: evidence.terminalResult.usage,
        }
      : null,
    ...(catalog
      ? { catalogPath: path.join(options.runDir, 'catalog.json'), ...catalog }
      : {}),
    completedAt: new Date().toISOString(),
  };
  if (context) {
    receipt.registry = registry;
    receipt.recoveredError =
      !error && evidence.terminalResult?.status === 'ERROR'
        ? redact(evidence.terminalResult.error)
        : null;
    receipt.stop = stopFor(
      receipt,
      `${await tail(stderrPath)}\n${evidence.terminalResult?.error ?? ''}`,
    );
    stopRun(options.runDir, receipt.stop);
  }
  writeOnce(resultPath, json(receipt), 0o600);
  console.log(JSON.stringify(receipt));
  process.exitCode = receivedSignal
    ? 128 + os.constants.signals[receivedSignal]
    : error
      ? 1
      : 0;
}

try {
  const options = optionsFor(process.argv.slice(2));
  if (options.command === 'help') console.log(usage);
  else if (options.command === 'detect') {
    const result = await detect(options);
    console.log(JSON.stringify(result));
    if (!result.compatible || result.stop) process.exitCode = 1;
  } else await execute(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
