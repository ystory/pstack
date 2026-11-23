#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_MINIMUM_VERSION,
  CLAUDE_CLI_EFFORTS,
  exactClaudeModel,
  versionAtLeast,
} from './claude-capabilities.mjs';
import {
  childEnv,
  probeSupervised,
  recordActivity,
  redact,
  spawnSupervised,
  startRun,
  stopRecord,
  stopRun,
  turnCompleted,
  writeOnce,
} from './worker-runtime.mjs';

const EXECUTOR = 'claude-code';
// Orca managed-provider-process.ts:28.
const STDERR_TAIL_MAX_CHARS = 8192;
// Orca claude-result-outcome.ts:4-5: a result with one of these reasons is a stop, not a failure.
const CLAUDE_ABORTED_TERMINAL_REASONS = new Set([
  'aborted_streaming',
  'aborted_tools',
]);
// Orca claude-stream-json-exit-error.ts:14-15.
const CLAUDE_MISSING_CONVERSATION =
  /^No conversation found with session ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/im;

const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = `Usage:
  node run-claude.mjs detect [--executable /absolute/claude]
  node run-claude.mjs run --cwd /absolute/worktree --run-dir /absolute/local-run \\
    --model EXACT_MODEL_ID [--effort LEVEL] [--instruction /absolute/AGENTS.md] [--skill /absolute/SKILL.md] \\
    [--role /absolute/role.md] [--resume session-uuid] [--allowed-tool tool] \\
    [--executable /absolute/claude] [--label TEXT] < task.txt

Repeat --instruction, --skill, and --allowed-tool as needed. --role supplies only
the requested role's Markdown body. Claude runs with --permission-mode auto. Pass
--allowed-tool only for an action the user approved after an auto-mode denial.
Fresh sessions are the default. Artifacts are saved in --run-dir outside the
plugin; stdout is the result receipt JSON. Dispatchers pass the resolved model.
Run requires an explicit exact model ID. --label names the run in workers.mjs
status and the run's events.jsonl.`;

function parseArguments(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (command !== 'detect' && command !== 'run') throw new Error(USAGE);
  const options = { command, instruction: [], skill: [], allowedTool: [] };
  const names = {
    '--cwd': 'cwd',
    '--run-dir': 'runDir',
    '--effort': 'effort',
    '--model': 'model',
    '--instruction': 'instruction',
    '--skill': 'skill',
    '--role': 'role',
    '--resume': 'resume',
    '--allowed-tool': 'allowedTool',
    '--executable': 'executable',
    '--label': 'label',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const name = names[argv[index]];
    const value = argv[index + 1];
    if (!name || !value || value.startsWith('--')) {
      throw new Error(`Expected a supported option and its value.\n${USAGE}`);
    }
    if (command === 'detect' && name !== 'executable') {
      throw new Error('detect accepts only --executable');
    }
    if (Array.isArray(options[name])) options[name].push(value);
    else if (options[name] !== undefined) {
      throw new Error(`${argv[index]} was provided more than once`);
    } else options[name] = value;
  }
  return options;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function contains(directory, target) {
  const relative = path.relative(directory, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function canonicalPath(target) {
  try {
    return await realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(
      await canonicalPath(path.dirname(target)),
      path.basename(target),
    );
  }
}

async function executablePath(requested = 'claude') {
  if (path.isAbsolute(requested)) {
    await access(requested, constants.X_OK);
    return requested;
  }
  if (requested !== 'claude')
    throw new Error('--executable must be an absolute path');
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, requested);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue normal PATH lookup.
    }
  }
  throw new Error('claude was not found on PATH');
}

async function cliText(executable, argument) {
  const result = await probeSupervised(executable, [argument], {
    env: childEnv(process.env, EXECUTOR),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `claude ${argument} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function detect(options) {
  let executable;
  try {
    executable = await executablePath(options.executable);
  } catch (error) {
    if (
      error.code !== 'ENOENT' &&
      error.message !== 'claude was not found on PATH'
    )
      throw error;
    return {
      executor: EXECUTOR,
      available: false,
      compatible: false,
      modelExecutionVerified: false,
      guidance: [
        {
          action: 'install',
          command: 'curl -fsSL https://claude.ai/install.sh | bash',
          url: 'https://code.claude.com/docs/en/setup',
        },
      ],
    };
  }
  const versionText = (await cliText(executable, '--version')).trim();
  const version = versionText.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (!version)
    throw new Error(`Unrecognized Claude Code version: ${versionText}`);
  const help = await cliText(executable, '--help');
  const requiredOptions = {
    print: help.includes('--print'),
    model: help.includes('--model'),
    effort: help.includes('--effort'),
    outputFormat:
      help.includes('--output-format') && help.includes('stream-json'),
    verbose: help.includes('--verbose'),
    resume: help.includes('--resume'),
    permissionModeAuto: /--permission-mode\b[\s\S]*?"auto"/.test(help),
  };
  const effortStart = help.indexOf('--effort');
  const effortEnd = help.indexOf('\n  --', effortStart + 1);
  const effortHelp = help.slice(
    effortStart,
    effortEnd === -1 ? undefined : effortEnd,
  );
  const effortSyntax = CLAUDE_CLI_EFFORTS.filter((effort) =>
    new RegExp(`\\b${effort}\\b`).test(effortHelp),
  );
  const authResult = await probeSupervised(executable, ['auth', 'status'], {
    timeout: 20_000,
    env: childEnv(process.env, EXECUTOR),
  });
  let auth;
  if (!authResult.error && [0, 1].includes(authResult.status)) {
    try {
      auth = JSON.parse(authResult.stdout);
    } catch {}
  }
  // Orca environment-doctor.ts:28-34, 130-146: status wording changes between
  // releases, so unparsed output falls back to the exit code; a timeout stays unknown.
  const loggedIn =
    typeof auth?.loggedIn === 'boolean'
      ? auth.loggedIn
      : !authResult.error && typeof authResult.status === 'number'
        ? authResult.status === 0
        : null;
  const method = auth?.authMethod ?? auth?.method;
  return {
    executor: EXECUTOR,
    available: true,
    auth: {
      verified: loggedIn !== null,
      loggedIn,
      method:
        typeof method === 'string' && /^[\w-]+$/.test(method) ? method : null,
    },
    guidance:
      loggedIn === false
        ? [
            {
              action: 'login',
              command: 'claude auth login',
              interactiveCommand: '/login',
              url: 'https://code.claude.com/docs/en/authentication',
            },
          ]
        : [],
    executable,
    version,
    minimumVersion: CLAUDE_MINIMUM_VERSION,
    requiredOptions,
    compatible:
      versionAtLeast(version, CLAUDE_MINIMUM_VERSION) &&
      Object.values(requiredOptions).every(Boolean) &&
      effortSyntax.length > 0,
    effortSyntax,
    modelExecutionVerified: false,
  };
}

function activityText({ name, input = {} }) {
  if (name === 'Bash') return `running: ${input.command ?? name}`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name))
    return `editing ${input.file_path ?? input.notebook_path ?? name}`;
  return `tool: ${name}`;
}

// Orca claude-stream-json-exit-error.ts:45-58: the exit status, then stderr's
// last lines, dropping the fragment a full tail starts with. Whole redacted
// lines are kept from the end while they fit a stop cause.
function exitText({ exitCode, signal }, stderrTail) {
  const detail = (
    stderrTail.length >= STDERR_TAIL_MAX_CHARS
      ? stderrTail.slice(stderrTail.indexOf('\n') + 1)
      : stderrTail
  ).trim();
  const how =
    signal !== null
      ? `(signal ${signal})`
      : exitCode === null
        ? ''
        : `(code ${exitCode})`;
  const head = `claude stream-json exited${how ? ` ${how}` : ''}`;
  let lines = redact(detail, Infinity);
  while (head.length + 2 + lines.length > 2000 && lines.includes('\n'))
    lines = lines.slice(lines.indexOf('\n') + 1);
  return lines ? `${head}: ${lines}` : head;
}

// The receipt's stop, from the first matching piece of evidence. received is a
// stop signal the runner forwarded; signal also counts one the CLI died of.
function claudeStop({
  received,
  signal,
  missingSession,
  permissionMode,
  terminalReason,
  denials,
  succeeded,
  failure,
}) {
  const aborted = CLAUDE_ABORTED_TERMINAL_REASONS.has(terminalReason);
  if (received) return ['interrupted', 'signal', received];
  // An aborted result is a signal stop only when the runner sent the signal.
  if (signal && !aborted) return ['interrupted', 'signal', signal];
  if (missingSession) return ['error', 'missing-session', missingSession];
  // Orca claude-full-access-refusal.ts:52-66 and claude-permission-mode-ladder.ts:47-74:
  // a first root init outside the launched mode is Claude's refusal of that mode.
  if (permissionMode !== null && permissionMode !== 'auto')
    return [
      'error',
      'permission-mode',
      `Claude started in ${permissionMode} mode instead of auto`,
    ];
  // Orca claude-result-outcome.ts:14-20: the abort reason outranks is_error.
  if (aborted)
    return [
      'interrupted',
      'failed',
      `Claude ended the turn early (${terminalReason})`,
    ];
  if (denials.length)
    return ['permission', 'permission-denied', 'permission denial'];
  if (succeeded) return ['completed', 'completed', 'completed'];
  return ['error', 'failed', failure];
}

function markdownBody(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

async function contextFile(file, kind, bodyOnly = false) {
  const absolutePath = absolute(file, `--${kind}`);
  const bytes = await readFile(absolutePath, 'utf8');
  return {
    kind,
    path: absolutePath,
    content: bodyOnly ? markdownBody(bytes) : bytes,
  };
}

async function inputText() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function run(options) {
  const model = exactClaudeModel(options.model);
  const cwd = absolute(options.cwd, '--cwd');
  if (!(await stat(cwd)).isDirectory())
    throw new Error('--cwd must be a directory');
  const runDir = absolute(options.runDir, '--run-dir');
  if (contains(PLUGIN_ROOT, runDir))
    throw new Error('--run-dir must be outside the plugin');
  if (
    options.effort !== undefined &&
    !CLAUDE_CLI_EFFORTS.includes(options.effort)
  )
    throw new Error(`--effort must be one of ${CLAUDE_CLI_EFFORTS.join(', ')}`);
  if (
    options.resume &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.resume,
    )
  ) {
    throw new Error('--resume must be the exact original session UUID');
  }
  const executable = await executablePath(options.executable);
  const context = [];
  for (const file of options.instruction)
    context.push(await contextFile(file, 'instruction'));
  for (const file of options.skill)
    context.push(await contextFile(file, 'skill'));
  if (options.role) context.push(await contextFile(options.role, 'role', true));
  const task = await inputText();
  if (!task.trim()) throw new Error('Supply the task prompt on stdin');
  const prompt = [
    `Working directory: ${cwd}\n\nApply the supplied project and role instructions to the assigned task. Use the supplied skill material for that task.`,
    ...context.map(
      (file) =>
        `## Complete ${file.kind} body from ${file.path}\n\n${file.content}`,
    ),
    `Receiving executor is ${EXECUTOR}.\n\n${await readFile(new URL('../references/worker-context.md', import.meta.url), 'utf8')}`,
    `## Assigned task\n\n${task}`,
  ].join('\n\n');
  if (contains(await realpath(PLUGIN_ROOT), await canonicalPath(runDir))) {
    throw new Error('--run-dir must be outside the plugin');
  }
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.jsonl');
  const stderrPath = path.join(runDir, 'stderr.log');
  const promptPath = path.join(runDir, 'prompt.txt');
  const requestPath = path.join(runDir, 'request.json');
  const resultPath = path.join(runDir, 'result.json');
  const args = [
    '-p',
    '--model',
    model,
    ...(options.effort === undefined ? [] : ['--effort', options.effort]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
  ];
  // Orca claude-structured-launch-resolution.ts:170-177, 288-290: a fresh
  // conversation is named before spawn, so its identity never rests on the stream.
  const requestedSessionId = options.resume ? null : randomUUID();
  if (options.resume) args.push('--resume', options.resume);
  else args.push('--session-id', requestedSessionId);
  for (const tool of new Set(options.allowedTool)) {
    args.push('--allowedTools', tool);
  }
  const request = {
    executor: EXECUTOR,
    executable,
    args,
    cwd,
    label: options.label ?? null,
    model,
    modelSelection: 'explicit',
    reasoningEffort: options.effort ?? null,
    resumeSessionId: options.resume ?? null,
    requestedSessionId,
    context: context.map(({ kind, path: sourcePath }) => ({
      kind,
      path: sourcePath,
    })),
    startedAt: new Date().toISOString(),
  };
  await writeFile(promptPath, prompt, { flag: 'wx' });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    flag: 'wx',
  });
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  // Open artifacts before starting a process so a reused run directory never overwrites evidence.
  await Promise.all([
    new Promise((resolve, reject) =>
      stdout.once('open', resolve).once('error', reject),
    ),
    new Promise((resolve, reject) =>
      stderr.once('open', resolve).once('error', reject),
    ),
  ]);
  const registry = startRun(
    {
      runDir,
      executor: EXECUTOR,
      model,
      effort: options.effort ?? null,
      cwd,
      label: request.label,
    },
    { sessionId: options.resume ?? requestedSessionId },
  );
  const child = spawnSupervised(executable, args, {
    cwd,
    env: childEnv(process.env, EXECUTOR),
    stdio: ['pipe', 'pipe', 'pipe'],
    lifetime: 'one-shot',
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let stderrTail = '';
  const stderrDecoder = new StringDecoder('utf8');
  // Orca managed-provider-process.ts:143.
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(
      -STDERR_TAIL_MAX_CHARS,
    );
  });
  let pending = '';
  const decoder = new StringDecoder('utf8');
  let resultEvent = null;
  let sessionId = null;
  let observedModel = null;
  let rootInit = null;
  let parseError = null;
  const event = (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (typeof value.session_id === 'string') sessionId = value.session_id;
      if (
        value.type === 'system' &&
        value.subtype === 'init' &&
        typeof value.model === 'string'
      )
        observedModel = value.model;
      // Orca claude-structured-session-acquisition.ts:98-101 and claude-turn-opening.ts:44-46.
      if (
        value.type === 'system' &&
        value.subtype === 'init' &&
        typeof value.parent_tool_use_id !== 'string'
      )
        rootInit ??= {
          permissionMode:
            typeof value.permissionMode === 'string' && value.permissionMode
              ? value.permissionMode
              : null,
        };
      if (value.type === 'assistant')
        for (const block of value.message?.content ?? [])
          if (block?.type === 'tool_use')
            recordActivity(runDir, activityText(block));
      if (value.type === 'result') {
        resultEvent = value;
        turnCompleted(runDir, value.subtype);
      }
    } catch (error) {
      parseError ??= error.message;
    }
  };
  child.stdout.on('data', (chunk) => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      event(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  let stdinError = null;
  child.stdin.on('error', (error) => {
    stdinError = error.message;
  });
  child.stdin.end(prompt);
  let received = null;
  const forwardSignal = (signal) => {
    received ??= signal;
    void child.stop(signal);
  };
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error.message;
  });
  const completion = await new Promise((resolve) =>
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal })),
  );
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  pending += decoder.end();
  stderrTail = (stderrTail + stderrDecoder.end()).slice(-STDERR_TAIL_MAX_CHARS);
  if (pending) event(pending);
  // A pipe whose source was cut off at the drain bound never ends its destination.
  for (const file of [stdout, stderr]) if (!file.writableEnded) file.end();
  await Promise.all([finished(stdout), finished(stderr)]);
  const signal =
    received ??
    completion.signal ??
    { 130: 'SIGINT', 143: 'SIGTERM' }[completion.exitCode] ??
    null;
  const denials = resultEvent?.permission_denials ?? [];
  const terminalReason =
    typeof resultEvent?.terminal_reason === 'string'
      ? resultEvent.terminal_reason
      : null;
  const aborted = CLAUDE_ABORTED_TERMINAL_REASONS.has(terminalReason);
  const succeeded =
    !aborted &&
    completion.exitCode === 0 &&
    !parseError &&
    resultEvent?.subtype === 'success' &&
    resultEvent.is_error !== true;
  const status =
    signal || aborted ? 'interrupted' : succeeded ? 'completed' : 'failed';
  const observedPermissionMode = rootInit?.permissionMode ?? null;
  // Orca claude-stream-json-exit-error.ts:17-36, 61: Claude reports a missing
  // conversation on stderr, or in a startup result's errors.
  const resultErrors = Array.isArray(resultEvent?.errors)
    ? resultEvent.errors.filter((entry) => typeof entry === 'string').join('\n')
    : '';
  const missingSession = CLAUDE_MISSING_CONVERSATION.test(stderrTail)
    ? exitText(completion, stderrTail)
    : CLAUDE_MISSING_CONVERSATION.test(resultErrors)
      ? `claude reported a startup failure: ${resultErrors.trim()}`
      : null;
  const [kind, code, cause] = claudeStop({
    received,
    signal,
    missingSession,
    permissionMode: observedPermissionMode,
    terminalReason,
    denials,
    succeeded,
    failure:
      spawnError ??
      parseError ??
      resultEvent?.subtype ??
      exitText(completion, stderrTail),
  });
  const receipt = {
    ...request,
    pid: child.providerPid,
    ...completion,
    descendantsReaped: child.descendantsReaped,
    sessionId,
    observedModel,
    observedPermissionMode,
    terminalReason,
    result: typeof resultEvent?.result === 'string' ? resultEvent.result : null,
    resultEvent,
    registry,
    status,
    stop: {
      // Orca claude-structured-session-acquisition.ts:88-94 trusts only frames of the
      // conversation it named.
      ...stopRecord({
        kind,
        code,
        cause,
        continuable:
          missingSession === null &&
          sessionId !== null &&
          sessionId === (options.resume ?? requestedSessionId),
      }),
      ...(denials.length ? { permissionDenials: denials } : {}),
    },
    spawnError,
    stdinError,
    parseError,
    completedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    promptPath,
    requestPath,
    resultPath,
  };
  stopRun(runDir, receipt.stop);
  writeOnce(resultPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
  process.exitCode =
    (completion.exitCode >= 0 ? completion.exitCode : null) ??
    (completion.signal === 'SIGINT'
      ? 130
      : completion.signal === 'SIGTERM'
        ? 143
        : 1);
  if (process.exitCode === 0 && (parseError || !resultEvent))
    process.exitCode = 1;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') console.log(USAGE);
  else if (options.command === 'detect') {
    const receipt = await detect(options);
    console.log(JSON.stringify(receipt));
    if (!receipt.compatible) process.exitCode = 1;
  } else await run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
