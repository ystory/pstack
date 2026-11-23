import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  assert.deepEqual(
    JSON.parse(await readFile(path.join(runs, `${first.runId}.json`), 'utf8')),
    {
      runId: first.runId,
      ...run,
      pid: process.pid,
      startedAt: first.startedAt,
    },
  );
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

test('stop ends a one-shot provider through the supervisor and reports the signal', async (t) => {
  await temporary(t);
  const child = runtime.spawnSupervised(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
    ],
    { lifetime: 'one-shot', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.resume();
  child.stderr.resume();
  assert.ok(await waitUntil(() => child.providerPid !== null, 5000));
  const closed = once(child, 'close');
  const startedAt = Date.now();
  await child.stop('deadline');
  assert.deepEqual(await closed, [null, 'SIGTERM']);
  assert.ok(Date.now() - startedAt < runtime.SIGTERM_GRACE_MS);
  assert.equal(child.stopReason, 'deadline');
  assert.equal(alive(child.providerPid, true), false);
});
