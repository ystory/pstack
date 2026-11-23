import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
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
