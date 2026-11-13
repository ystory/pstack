import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  rm,
  rename,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const runner = path.resolve('plugin/skills/poteto-mode/scripts/run-pi.mjs');
const fixture = path.resolve('tests/fixtures/pi-rpc.mjs');
const temporaryRoots = new Set<string>();
after(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});
async function invoke(
  mode = 'early',
  extra: string[] = [],
  root?: string,
  interrupt = false,
) {
  root ??= await mkdtemp(path.join(os.tmpdir(), 'pstack-pi-run-'));
  temporaryRoots.add(root);
  const runDir = path.join(root, `run-${crypto.randomUUID()}`);
  const trace = path.join(root, `trace-${crypto.randomUUID()}`);
  const childPid = path.join(root, 'child-pid');
  const args = [
    runner,
    'run',
    '--cwd',
    root,
    '--run-dir',
    runDir,
    '--executable',
    fixture,
    '--provider',
    'one',
    '--model',
    'vendor/model',
    '--effort',
    'high',
    '--tools',
    'read,bash',
    '--startup-timeout-ms',
    '1000',
    '--command-timeout-ms',
    '1000',
    '--shutdown-grace-ms',
    '100',
    ...extra,
  ];
  for (let index = 0; index < extra.length; index += 2) {
    const flag = extra[index]!;
    if (['--instruction', '--skill'].includes(flag)) continue;
    const original = args.indexOf(flag);
    if (original >= 0 && original < args.length - extra.length)
      args.splice(original, 2);
  }
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PI_FIXTURE: mode,
      PI_TRACE: trace,
      PI_CHILD_PID: childPid,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('Complete task');
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (interrupt) timer = setTimeout(() => child.kill('SIGINT'), 250);
  const code = await new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  clearTimeout(timer);
  return {
    code,
    receipt: stdout ? JSON.parse(stdout) : null,
    stderr,
    root,
    runDir,
    trace,
    childPid,
  };
}

test('Pi accepts events before prompt response, waits through retry and delivers complete context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-pi-context-'));
  const body = `Original body\n${'x'.repeat(10000)}\nEOF`;
  const instruction = path.join(root, 'AGENTS.md');
  await writeFile(instruction, body);
  for (const mode of ['early', 'retry', 'split']) {
    const run = await invoke(mode, ['--instruction', instruction], root);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.receipt.status, 'completed');
    assert.equal(run.receipt.result, 'fresh answer\u2028한글');
    assert.deepEqual(run.receipt.observedAssistant, {
      provider: 'physical',
      model: 'actual/model',
    });
    assert.equal(run.receipt.process.shutdown, 'orderly');
    const prompt = await readFile(path.join(run.runDir, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes(body));
    assert.ok(prompt.includes('Receiving executor: pi'));
    assert.ok(run.receipt.args.includes('--offline'));
    assert.ok(run.receipt.args.includes('--no-mcp'));
    const trace = await readFile(run.trace, 'utf8');
    assert.equal(trace.includes('get_last_assistant_text'), false);
    const events = await readFile(
      path.join(run.runDir, 'events.jsonl'),
      'utf8',
    );
    assert.equal(events.includes('SECRET-'), false);
  }
});

for (const mode of [
  'error',
  'length',
  'aborted',
  'deferred',
  'toolUse',
  'empty',
  'stale',
  'handled',
  'queued',
  'ui',
  'malformed',
  'no-lf',
  'wrong-id',
  'startup-hang',
  'effort-command-hang',
  'missing-auth',
  'final-model-change',
  'final-effort-change',
  'final-busy',
  'premature-exit',
  'ignore-eof',
]) {
  test(`Pi reports ${mode} as failure`, async () => {
    const run = await invoke(
      mode,
      mode === 'startup-hang'
        ? ['--startup-timeout-ms', '100']
        : mode === 'effort-command-hang'
          ? ['--command-timeout-ms', '100']
          : [],
    );
    assert.notEqual(run.code, 0);
    assert.equal(run.receipt?.status, 'failed', run.stderr);
    assert.equal(run.receipt.result, null);
    assert.equal(JSON.stringify(run.receipt).includes('SECRET'), false);
    assert.notEqual(run.receipt.process.shutdown, 'unconfirmed');
  });
}

test('Pi rejects exact model and effort mismatches before prompting without route fallback', async () => {
  for (const mode of ['reject-model', 'clamp', 'off-only']) {
    const run = await invoke(mode);
    assert.equal(run.receipt.status, 'rejected', run.stderr);
    assert.ok(
      ['model-rejected', 'effort-rejected'].includes(
        run.receipt.rejection.kind,
      ),
    );
    if (run.receipt.rejection.kind === 'effort-rejected')
      assert.ok(run.receipt.rejection.availableLevels.includes('off'));
    const trace = await readFile(run.trace, 'utf8');
    assert.equal(trace.includes('"type":"prompt"'), false);
    assert.equal(trace.split('"type":"set_model"').length, 2);
  }
});

test('Pi cancellation and task timeout override late success and stop owned descendants', async () => {
  for (const mode of ['late-success', 'descendant', 'no-settle']) {
    const run = await invoke(mode, ['--timeout-ms', '300']);
    assert.equal(run.receipt.status, 'timed-out', run.stderr);
    assert.equal(run.receipt.result, null);
    assert.equal(JSON.stringify(run.receipt).includes('SECRET'), false);
    const trace = await readFile(run.trace, 'utf8');
    assert.ok(
      trace.indexOf('"type":"clear_queue"') < trace.indexOf('"type":"abort"'),
    );
    if (mode === 'descendant') {
      const pid = Number(await readFile(run.childPid, 'utf8'));
      assert.throws(() => process.kill(pid, 0));
    }
  }
  const interrupted = await invoke('hang', [], undefined, true);
  assert.equal(interrupted.receipt.status, 'interrupted', interrupted.stderr);
  assert.equal(interrupted.code, 130);
});

test('Pi exact receipt resume validates session bytes, route, cwd, identity and lease', async () => {
  const first = await invoke();
  const receipt = path.join(first.runDir, 'result.json');
  const resumed = await invoke('early', ['--resume', receipt], first.root);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.receipt.session.id, first.receipt.session.id);
  const old = await invoke('early', ['--resume', receipt], first.root);
  assert.equal(old.receipt, null);
  assert.match(old.stderr, /changed/);
  const current = path.join(resumed.runDir, 'result.json');
  const wrong = await invoke(
    'early',
    ['--resume', current, '--effort', 'low'],
    first.root,
  );
  assert.notEqual(wrong.code, 0);
  const lease = `${resumed.receipt.session.file}.pstack-lease`;
  await writeFile(lease, 'occupied');
  const conflict = await invoke('early', ['--resume', current], first.root);
  assert.match(conflict.stderr, /lease/);
});

test('Pi refuses unsafe run dirs, symlink session inputs and unpersisted continuation', async () => {
  const lazy = await invoke('lazy');
  assert.equal(lazy.receipt.status, 'completed');
  assert.equal(lazy.receipt.session, null);
  const noSession = await invoke(
    'early',
    ['--resume', path.join(lazy.runDir, 'result.json')],
    lazy.root,
  );
  assert.notEqual(noSession.code, 0);
  const fresh = await invoke();
  const alias = path.join(fresh.root, 'alias.json');
  await symlink(path.join(fresh.runDir, 'result.json'), alias);
  const unsafe = await invoke('early', ['--resume', alias], fresh.root);
  assert.match(unsafe.stderr, /regular canonical/);
});

test('Pi rejects older and malformed versions before RPC startup', async () => {
  for (const mode of ['old-version', 'bad-version']) {
    const run = await invoke(mode);
    assert.equal(run.receipt.status, 'failed');
    assert.equal(run.receipt.rejection.kind, 'capability');
    assert.equal(run.receipt.process.pid, null);
    await assert.rejects(readFile(run.trace));
  }
});

test('Pi catalog sanitizes full model records and reports per-route effort support', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-pi-catalog-'));
  temporaryRoots.add(root);
  const child = spawn(
    process.execPath,
    [
      runner,
      'catalog',
      '--cwd',
      root,
      '--run-dir',
      path.join(root, 'catalog'),
      '--executable',
      fixture,
    ],
    { env: { ...process.env, PI_FIXTURE: 'off-only' } },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  const receipt = JSON.parse(stdout);
  assert.deepEqual(
    receipt.models.map(
      (entry: { supportedReasoningEfforts: string[] }) =>
        entry.supportedReasoningEfforts,
    ),
    [['off'], ['off']],
  );
  assert.equal(stdout.includes('SECRET'), false);
  assert.equal(
    (await readFile(path.join(root, 'catalog/events.jsonl'), 'utf8')).includes(
      'SECRET',
    ),
    false,
  );
});

test('Pi resumes interrupted persisted work and refuses unconfirmed closure', async () => {
  const interrupted = await invoke('hang', ['--timeout-ms', '250']);
  assert.equal(interrupted.receipt.status, 'timed-out');
  assert.equal(interrupted.receipt.resumability.available, true);
  const prior = path.join(interrupted.runDir, 'result.json');
  const resumed = await invoke('early', ['--resume', prior], interrupted.root);
  assert.equal(resumed.code, 0, resumed.stderr);
  const unconfirmed = {
    ...resumed.receipt,
    process: { ...resumed.receipt.process, shutdown: 'unconfirmed' },
  };
  const unsafe = path.join(interrupted.root, 'unconfirmed.json');
  await writeFile(unsafe, JSON.stringify(unconfirmed));
  const rejected = await invoke(
    'early',
    ['--resume', unsafe],
    interrupted.root,
  );
  assert.match(rejected.stderr, /closure/);
});

test('Pi rejects missing, empty, aliased and changed session headers before continuation', async () => {
  for (const defect of [
    'missing',
    'empty',
    'header-id',
    'header-cwd',
    'symlink',
  ]) {
    const fresh = await invoke();
    const file = fresh.receipt.session.file;
    const bytes = await readFile(file);
    if (defect === 'missing') await rm(file);
    else if (defect === 'empty') await writeFile(file, '');
    else if (defect === 'symlink') {
      const actual = `${file}.actual`;
      await rename(file, actual);
      await symlink(actual, file);
    } else {
      const lines = bytes.toString('utf8').split('\n');
      const header = JSON.parse(lines[0]!);
      if (defect === 'header-id') header.id = 'wrong';
      else header.cwd = '/wrong';
      lines[0] = JSON.stringify(header);
      await writeFile(file, lines.join('\n'));
    }
    const resumed = await invoke(
      'early',
      ['--resume', path.join(fresh.runDir, 'result.json')],
      fresh.root,
    );
    assert.notEqual(resumed.code, 0);
    assert.equal(resumed.receipt, null);
  }
});

test('Pi refuses reused artifact directories before altering their files', async () => {
  const fresh = await invoke();
  const original = await readFile(path.join(fresh.runDir, 'result.json'));
  const reused = await invoke('early', ['--run-dir', fresh.runDir], fresh.root);
  assert.notEqual(reused.code, 0);
  assert.match(reused.stderr, /already exists/);
  assert.deepEqual(
    await readFile(path.join(fresh.runDir, 'result.json')),
    original,
  );
});

test('Pi aggregates usage across tool calls and retries with estimated cost provenance', async () => {
  for (const [mode, count] of [
    ['multi-tool', 3],
    ['retry', 2],
  ] as const) {
    const run = await invoke(mode);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.receipt.usage, {
      source: 'pi-provider-estimate',
      assistantMessages: count,
      input: 2 * count,
      output: 3 * count,
      cost: { total: 0.001 * count },
    });
    assert.equal(run.receipt.lastAssistantUsage.input, 2);
  }
});

test('Pi exposes changed resumed state after a pre-prompt effort clamp as nonresumable', async () => {
  const first = await invoke();
  const prior = path.join(first.runDir, 'result.json');
  const clamped = await invoke('clamp', ['--resume', prior], first.root);
  assert.equal(clamped.receipt.status, 'rejected');
  assert.equal(clamped.receipt.resumability.available, false);
  assert.notEqual(clamped.receipt.session.sha256, first.receipt.session.sha256);
  const stale = await invoke('early', ['--resume', prior], first.root);
  assert.match(stale.stderr, /changed/);
  const refused = await invoke(
    'early',
    ['--resume', path.join(clamped.runDir, 'result.json')],
    first.root,
  );
  assert.notEqual(refused.code, 0);
});

test('Pi readback mismatches fail without rejecting the requested model identity', async () => {
  for (const mode of ['route-clamp', 'effort-route-clamp']) {
    const run = await invoke(mode);
    assert.equal(run.receipt.status, 'failed');
    assert.equal(run.receipt.rejection.kind, 'selection-changed');
    assert.equal(
      (await readFile(run.trace, 'utf8')).includes('"type":"prompt"'),
      false,
    );
  }
});
