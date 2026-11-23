#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CodexAppServerClient } from '../../../vendor/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs';
import { runAppServerTurn } from '../../../vendor/codex-plugin-cc/plugins/codex/scripts/lib/codex.mjs';
import {
  claudeHome,
  savedCodexWorkers,
} from '../../setup-pstack/scripts/state.mjs';
import {
  childEnv,
  probeSupervised,
  recordActivity,
  redactValue,
  spawnSupervised,
  startRun,
  stopRecord,
  stopRun,
  turnCompleted,
  writeOnce,
} from './worker-runtime.mjs';

const EXECUTOR = 'codex';

const usage = `Usage: node run-codex.mjs detect [--executable ABS] [--codex-workers hidden|visible]
       node run-codex.mjs catalog [--cwd ABS --executable ABS] [--codex-workers hidden|visible]
       node run-codex.mjs run --cwd ABS --run-dir ABS --model ID [--effort VALUE]
         [--instruction ABS ...] [--skill ABS ...] [--role ABS]
         [--resume EXACT_THREAD_ID] [--sandbox workspace-write|danger-full-access]
         [--executable ABS] [--prompt-file ABS] [--label TEXT]
         [--approve-review REVIEW_ID --review-receipt ABS]
Task text comes from --prompt-file or stdin. The run remains foreground until completion.
--label names the run in workers.mjs status and the run's events.jsonl.
The saved codexWorkers setting selects the server. --codex-workers overrides it
for one detect or catalog probe.
--approve-review records the user's approval of one denied review listed in the
--review-receipt result before the resumed turn starts. It requires --resume.`;

function parse(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (!['detect', 'catalog', 'run'].includes(command)) throw new Error(usage);
  const options = { command, instruction: [], skill: [] };
  const values = new Set([
    'cwd',
    'run-dir',
    'model',
    'effort',
    'sandbox',
    'instruction',
    'skill',
    'role',
    'resume',
    'executable',
    'prompt-file',
    'approve-review',
    'review-receipt',
    'codex-workers',
    'label',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].slice(2);
    if (!args[index].startsWith('--') || !values.has(name))
      throw new Error(`Unknown argument ${args[index]}.`);
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for --${name}.`);
    if (['instruction', 'skill'].includes(name)) options[name].push(value);
    else if (options[name] !== undefined)
      throw new Error(`Duplicate --${name}.`);
    else options[name] = value;
  }
  for (const name of [
    'cwd',
    'run-dir',
    'role',
    'executable',
    'prompt-file',
    'review-receipt',
  ]) {
    if (options[name] !== undefined && !path.isAbsolute(options[name]))
      throw new Error(`--${name} must be an absolute path.`);
  }
  for (const name of ['instruction', 'skill'])
    for (const file of options[name]) {
      if (!path.isAbsolute(file))
        throw new Error(`--${name} must be an absolute path.`);
    }
  if (
    options.sandbox !== undefined &&
    !['workspace-write', 'danger-full-access'].includes(options.sandbox)
  )
    throw new Error('Unsupported --sandbox.');
  if (
    (options['approve-review'] === undefined) !==
    (options['review-receipt'] === undefined)
  )
    throw new Error('--approve-review and --review-receipt go together.');
  if (options['approve-review'] !== undefined && options.resume === undefined)
    throw new Error('--approve-review requires --resume.');
  if (options['codex-workers'] !== undefined) {
    if (command === 'run')
      throw new Error('run uses the saved codexWorkers setting.');
    if (!Object.hasOwn(runtimes, options['codex-workers']))
      throw new Error('--codex-workers must be hidden or visible.');
  }
  if (command === 'run')
    for (const name of ['cwd', 'run-dir', 'model'])
      if (!options[name]) throw new Error(`Missing required --${name}.`);
  return options;
}

const runtimes = {
  hidden: {
    kind: 'standalone-app-server',
    name: 'codex-app-server',
    args: ['--session-source', 'app-server'],
    helpError: (help) =>
      /(?:^|\s)--session-source(?:\s|[=,]|$)/m.test(help)
        ? null
        : 'The selected runtime help does not advertise --session-source. Use the official standalone codex-app-server package.',
    unavailable:
      'Standalone Codex app-server unavailable for hidden Codex workers: ERROR Download the complete matching-platform package from https://github.com/openai/codex/releases and put its bin directory on inherited PATH for workflows, or save codexWorkers as visible through setup to use the Codex CLI. --executable ABS overrides only this invocation.',
  },
  visible: {
    kind: 'codex-cli',
    name: 'codex',
    args: ['app-server'],
    helpError: () => null,
    unavailable:
      'Codex CLI app-server unavailable for visible Codex workers: ERROR Install the official Codex CLI with npm i -g @openai/codex and keep codex on inherited PATH for workflows. --executable ABS overrides only this invocation.',
  },
};

async function serverCommand(options) {
  const workers =
    options['codex-workers'] ?? (await savedCodexWorkers(claudeHome()));
  const runtime = runtimes[workers];
  const name =
    process.platform === 'win32' ? `${runtime.name}.exe` : runtime.name;
  const executable =
    options.executable ??
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.resolve(directory, name))
      .find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      }) ??
    name;
  return { workers, kind: runtime.kind, executable, args: runtime.args };
}

async function cliStatus(options, server) {
  const cwd = options.cwd ?? process.cwd();
  const invoke = (args) =>
    probeSupervised(server.executable, args, {
      cwd,
      env: childEnv(process.env, EXECUTOR),
      timeout: 10_000,
    });
  const version = await invoke(['--version']);
  const appServer =
    !version.error && version.status === 0
      ? await invoke([...server.args, '--help'])
      : null;
  const helpError =
    !appServer?.error && appServer?.status === 0
      ? runtimes[server.workers].helpError(appServer.stdout)
      : null;
  const supported =
    !appServer?.error && appServer?.status === 0 && helpError === null;
  return {
    available: supported,
    workers: server.workers,
    kind: server.kind,
    executable: server.executable,
    args: server.args,
    version: version.status === 0 ? version.stdout.trim() : null,
    appServer: supported,
    error:
      version.error?.message ??
      appServer?.error?.message ??
      (version.status !== 0
        ? version.stderr.trim() ||
          version.stdout.trim() ||
          `exit ${version.status}`
        : appServer?.status !== 0
          ? appServer?.stderr.trim() ||
            appServer?.stdout.trim() ||
            `exit ${appServer?.status}`
          : helpError),
  };
}

async function inspect(options, server) {
  const cli = await cliStatus(options, server);
  const result = {
    schemaVersion: 1,
    cli,
    auth: {
      available: false,
      loggedIn: null,
      method: null,
      verified: false,
      requiresOpenaiAuth: null,
      error: null,
    },
    execution: { verified: false },
  };
  if (options.command === 'catalog')
    Object.assign(result, { models: [], pages: [] });
  if (!cli.available) return result;
  let client;
  try {
    client = await CodexAppServerClient.connect(options.cwd ?? process.cwd(), {
      disableBroker: true,
      executable: server.executable,
      appServerArgs: server.args,
      env: childEnv(process.env, EXECUTOR),
      spawn: spawnSupervised,
    });
    const account = await client.request('account/read', {
      refreshToken: false,
    });
    const method =
      typeof account?.account?.type === 'string' && account.account.type.length
        ? account.account.type
        : null;
    result.auth = {
      available: true,
      loggedIn:
        method !== null || account?.requiresOpenaiAuth === false
          ? true
          : account?.account === null && account?.requiresOpenaiAuth === true
            ? false
            : null,
      method,
      verified: method === 'chatgpt',
      requiresOpenaiAuth:
        typeof account?.requiresOpenaiAuth === 'boolean'
          ? account.requiresOpenaiAuth
          : null,
      error: null,
    };
    if (options.command === 'catalog') {
      let cursor = null;
      const seen = new Set();
      do {
        const page = await client.request('model/list', {
          cursor,
          includeHidden: true,
        });
        result.pages.push(page);
        result.models.push(...(page.data ?? []));
        cursor = page.nextCursor ?? null;
        if (cursor !== null && seen.has(cursor))
          throw new Error('model/list repeated its pagination cursor.');
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
    }
  } catch (error) {
    result.error = error.message;
    if (!result.auth.available) result.auth.error = error.message;
  } finally {
    await client?.close();
  }
  return result;
}

function turnSettings(rolloutPath, turnId) {
  const settings = { model: null, effort: null };
  if (!rolloutPath || !turnId) return settings;
  let text;
  try {
    text = fs.readFileSync(rolloutPath, 'utf8');
  } catch {
    return settings;
  }
  for (const line of text.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'turn_context' || record.payload?.turn_id !== turnId)
      continue;
    settings.model = record.payload.model ?? null;
    settings.effort = record.payload.effort ?? null;
  }
  return settings;
}

function activityText(item) {
  switch (item?.type) {
    case 'commandExecution':
      return `running: ${item.command}`;
    case 'fileChange':
      return `editing ${(item.changes ?? []).map((change) => change.path).join(', ')}`;
    case 'mcpToolCall':
      return `tool: ${item.server}/${item.tool}`;
    case 'dynamicToolCall':
      return `tool: ${item.tool}`;
    case 'webSearch':
      return `searching: ${item.query}`;
    default:
      return null;
  }
}

// Orca codex-authentication-failure.ts: only the unauthorized variant, or an HTTP
// failure carrying 401, proves sign-out. Variants are strings or single-key objects.
const HTTP_ERROR_KINDS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
];
function signedOut(error) {
  const info = error?.codexErrorInfo;
  const [variant, fields] =
    typeof info === 'string' ? [info] : (Object.entries(info ?? {})[0] ?? []);
  return (
    variant === 'unauthorized' ||
    (fields?.httpStatusCode === 401 && HTTP_ERROR_KINDS.includes(variant))
  );
}

// Orca codex-structured-thread-open.ts: only this thread-specific resume refusal proves no rollout.
const noRollout = (failure, threadId) =>
  failure?.method === 'thread/resume' &&
  failure.data?.code === -32600 &&
  failure.message.endsWith(`no rollout found for thread id ${threadId}`);

// Orca codex-structured-read-only.ts and codex-server-request-disposition.ts:
// nobody watches a worker, so every blocking request gets a safe answer.
const UNATTENDED_ANSWERS = new Map([
  ['item/commandExecution/requestApproval', { result: { decision: 'decline' } }],
  ['item/fileChange/requestApproval', { result: { decision: 'decline' } }],
  [
    'mcpServer/elicitation/request',
    { result: { action: 'decline', content: null, _meta: null } },
  ],
  [
    'item/tool/requestUserInput',
    {
      error: {
        code: -32001,
        message: 'Nobody is watching this worker to answer.',
      },
    },
  ],
  [
    'item/permissions/requestApproval',
    { result: { permissions: {}, scope: 'turn', strictAutoReview: true } },
  ],
  ['item/tool/call', { result: { contentItems: [], success: false } }],
  ['applyPatchApproval', { result: { decision: 'abort' } }],
  ['execCommandApproval', { result: { decision: 'abort' } }],
  [
    'account/chatgptAuthTokens/refresh',
    {
      error: {
        code: -32001,
        message: 'pstack cannot refresh app-server auth tokens',
      },
    },
  ],
  [
    'attestation/generate',
    {
      error: { code: -32001, message: 'pstack did not negotiate attestation' },
    },
  ],
]);
const unattendedAnswer = (method) =>
  UNATTENDED_ANSWERS.get(method) ?? {
    error: {
      code: -32000,
      message: `pstack rejected unrecognized blocking request ${method}`,
    },
  };

const snakeCase = (value) =>
  value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function approvedAssessment(options) {
  if (options['approve-review'] === undefined) return null;
  const prior = JSON.parse(fs.readFileSync(options['review-receipt'], 'utf8'));
  if (prior.threadId !== options.resume)
    throw new Error('--review-receipt records a different thread.');
  const review = (prior.deniedReviews ?? []).find(
    (entry) => entry.reviewId === options['approve-review'],
  );
  if (!review)
    throw new Error(
      `--review-receipt lists no denied review ${options['approve-review']}.`,
    );
  const { type, ...fields } = review.action;
  if (
    ![
      'command',
      'execve',
      'applyPatch',
      'networkAccess',
      'mcpToolCall',
    ].includes(type)
  )
    throw new Error(`Approving a denied ${type} action is unsupported.`);
  const action = { type: snakeCase(type) };
  for (const [key, value] of Object.entries(fields))
    action[snakeCase(key)] = ['protocol', 'source'].includes(key)
      ? snakeCase(value)
      : value;
  return {
    id: review.reviewId,
    // Orca codex-auto-review-denial.ts: the reviewed item, when the review names one.
    ...(typeof review.targetItemId === 'string' && review.targetItemId.trim()
      ? { target_item_id: review.targetItemId }
      : {}),
    turn_id: review.turnId,
    started_at_ms: review.startedAtMs,
    completed_at_ms: review.completedAtMs,
    status: 'denied',
    risk_level: review.review.riskLevel,
    user_authorization: review.review.userAuthorization,
    rationale: review.review.rationale,
    decision_source: review.decisionSource,
    action,
  };
}

function instructionFiles(options) {
  return [
    ...(options.role ? [{ kind: 'role', path: options.role }] : []),
    ...options.instruction.map((file) => ({ kind: 'instruction', path: file })),
    ...options.skill.map((file) => ({ kind: 'skill', path: file })),
  ].map((file) => ({ ...file, body: fs.readFileSync(file.path, 'utf8') }));
}

async function run(options, server) {
  const bodies = instructionFiles(options);
  const approval = approvedAssessment(options);
  const task = fs.readFileSync(options['prompt-file'] ?? 0, 'utf8');
  if (!task.trim()) throw new Error('A nonempty task is required.');
  const prompt = [
    ...bodies.map(
      (file) => `Complete ${file.kind} body from ${file.path}\n\n${file.body}`,
    ),
    `Receiving executor is ${EXECUTOR}.\n\n${fs.readFileSync(new URL('../references/worker-context.md', import.meta.url), 'utf8')}`,
    `Task\n\n${task}`,
  ]
    .join('\n\n')
    .trim();
  const directory = options['run-dir'];
  fs.mkdirSync(directory, { recursive: true });
  const files = Object.fromEntries(
    Object.entries({
      request: 'request.json',
      prompt: 'prompt.txt',
      progress: 'progress.jsonl',
      diagnostics: 'diagnostics.jsonl',
      result: 'result.json',
      final: 'final.txt',
    }).map(([name, file]) => [name, path.join(directory, file)]),
  );
  const startedAt = new Date().toISOString();
  const requested = { model: options.model, effort: options.effort ?? null };
  const request = {
    schemaVersion: 1,
    executor: EXECUTOR,
    runtime: server,
    cwd: options.cwd,
    label: options.label ?? null,
    requested,
    resumeThreadId: options.resume ?? null,
    approvedReview: approval && {
      reviewId: approval.id,
      receipt: options['review-receipt'],
      event: approval,
    },
    sandbox: options.sandbox ?? 'workspace-write',
    instructions: bodies,
    task,
    startedAt,
  };
  fs.writeFileSync(files.request, JSON.stringify(request, null, 2) + '\n', {
    flag: 'wx',
  });
  fs.writeFileSync(files.prompt, prompt, { flag: 'wx' });
  fs.writeFileSync(files.progress, '', { flag: 'wx' });
  fs.writeFileSync(files.diagnostics, '', { flag: 'wx' });
  const registry = startRun(
    {
      runDir: directory,
      executor: EXECUTOR,
      model: options.model,
      effort: options.effort ?? null,
      cwd: options.cwd,
      label: request.label,
    },
    options.resume ? { threadId: options.resume } : {},
  );
  const controller = new AbortController();
  let signal = null;
  const stop = (value) => {
    signal ??= value;
    controller.abort(new Error(`Received ${value}.`));
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let threadId = null,
    turnId = null,
    rolloutPath = null,
    finalText = '',
    terminal = null;
  const threadSettings = { model: null, effort: null };
  const deniedReviews = [];
  let interrupt = null;
  const clientRequests = [];
  const child = { pid: null, exitCode: null, signal: null, closed: false };
  let provider = null,
    providerClosed = null;
  const supervisedSpawn = (...spawnArgs) => {
    provider = spawnSupervised(...spawnArgs);
    // Close carries the supervisor's last report, whether it killed descendants.
    providerClosed = new Promise((resolve) => provider.once('close', resolve));
    return provider;
  };
  const pending = new Map();
  const diagnostic = (event) => {
    fs.appendFileSync(
      files.diagnostics,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
    );
    if (event.event === 'exit')
      Object.assign(child, {
        exitCode: event.code,
        signal: event.signal,
        closed: true,
      });
    if (event.direction === 'send' && event.message.id !== undefined)
      pending.set(event.message.id, event.message.method);
    if (event.direction !== 'receive') return;
    let message;
    try {
      message = JSON.parse(event.line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const method = pending.get(message.id);
      pending.delete(message.id);
      // A resume that opened another thread proves no identity to continue.
      if (
        method === 'thread/start' ||
        (method === 'thread/resume' &&
          message.result?.thread?.id === options.resume)
      ) {
        threadId = message.result?.thread?.id ?? threadId;
        rolloutPath = message.result?.thread?.path ?? rolloutPath;
        threadSettings.model = message.result?.model ?? null;
        threadSettings.effort =
          message.result?.reasoningEffort ?? message.result?.effort ?? null;
      }
      if (method === 'turn/start') turnId = message.result?.turn?.id ?? turnId;
    }
    if (message.params?.threadId !== threadId) return;
    if (message.method === 'turn/started') turnId = message.params.turn.id;
    if (message.method === 'item/started') {
      const activity = activityText(message.params.item);
      if (activity) recordActivity(directory, activity);
    }
    if (message.method === 'turn/completed') {
      terminal = message.params.turn;
      turnCompleted(directory, terminal?.status);
    }
    if (
      message.method === 'item/autoApprovalReview/completed' &&
      message.params.review?.status === 'denied'
    )
      deniedReviews.push(message.params);
    if (
      message.method === 'item/completed' &&
      message.params.item?.type === 'agentMessage'
    )
      finalText = message.params.item.text ?? finalText;
  };
  let result = null,
    failure = null,
    runtime = null;
  try {
    runtime = await cliStatus(options, server);
    if (!runtime.available)
      throw new Error(
        runtimes[server.workers].unavailable.replace('ERROR', () => runtime.error),
      );
    result = await runAppServerTurn(options.cwd, {
      direct: true,
      executable: server.executable,
      appServerArgs: server.args,
      env: childEnv(process.env, EXECUTOR),
      spawn: supervisedSpawn,
      signal: controller.signal,
      model: options.model,
      effort: options.effort,
      sandbox: request.sandbox,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      persistThread: true,
      resumeThreadId: options.resume,
      beforeTurn:
        approval &&
        ((client, id) =>
          client.request('thread/approveGuardianDeniedAction', {
            threadId: id,
            event: approval,
          })),
      prompt,
      onInterrupt: (outcome) => (interrupt = outcome),
      answerServerRequest: ({ method }) => {
        const answer = unattendedAnswer(method);
        clientRequests.push({ method, answer });
        return answer;
      },
      onDiagnostic: diagnostic,
      onProgress: (update) => {
        if (typeof update === 'object') {
          threadId = update.threadId ?? threadId;
          turnId = update.turnId ?? turnId;
        }
        fs.appendFileSync(
          files.progress,
          JSON.stringify({ at: new Date().toISOString(), update }) + '\n',
        );
      },
    });
    threadId = result.threadId;
    turnId = result.turnId;
    finalText = result.finalMessage ?? finalText;
    terminal = result.turn;
  } catch (error) {
    failure = {
      message: error.message,
      code: error.code ?? null,
      method: error.method ?? null,
      data: error.data ?? null,
      stack: error.stack,
    };
    diagnostic({ event: 'failure', failure });
  } finally {
    await providerClosed;
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  const status =
    signal || terminal?.status === 'interrupted'
      ? 'interrupted'
      : !failure && result?.status === 0 && terminal?.status === 'completed'
        ? 'completed'
        : 'failed';
  const [stopKind, stopCode, stopCause] = signal
    ? ['interrupted', 'signal', signal]
    : terminal?.status === 'interrupted'
      ? ['interrupted', 'failed', 'native']
      : deniedReviews.length
        ? ['permission', 'permission-denied', 'denied review']
        : status === 'completed'
          ? ['completed', 'completed', 'completed']
          : [
              'error',
              signedOut(terminal?.error) || signedOut(result?.error)
                ? 'not-signed-in'
                : noRollout(failure, options.resume)
                  ? 'missing-session'
                  : 'failed',
              failure?.message ?? 'failed',
            ];
  child.pid = provider?.providerPid ?? null;
  child.descendantsReaped = provider?.descendantsReaped ?? null;
  const exitCode =
    signal === 'SIGINT'
      ? 130
      : signal === 'SIGTERM'
        ? 143
        : status === 'completed'
          ? 0
          : 1;
  const receipt = {
    schemaVersion: 1,
    executor: EXECUTOR,
    runtime: runtime ?? server,
    cwd: options.cwd,
    label: request.label,
    sandbox: request.sandbox,
    threadId,
    turnId,
    rolloutPath,
    requested,
    observed: turnSettings(rolloutPath, turnId),
    threadSettings,
    approvedReview: request.approvedReview?.reviewId ?? null,
    deniedReviews,
    clientRequests,
    registry,
    status,
    stop: stopRecord({
      kind: stopKind,
      code: stopCode,
      cause: stopCause,
      continuable: threadId !== null,
    }),
    resultStatus: result?.status ?? null,
    finalText,
    turn: terminal && { ...terminal, error: redactValue(terminal.error) },
    error: redactValue(failure ?? result?.error ?? terminal?.error ?? null),
    exitCode,
    signal,
    interrupt: redactValue(interrupt),
    process: child,
    startedAt,
    finishedAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(files.final, finalText, { flag: 'wx' });
  stopRun(directory, receipt.stop);
  writeOnce(files.result, JSON.stringify(receipt, null, 2) + '\n');
  process.exitCode = exitCode;
  return receipt;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') console.log(usage);
  else {
    const server = await serverCommand(options);
    console.log(
      JSON.stringify(
        options.command === 'run'
          ? await run(options, server)
          : await inspect(options, server),
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
