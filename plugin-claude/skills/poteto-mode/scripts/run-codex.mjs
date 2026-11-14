#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAppServerClient } from '../../../vendor/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs';
import { runAppServerTurn } from '../../../vendor/codex-plugin-cc/plugins/codex/scripts/lib/codex.mjs';

const EXECUTOR = 'codex';

const usage = `Usage: node run-codex.mjs detect [--executable ABS]
       node run-codex.mjs catalog [--cwd ABS --executable ABS]
       node run-codex.mjs run --cwd ABS --run-dir ABS --model ID [--effort VALUE]
         [--instruction ABS ...] [--skill ABS ...] [--role ABS]
         [--resume EXACT_THREAD_ID] [--sandbox read-only|workspace-write|danger-full-access]
         [--write] [--executable ABS] [--prompt-file ABS]
Task text comes from --prompt-file or stdin. The run remains foreground until completion.`;

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
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].slice(2);
    if (args[index] === '--write') {
      options.write = true;
      continue;
    }
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
  for (const name of ['cwd', 'run-dir', 'role', 'executable', 'prompt-file']) {
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
    !['read-only', 'workspace-write', 'danger-full-access'].includes(
      options.sandbox,
    )
  )
    throw new Error('Unsupported --sandbox.');
  if (
    options.write &&
    options.sandbox !== undefined &&
    options.sandbox !== 'workspace-write'
  )
    throw new Error('--write conflicts with --sandbox.');
  if (command === 'run')
    for (const name of ['cwd', 'run-dir', 'model'])
      if (!options[name]) throw new Error(`Missing required --${name}.`);
  return options;
}

function serverCommand(options) {
  const name =
    process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
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
  return { executable, args: ['--session-source', 'app-server'] };
}

function cliStatus(options, server) {
  const cwd = options.cwd ?? process.cwd();
  const invoke = (args) =>
    spawnSync(server.executable, args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  const version = invoke(['--version']);
  const appServer =
    !version.error && version.status === 0
      ? invoke([...server.args, '--help'])
      : null;
  const supported =
    !appServer?.error &&
    appServer?.status === 0 &&
    /(?:^|\s)--session-source(?:\s|[=,]|$)/m.test(appServer.stdout);
  return {
    available: Boolean(supported),
    kind: 'standalone-app-server',
    executable: server.executable,
    args: server.args,
    version: version.status === 0 ? version.stdout.trim() : null,
    appServer: Boolean(supported),
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
          : !supported
            ? 'The selected runtime help does not advertise --session-source. Use the official standalone codex-app-server package.'
            : null),
  };
}

async function inspect(options, server) {
  const cli = cliStatus(options, server);
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

function instructionFiles(options) {
  return [
    ...(options.role ? [{ kind: 'role', path: options.role }] : []),
    ...options.instruction.map((file) => ({ kind: 'instruction', path: file })),
    ...options.skill.map((file) => ({ kind: 'skill', path: file })),
  ].map((file) => ({ ...file, body: fs.readFileSync(file.path, 'utf8') }));
}

async function run(options, server) {
  const bodies = instructionFiles(options);
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
    runtime: { kind: 'standalone-app-server', ...server },
    cwd: options.cwd,
    requested,
    resumeThreadId: options.resume ?? null,
    sandbox:
      options.sandbox ?? (options.write ? 'workspace-write' : 'read-only'),
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
    finalText = '',
    terminal = null;
  const observed = { model: null, effort: null };
  const threadSettings = { model: null, effort: null };
  const child = { pid: null, exitCode: null, signal: null, closed: false };
  const pending = new Map();
  const diagnostic = (event) => {
    fs.appendFileSync(
      files.diagnostics,
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
    );
    if (event.event === 'spawn') child.pid = event.pid;
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
      if (['thread/start', 'thread/resume'].includes(method)) {
        threadId = message.result?.thread?.id ?? threadId;
        threadSettings.model = message.result?.model ?? null;
        threadSettings.effort =
          message.result?.reasoningEffort ?? message.result?.effort ?? null;
      }
      if (method === 'turn/start') {
        turnId = message.result?.turn?.id ?? turnId;
        observed.model =
          message.result?.model ?? message.result?.turn?.model ?? null;
        observed.effort =
          message.result?.effort ?? message.result?.turn?.effort ?? null;
      }
    }
    if (message.params?.threadId !== threadId) return;
    if (message.method === 'turn/started') turnId = message.params.turn.id;
    if (message.method === 'turn/completed') terminal = message.params.turn;
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
    runtime = cliStatus(options, server);
    if (!runtime.available)
      throw new Error(
        `Standalone Codex app-server unavailable: ${runtime.error} Download the complete matching-platform package from https://github.com/openai/codex/releases and put its bin directory on inherited PATH for workflows. --executable ABS overrides only this invocation.`,
      );
    result = await runAppServerTurn(options.cwd, {
      direct: true,
      executable: server.executable,
      appServerArgs: server.args,
      signal: controller.signal,
      model: options.model,
      effort: options.effort,
      sandbox: request.sandbox,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      persistThread: true,
      resumeThreadId: options.resume,
      prompt,
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
      data: error.data ?? null,
      stack: error.stack,
    };
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  const status =
    signal || terminal?.status === 'interrupted'
      ? 'interrupted'
      : !failure && result?.status === 0 && terminal?.status === 'completed'
        ? 'completed'
        : 'failed';
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
    runtime: runtime ?? { kind: 'standalone-app-server', ...server },
    cwd: options.cwd,
    sandbox: request.sandbox,
    threadId,
    turnId,
    requested,
    observed,
    threadSettings,
    status,
    resultStatus: result?.status ?? null,
    finalText,
    turn: terminal,
    error: failure ?? result?.error ?? terminal?.error ?? null,
    exitCode,
    signal,
    process: child,
    startedAt,
    finishedAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(files.final, finalText, { flag: 'wx' });
  const temporary = files.result + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  fs.renameSync(temporary, files.result);
  process.exitCode = exitCode;
  return receipt;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') console.log(usage);
  else {
    const server = serverCommand(options);
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
