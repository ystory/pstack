import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(
  new URL('../plugin-claude/skills/poteto-mode/scripts/', import.meta.url),
);
const runtime = await import(path.join(scripts, 'worker-runtime.mjs'));

async function temporary(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack-worker-runtime-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const jsonLines = async (file: string) =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('childEnv removes the launching session and keeps everything else', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/fixture',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CODEX_THREAD_ID: 'parent-thread',
    CODEX_HOME: '/codex/home',
    GEMINI_API_KEY: 'gemini-key',
    GOOGLE_API_KEY: 'google-key',
  };
  const kept = {
    PATH: '/usr/bin',
    HOME: '/home/fixture',
    CODEX_HOME: '/codex/home',
  };
  for (const executor of ['codex', 'claude-code'])
    assert.deepEqual(runtime.childEnv(base, executor), {
      ...kept,
      GEMINI_API_KEY: 'gemini-key',
      GOOGLE_API_KEY: 'google-key',
    });
  assert.deepEqual(runtime.childEnv(base, 'antigravity'), {
    ...kept,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  });
  assert.equal(base.CLAUDECODE, '1');
});

test('redact masks credentials and keeps the end of long text', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const masked = runtime.redact(
    `fetch https://user:pass@example.invalid failed\napi_key=plain-secret\nOPENAI_TOKEN=abc\nAuthorization: Bearer abc.def\n${token}`,
  );
  for (const secret of [token, 'plain-secret', 'user:pass', 'abc.def', '=abc'])
    assert.equal(masked.includes(secret), false, masked);
  assert.match(masked, /\[redacted:github-token\]/);
  const long = `${'start '.repeat(500)}api_token=hidden the failure is here`;
  const tail = runtime.redact(long, 100);
  assert.equal(tail.length, 100);
  assert.ok(tail.startsWith('…'));
  assert.ok(
    tail.endsWith('api_token=[redacted:labeled-kv] the failure is here'),
    tail,
  );
});

test('redaction masks the credential forms Orca masks, in text and structured errors', () => {
  const capability = `dcap_${'fixture'.repeat(4)}`;
  assert.equal(
    runtime.redact(`rejected ${capability}`),
    'rejected [dispatch capability redacted]',
  );
  assert.equal(
    runtime.redact('SERVICE_AUTH=\n fixture-value'),
    'SERVICE_AUTH=[redacted:env-value]',
  );
  const error: {
    message: string;
    data: Record<string, unknown>;
    codes: unknown[];
  } = {
    message: 'authentication failed: Bearer sample-only',
    data: {
      api_key: 'sample-only',
      apiKey: 'sample-only',
      token: 'sample-only',
      password: 'sample-only',
      detail: 'kept',
    },
    codes: [401, 'retry with Bearer sample-only'],
  };
  error.data.self = error;
  assert.deepEqual(runtime.redactValue(error), {
    message: 'authentication failed: [redacted:labeled-kv]',
    data: { detail: 'kept', self: '[Circular]' },
    codes: [401, 'retry with [redacted:labeled-kv]'],
  });
});

test('stop records accept only the typed kinds and codes and redact the cause', () => {
  assert.deepEqual(
    runtime.stopRecord({
      kind: 'error',
      code: 'failed',
      cause: 'login failed: db_password=hunter2',
      continuable: false,
    }),
    {
      kind: 'error',
      code: 'failed',
      cause: 'login failed: db_password=[redacted:labeled-kv]',
      continuable: false,
    },
  );
  assert.throws(
    () =>
      runtime.stopRecord({
        kind: 'error',
        code: 'mystery',
        cause: '',
        continuable: false,
      }),
    TypeError,
  );
});

test('startRun registers each run once and opens its event log', async (t) => {
  const root = await temporary(t);
  const env = { PSTACK_STATE_HOME: path.join(root, 'state') };
  const runDir = path.join(root, 'run');
  await mkdir(runDir);
  const run = {
    runDir,
    executor: 'codex',
    model: 'model-fixture',
    effort: 'low',
    cwd: root,
    label: 'review the\nparser',
  };
  const first = runtime.startRun(run, { threadId: 'thread-fixture' }, env);
  const second = runtime.startRun(run, {}, env);
  assert.notEqual(first.runId, second.runId);
  assert.match(first.runId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  const runs = path.join(root, 'state/runs');
  assert.deepEqual(
    (await readdir(runs)).sort(),
    [`${first.runId}.json`, `${second.runId}.json`].sort(),
  );
  const { startedAt, ...entry } = JSON.parse(
    await readFile(path.join(runs, `${first.runId}.json`), 'utf8'),
  );
  assert.deepEqual(entry, { runId: first.runId, ...run, pid: process.pid });
  assert.ok(!Number.isNaN(Date.parse(startedAt)));
  runtime.recordActivity(runDir, 'running: pnpm test\n  --filter x');
  runtime.stopRun(runDir, { kind: 'completed', code: 'completed' });
  const events = await jsonLines(path.join(runDir, 'events.jsonl'));
  assert.deepEqual(
    events.map(({ ts, ...event }) => {
      assert.ok(!Number.isNaN(Date.parse(ts)));
      return event;
    }),
    [
      {
        type: 'started',
        text: 'started codex model-fixture: review the parser',
        runDir,
        executor: 'codex',
        model: 'model-fixture',
        effort: 'low',
        cwd: root,
        label: 'review the\nparser',
        pid: process.pid,
        threadId: 'thread-fixture',
      },
      {
        type: 'started',
        text: 'started codex model-fixture: review the parser',
        runDir,
        executor: 'codex',
        model: 'model-fixture',
        effort: 'low',
        cwd: root,
        label: 'review the\nparser',
        pid: process.pid,
      },
      { type: 'activity', text: 'running: pnpm test --filter x' },
      {
        type: 'stopped',
        text: 'stopped: completed (completed)',
        kind: 'completed',
        code: 'completed',
      },
    ],
  );
  assert.throws(() => runtime.appendEvent(runDir, 'question', 'later'));
});

test('a run whose registration fails still opens its event log and records why', async (t) => {
  const root = await temporary(t);
  const blocked = path.join(root, 'state is a file');
  await writeFile(blocked, '');
  const runDir = path.join(root, 'run');
  await mkdir(runDir);
  const registry = runtime.startRun(
    { runDir, executor: 'claude-code', model: 'model-fixture', cwd: root },
    {},
    { PSTACK_STATE_HOME: blocked },
  );
  assert.match(registry.error, /ENOTDIR/);
  assert.deepEqual(
    (await jsonLines(path.join(runDir, 'events.jsonl'))).map(
      (event) => event.type,
    ),
    ['started'],
  );
});

test('an interrupted registry write leaves no entry, and status skips an unreadable one', async (t) => {
  const root = await temporary(t);
  const state = path.join(root, 'state');
  const env = { ...process.env, PSTACK_STATE_HOME: state };
  const healthy = runtime.startRun(
    { runDir: root, executor: 'codex', model: 'healthy-model', cwd: root },
    {},
    env,
  );
  // A 512-byte file size limit kills the writer partway through a long entry.
  const register = `import { registerRun } from ${JSON.stringify(path.join(scripts, 'worker-runtime.mjs'))};
registerRun({ runDir: process.cwd(), cwd: process.cwd(), pid: process.pid, executor: 'codex', model: 'fixture', label: 'ordinary label '.repeat(50) });`;
  const interrupted = spawnSync(
    '/bin/sh',
    [
      '-c',
      'ulimit -c 0; ulimit -f 1; exec "$0" --input-type=module -e "$1"',
      process.execPath,
      register,
    ],
    { env, cwd: root },
  );
  assert.notEqual(interrupted.status, 0);
  const runs = path.join(state, 'runs');
  assert.deepEqual(
    (await readdir(runs)).filter((name) => name.endsWith('.json')),
    [`${healthy.runId}.json`],
  );
  await writeFile(path.join(runs, 'zz-truncated.json'), '{"runId": "zz-');
  const status = spawnSync(
    process.execPath,
    [path.join(scripts, 'workers.mjs'), 'status', '--all', '--json'],
    { encoding: 'utf8', env },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(
    JSON.parse(status.stdout).map((run: { runId: string }) => run.runId),
    [healthy.runId],
  );
  assert.match(status.stderr, /Skipped registry entry zz-truncated\.json/);
});

// Like the supervisor, count EPERM as present: macOS reports it for a group of unreaped zombies.
const alive = (pid: number, group = false) => {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

async function waitUntil(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function supervisedFixture(t: TestContext) {
  const root = await temporary(t);
  // A provider and its descendant that both ignore SIGTERM, so only the ladder's SIGKILL ends them.
  const provider = path.join(root, 'provider.mjs');
  await writeFile(
    provider,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(descendant.pid));
setInterval(() => {}, 1000);
`,
  );
  const owner = path.join(root, 'owner.mjs');
  await writeFile(
    owner,
    `import { spawnSupervised } from ${JSON.stringify(path.join(scripts, 'worker-runtime.mjs'))};
const [lifetime, provider, pidFile] = process.argv.slice(2);
const child = spawnSupervised(process.execPath, [provider, pidFile], { lifetime });
child.on('error', () => {});
child.stdout.resume();
child.stderr.resume();
const ready = setInterval(() => {
  if (!child.providerPid) return;
  clearInterval(ready);
  console.log(JSON.stringify({ providerPid: child.providerPid, supervisorPid: child.pid }));
}, 10);
`,
  );
  return { root, provider, owner };
}

test('the supervisor runs its whole ladder on the provider group after its owner is SIGKILLed', async (t) => {
  const f = await supervisedFixture(t);
  const ladder = async (lifetime: string, minimumMs: number) => {
    const pidFile = path.join(f.root, `${lifetime}.pid`);
    const owner = spawn(
      process.execPath,
      [f.owner, lifetime, f.provider, pidFile],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const [line] = (await once(owner.stdout, 'data')) as [Buffer];
    const { providerPid, supervisorPid } = JSON.parse(line.toString());
    assert.ok(await waitUntil(() => existsSync(pidFile), 5000));
    const descendant = Number(await readFile(pidFile, 'utf8'));
    owner.kill('SIGKILL');
    const killedAt = Date.now();
    assert.ok(
      await waitUntil(
        () => !alive(providerPid, true),
        runtime.SUPERVISOR_MAX_STOP_MS + 1000,
      ),
      `${lifetime} provider group outlived the ladder`,
    );
    const elapsed = Date.now() - killedAt;
    assert.ok(
      elapsed >= minimumMs,
      `${lifetime} group was killed before its grace: ${elapsed} ms`,
    );
    assert.equal(alive(descendant), false);
    assert.ok(await waitUntil(() => !alive(supervisorPid), 2000));
  };
  // A session gets its stdin-end grace before SIGTERM; a one-shot goes straight to SIGTERM.
  await Promise.all([
    ladder(
      'session',
      runtime.STDIN_END_GRACE_MS + runtime.SIGTERM_GRACE_MS - 500,
    ),
    ladder('one-shot', runtime.SIGTERM_GRACE_MS - 500),
  ]);
});

test('a provider that never starts fails like a direct spawn', async (t) => {
  const root = await temporary(t);
  const child = runtime.spawnSupervised(path.join(root, 'missing-cli'), [], {
    lifetime: 'one-shot',
  });
  const events: string[] = [];
  child.on('exit', () => events.push('exit'));
  // Node emits close in the same tick as error, so both listeners go on first.
  const errored = new Promise<NodeJS.ErrnoException>((resolve) =>
    child.once('error', resolve),
  );
  const closed = new Promise((resolve) =>
    child.once('close', (...args: unknown[]) => resolve(args)),
  );
  const error = await errored;
  const [code, signal] = (await closed) as [number, null];
  assert.equal(error.code, 'ENOENT');
  assert.match(error.message, /missing-cli ENOENT/);
  assert.deepEqual(
    [code, signal, events],
    [-os.constants.errno.ENOENT, null, []],
  );
  assert.equal(child.providerPid, null);
  assert.equal(child.descendantsReaped, null);
});

test('a supervised provider relays its output and exit status and takes its helpers with it', async (t) => {
  const root = await temporary(t);
  const pidFile = path.join(root, 'helper.pid');
  const child = runtime.spawnSupervised(
    process.execPath,
    [
      '-e',
      `const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
helper.unref();
require('node:fs').writeFileSync(process.argv[1], String(helper.pid));
let input = '';
process.stdin.on('data', (bytes) => { input += bytes; });
process.stdin.on('end', () => {
  process.stdout.write('read ' + input);
  process.stderr.write('diagnostic');
  process.exitCode = 3;
});`,
      pidFile,
    ],
    { lifetime: 'one-shot' },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => (stdout += bytes));
  child.stderr.on('data', (bytes: Buffer) => (stderr += bytes));
  child.stdin.end('task');
  const [exit] = await Promise.all([once(child, 'exit'), once(child, 'close')]);
  assert.deepEqual(exit, [3, null]);
  assert.deepEqual([stdout, stderr], ['read task', 'diagnostic']);
  assert.ok(Number.isSafeInteger(child.providerPid));
  assert.notEqual(child.providerPid, child.pid);
  assert.equal(alive(child.providerPid, true), false);
  assert.equal(alive(Number(await readFile(pidFile, 'utf8'))), false);
});

test('the supervisor reports whether it killed descendants that outlived the provider', async (t) => {
  const root = await temporary(t);
  const pidFile = path.join(root, 'helper.pid');
  for (const [script, reaped] of [
    [
      `const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
helper.unref();
require('node:fs').writeFileSync(process.argv[1], String(helper.pid));`,
      true,
    ],
    ['', false],
  ] as const) {
    const child = runtime.spawnSupervised(
      process.execPath,
      ['-e', script, pidFile],
      { lifetime: 'one-shot', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.resume();
    child.stderr.resume();
    assert.equal(child.descendantsReaped, null);
    await once(child, 'close');
    assert.equal(child.descendantsReaped, reaped);
  }
  assert.equal(alive(Number(await readFile(pidFile, 'utf8'))), false);
});

test("stop ends a one-shot provider through the supervisor and close reports the provider's own exit", async (t) => {
  await temporary(t);
  for (const [reason, signal] of [
    ['deadline', 'SIGTERM'],
    ['SIGINT', 'SIGINT'],
  ]) {
    const child = runtime.spawnSupervised(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(23)); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { lifetime: 'one-shot', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stderr.resume();
    await once(child.stdout, 'data');
    child.stdout.resume();
    const closed = once(child, 'close');
    const startedAt = Date.now();
    await child.stop(reason);
    assert.deepEqual(await closed, [23, null]);
    // The supervisor itself exits as Orca's does, with the stop's signal.
    assert.equal(child.signalCode, signal);
    assert.ok(Date.now() - startedAt < runtime.SIGTERM_GRACE_MS);
    assert.equal(child.stopReason, reason);
    assert.equal(child.descendantsReaped, false);
    assert.equal(alive(child.providerPid, true), false);
  }
});

test('a provider killed by a signal Node ignores reports that signal', async (t) => {
  await temporary(t);
  const child = runtime.spawnSupervised(
    '/bin/sh',
    ['-c', 'kill -PIPE $$'],
    { lifetime: 'one-shot', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const [exit, close] = await Promise.all([
    once(child, 'exit'),
    once(child, 'close'),
  ]);
  assert.deepEqual(
    [exit, close],
    [
      [null, 'SIGPIPE'],
      [null, 'SIGPIPE'],
    ],
  );
});

const workers = path.join(scripts, 'workers.mjs');

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'close');
  return child.pid!;
}

test('status derives running, finished, and lost runs from their run directories', async (t) => {
  const root = await temporary(t);
  const state = path.join(root, 'state');
  await mkdir(path.join(state, 'runs'), { recursive: true });
  const sleeper = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  t.after(() => sleeper.kill());
  const deadPid = await exitedPid();
  const register = async (
    runId: string,
    cwd: string,
    pid: number,
    receipt?: object,
  ) => {
    const runDir = path.join(root, runId);
    await mkdir(runDir, { recursive: true });
    if (receipt)
      await writeFile(
        path.join(runDir, 'result.json'),
        JSON.stringify(receipt),
      );
    await writeFile(
      path.join(state, 'runs', `${runId}.json`),
      JSON.stringify({
        runId,
        runDir,
        executor: 'codex',
        model: 'model-fixture',
        effort: null,
        cwd,
        label: runId,
        pid,
        startedAt: '2026-11-23T00:00:00.000Z',
      }),
    );
  };
  const project = path.join(root, 'project');
  await register('a-running', path.join(project, 'worktree'), sleeper.pid!);
  runtime.appendEvent(path.join(root, 'a-running'), 'started', 'started codex');
  runtime.recordActivity(path.join(root, 'a-running'), 'running: pwd');
  await register('b-completed', project, deadPid, {
    stop: { kind: 'completed', code: 'completed' },
  });
  await register('c-failed', project, deadPid, {
    stop: { kind: 'error', code: 'usage-limit' },
  });
  await register('d-lost', project, deadPid);
  await register('e-elsewhere', path.join(root, 'other'), deadPid);
  const status = (...args: string[]) => {
    const result = spawnSync(process.execPath, [workers, 'status', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PSTACK_STATE_HOME: state },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const states = (output: string) =>
    JSON.parse(output).map(({ runId, state, code }: Record<string, string>) => [
      runId,
      state,
      code,
    ]);
  assert.deepEqual(states(status('--cwd', project, '--json')), [
    ['a-running', 'running', null],
    ['b-completed', 'completed', 'completed'],
    ['c-failed', 'error', 'usage-limit'],
    ['d-lost', 'lost', null],
  ]);
  assert.equal(states(status('--cwd', project, '--all', '--json')).length, 5);
  const [running, completed] = JSON.parse(status('--cwd', project, '--json'));
  assert.equal(running.lastEvent.type, 'activity');
  assert.equal(running.lastEvent.text, 'running: pwd');
  assert.equal(completed.lastEvent, null);
  assert.equal(
    status('--cwd', project).split('\n')[0]!.split('\t')[4],
    'running: pwd',
  );
  assert.deepEqual(
    status('--cwd', project)
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0]),
    ['running', 'completed', 'error (usage-limit)', 'lost'],
  );
});

test('follow streams each new event and exits on the receipt or a lost runner', async (t) => {
  const root = await temporary(t);
  const runDir = path.join(root, 'run');
  await mkdir(runDir);
  const follower = spawn(
    process.execPath,
    [workers, 'follow', '--run-dir', runDir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const lines: string[] = [];
  let buffered = '';
  follower.stdout.on('data', (bytes: Buffer) => {
    buffered += bytes;
    const parts = buffered.split('\n');
    buffered = parts.pop()!;
    lines.push(...parts);
  });
  const shown = (count: number) => waitUntil(() => lines.length >= count, 5000);
  runtime.appendEvent(runDir, 'started', 'started codex model-fixture', {
    pid: process.pid,
  });
  assert.ok(await shown(1));
  runtime.recordActivity(runDir, 'running: pnpm test');
  assert.ok(await shown(2));
  runtime.stopRun(runDir, { kind: 'completed', code: 'completed' });
  await writeFile(path.join(runDir, 'result.json'), '{}');
  const [code] = await once(follower, 'close');
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'started codex model-fixture',
    'running: pnpm test',
    'stopped: completed (completed)',
  ]);

  const lostDir = path.join(root, 'lost');
  await mkdir(lostDir);
  const deadPid = await exitedPid();
  runtime.appendEvent(lostDir, 'started', 'started claude-code model', {
    pid: deadPid,
  });
  const lost = spawnSync(
    process.execPath,
    [workers, 'follow', '--run-dir', lostDir],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(lost.status, 1, lost.stderr);
  assert.deepEqual(lost.stdout.trim().split('\n'), [
    'started claude-code model',
    `lost: runner ${deadPid} exited without result.json`,
  ]);
});

test('follow and status agree that a dead runner with a truncated receipt is lost', async (t) => {
  const root = await temporary(t);
  const state = path.join(root, 'state');
  const runDir = path.join(root, 'run');
  await mkdir(runDir);
  const deadPid = await exitedPid();
  runtime.appendEvent(runDir, 'started', 'started claude-code model', {
    pid: deadPid,
  });
  runtime.stopRun(runDir, { kind: 'completed', code: 'completed' });
  await writeFile(path.join(runDir, 'result.json'), '{"stop": {"kind": "comp');
  await mkdir(path.join(state, 'runs'), { recursive: true });
  await writeFile(
    path.join(state, 'runs', 'run.json'),
    JSON.stringify({ runId: 'run', runDir, cwd: root, pid: deadPid }),
  );
  const env = { ...process.env, PSTACK_STATE_HOME: state };
  const follow = spawnSync(
    process.execPath,
    [workers, 'follow', '--run-dir', runDir],
    { encoding: 'utf8', env, timeout: 10_000 },
  );
  assert.equal(follow.status, 1, follow.stderr);
  assert.match(
    follow.stdout,
    /lost: runner \d+ exited without result\.json\n$/,
  );
  const status = spawnSync(
    process.execPath,
    [workers, 'status', '--all', '--json'],
    { encoding: 'utf8', env },
  );
  assert.equal(JSON.parse(status.stdout)[0].state, 'lost');
});

test('writeOnce links a whole file into place and never replaces one', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'result.json');
  runtime.writeOnce(file, 'first\n');
  assert.throws(() => runtime.writeOnce(file, 'second\n'), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'first\n');
  assert.deepEqual(await readdir(root), ['result.json']);
});
