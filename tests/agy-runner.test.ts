import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../plugin/skills/poteto-mode/scripts/run-agy.mjs', import.meta.url),
);
const fake = fileURLToPath(new URL('./fixtures/agy-cli.mjs', import.meta.url));
const model = 'gemini-4-hydrogen-xhigh';

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack-agy-')),
  );
  t.after(async () => {
    if (process.env.AGY_TEST_EVIDENCE_DIR)
      await cp(
        root,
        path.join(process.env.AGY_TEST_EVIDENCE_DIR, path.basename(root)),
        {
          recursive: true,
        },
      );
    await rm(root, { recursive: true, force: true });
  });
  const plugin = path.join(root, 'plugin');
  const scripts = path.join(plugin, 'skills/poteto-mode/scripts');
  const references = path.join(plugin, 'skills/poteto-mode/references');
  await mkdir(scripts, { recursive: true });
  await mkdir(references);
  for (const name of ['run-agy.mjs', 'agy-capabilities.mjs'])
    await cp(path.join(path.dirname(source), name), path.join(scripts, name));
  await cp(
    path.join(path.dirname(source), '../references/worker-context.md'),
    path.join(references, 'worker-context.md'),
  );
  const cwd = path.join(root, 'exact worktree');
  await mkdir(cwd);
  const home = path.join(root, 'home');
  await mkdir(home);
  const { AGY_ADC_AUTH, GEMINI_API_KEY, ...inherited } = process.env;
  const runner = path.join(scripts, 'run-agy.mjs');
  let index = 0;
  async function invoke(
    mode = 'normal',
    extra: string[] = [],
    command = 'run',
    env: Record<string, string> = {},
    signal?: NodeJS.Signals,
  ) {
    const tag = ++index;
    const runDir = path.join(root, `run-${tag}`);
    const trace = path.join(root, `trace-${tag}.jsonl`);
    const childPid = path.join(root, `child-${tag}.pid`);
    const child = spawn(
      process.execPath,
      [
        runner,
        command,
        ...(command === 'detect'
          ? []
          : [
              ...(extra.includes('--cwd') ? [] : ['--cwd', cwd]),
              ...(extra.includes('--run-dir') ? [] : ['--run-dir', runDir]),
            ]),
        ...(command === 'run'
          ? [
              ...(extra.includes('--model') ? [] : ['--model', model]),
              ...(extra.includes('--effort') ? [] : ['--effort', 'xhigh']),
            ]
          : []),
        '--executable',
        fake,
        ...extra,
      ],
      {
        env: {
          ...inherited,
          HOME: home,
          AGY_FIXTURE: mode,
          AGY_TRACE: trace,
          AGY_CHILD_PID: childPid,
          AGY_INHERITED_MARKER: 'inherited unchanged',
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.stdin.end('/literal-task no slash expansion\n');
    if (signal) {
      const deadline = Date.now() + 5000;
      const signalWhenReady = async () => {
        while (Date.now() < deadline) {
          try {
            if ((await readFile(trace, 'utf8')).includes('"input"')) {
              child.kill(signal);
              return;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        child.kill(signal);
      };
      void signalWhenReady();
    }
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      child.kill('SIGKILL');
    }, 12000);
    const [code, closeSignal] = await once(child, 'close');
    clearTimeout(watchdog);
    let receipt: any = null;
    if (stdout.trim()) receipt = JSON.parse(stdout);
    return {
      code,
      closeSignal,
      watchdogFired,
      stdout,
      stderr,
      receipt,
      runDir,
      trace,
      childPid,
    };
  }
  return { root, cwd, home, plugin, runner, invoke };
}

test('agy detect reports syntax and inherited auth method without claiming authentication or inference', async (t) => {
  const f = await fixture(t);
  const detected = await f.invoke('normal', [], 'detect', {
    AGY_ADC_AUTH: 'true',
  });
  assert.equal(detected.code, 0, detected.stderr);
  assert.equal(detected.receipt.version, '1.5.9');
  assert.deepEqual(detected.receipt.auth, {
    method: 'adc',
    modelProvider: null,
    geminiApiKeyPresent: false,
    verified: false,
  });
  assert.equal(detected.receipt.modelExecutionVerified, false);
  const calls = await readFile(detected.trace, 'utf8');
  assert.equal(calls.includes('[\"auth\"'), false);
  for (const mode of ['old-version', 'bad-version', 'missing-syntax']) {
    const failed = await f.invoke(mode, [], 'detect');
    assert.notEqual(failed.code, 0);
    assert.equal(failed.receipt.compatible, false);
  }
  const absent = await f.invoke(
    'normal',
    ['--executable', path.join(f.root, 'absent')],
    'detect',
  );
  assert.notEqual(absent.code, 0);
});

test('agy detects successful stderr help and version while rejecting failed or malformed stderr probes', async (t) => {
  const f = await fixture(t);
  for (const mode of ['stderr-help', 'stderr-probes']) {
    const detected = await f.invoke(mode, [], 'detect');
    assert.equal(detected.code, 0, JSON.stringify(detected));
    assert.equal(detected.receipt.version, '1.5.9');
    assert.equal(detected.receipt.compatible, true);
    assert.equal(detected.receipt.probeError, null);
    assert.ok(Object.values(detected.receipt.requiredOptions).every(Boolean));
    assert.deepEqual(detected.receipt.effortSyntax, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    const calls = (await readFile(detected.trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).args);
    assert.deepEqual(calls, [['--version'], ['--help']]);
  }
  for (const mode of ['stderr-help-nonzero', 'stderr-help-bad-utf8']) {
    const rejected = await f.invoke(mode, [], 'detect');
    assert.notEqual(rejected.code, 0, JSON.stringify(rejected));
    assert.equal(rejected.receipt.compatible, false);
    assert.match(
      rejected.receipt.probeError,
      mode === 'stderr-help-nonzero' ? /exited 7/ : /encoded data/,
    );
  }
});

test('agy fast readless and closed-stdin probes and catalogs succeed without sending task input', async (t) => {
  const f = await fixture(t);
  for (const mode of ['readless', 'closed-stdin']) {
    const detected = await f.invoke(mode, [], 'detect');
    assert.equal(detected.code, 0, JSON.stringify(detected));
    assert.equal(detected.receipt.compatible, true);
    assert.equal(detected.receipt.probeError, null);
    const catalog = await f.invoke(mode, [], 'catalog');
    assert.equal(catalog.code, 0, JSON.stringify(catalog));
    assert.equal(catalog.receipt.status, 'completed');
    assert.deepEqual(
      catalog.receipt.models.map((entry: any) => entry.model),
      [model, 'claude-fixture-20261115'],
    );
    assert.equal(catalog.receipt.inputSent, false);
    assert.equal(catalog.receipt.identityBeforeInput, false);
    assert.equal(catalog.receipt.process.shutdown, 'orderly');
    for (const run of [detected, catalog]) {
      const calls = (await readFile(run.trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.filter((call) => call.args).map((call) => call.args),
        run === detected
          ? [['--version'], ['--help']]
          : [['--version'], ['--help'], ['models']],
      );
      assert.equal(
        calls.some((call) => 'received' in call || 'input' in call),
        false,
      );
    }
  }
});

test('agy task stdin failure remains fatal after validated init', async (t) => {
  const f = await fixture(t);
  const promptFile = path.join(f.root, 'large-task.txt');
  await writeFile(
    promptFile,
    'Task input that must reach the CLI.\n'.repeat(65536),
  );
  const run = await f.invoke('closed-task-stdin', [
    '--prompt-file',
    promptFile,
  ]);
  assert.notEqual(run.code, 0, JSON.stringify(run));
  assert.equal(run.receipt.status, 'failed');
  assert.match(run.receipt.error, /stdin:.*(?:EPIPE|ECONNRESET)/);
  assert.equal(run.receipt.identityBeforeInput, true);
  assert.equal(run.receipt.result, null);
  assert.equal(run.receipt.process.closed, true);
  assert.equal(run.receipt.process.groupClosed, true);
});

test('agy sends one official user event with complete context, role body, exact settings and inherited harness', async (t) => {
  const f = await fixture(t);
  const instruction = path.join(f.root, 'AGENTS.md'),
    skill = path.join(f.root, 'SKILL.md'),
    role = path.join(f.root, 'role.md');
  await writeFile(instruction, 'Complete instruction\r\n');
  await writeFile(skill, '---\nname: supplied\n---\nComplete supplied skill\n');
  await writeFile(
    role,
    '---\r\nname: role\r\nmodel: original\r\n---\r\n# Original role\r\nFull role body\r\n',
  );
  for (const mode of ['normal', 'split', 'delayed-init']) {
    const run = await f.invoke(mode, [
      '--instruction',
      instruction,
      '--skill',
      skill,
      '--role',
      role,
      '--allow-permission',
      'command(git)',
      '--allow-permission',
      'write_file(src/)',
    ]);
    assert.equal(run.code, 0, run.stderr + JSON.stringify(run.receipt));
    assert.equal(run.receipt.status, 'completed');
    assert.equal(run.receipt.result, 'fresh answer 한글 🥔');
    assert.equal(
      await readFile(path.join(run.runDir, 'final.txt'), 'utf8'),
      run.receipt.result,
    );
    assert.equal(run.receipt.identityBeforeInput, true);
    assert.equal(run.receipt.effectiveEffort, null);
    assert.equal(run.receipt.usage.scope, 'conversation-cumulative');
    assert.equal(run.receipt.process.shutdown, 'orderly');
    const prompt = await readFile(path.join(run.runDir, 'prompt.txt'), 'utf8');
    for (const body of [
      'Complete instruction\r\n',
      'Complete supplied skill\n',
      '# Original role\r\nFull role body\r\n',
      'Receiving executor: antigravity.',
      '# Receiving worker execution',
      '/literal-task no slash expansion',
    ])
      assert.ok(prompt.includes(body), body);
    assert.equal(prompt.includes('model: original'), false);
    assert.equal(run.receipt.context.length, 4);
    assert.ok(
      run.receipt.context.every((entry: any) =>
        /^[\da-f]{64}$/.test(entry.sha256),
      ),
    );
    const trace = (await readFile(run.trace, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const call = trace.find((event) => event.input);
    assert.equal(JSON.parse(call.input).event, 'user');
    assert.equal(call.input.trim().split('\n').length, 1);
    assert.equal(JSON.parse(call.input).message.content, prompt);
    const args = run.receipt.args;
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), {
      permissions: { allow: ['command(git)', 'write_file(src/)'] },
    });
    for (const forbidden of [
      '-p',
      '--continue',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ])
      assert.equal(args.includes(forbidden), false);
    assert.deepEqual(run.receipt.requested, {
      executor: 'antigravity',
      model,
      reasoningEffort: 'xhigh',
    });
    assert.equal((await lstat(run.runDir)).mode & 0o777, 0o700);
    for (const name of [
      'stdout.jsonl',
      'stderr.log',
      'prompt.txt',
      'request.json',
      'result.json',
      'final.txt',
    ])
      assert.equal(
        (await lstat(path.join(run.runDir, name))).mode & 0o777,
        0o600,
      );
  }
});

test('agy catalog preserves exact sanitized ID/label provenance without a model prompt or invented effort matrix', async (t) => {
  const f = await fixture(t);
  const run = await f.invoke('normal', [], 'catalog');
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(
    run.receipt.models.map((entry: any) => entry.supportedReasoningEfforts),
    [['xhigh'], ['high']],
  );
  assert.deepEqual(
    run.receipt.candidates.map((entry: any) => entry.model),
    ['unclassified-model', 'fixed-standard'],
  );
  assert.equal(run.receipt.rawModels[0].model, model);
  assert.equal(JSON.stringify(run.receipt.rawModels).includes('\u001b'), false);
  assert.match(
    run.receipt.models[0].source.description,
    /configured availability/,
  );
  const trace = await readFile(run.trace, 'utf8');
  assert.equal(
    await readFile(path.join(run.runDir, 'stderr.log'), 'utf8'),
    'native model catalog diagnostic\n',
  );
  assert.ok(trace.includes('catalog-no-model-prompt'));
  assert.equal(trace.includes('"--model"'), false);
  assert.equal(trace.includes('"input"'), false);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(run.runDir, 'catalog.json'), 'utf8'))
      .models,
    run.receipt.models,
  );
  for (const mode of ['bad-catalog', 'duplicate-catalog']) {
    const bad = await f.invoke(mode, [], 'catalog');
    assert.notEqual(bad.code, 0);
    assert.equal(bad.receipt.status, 'failed');
  }
});

for (const mode of [
  'wrong-model',
  'wrong-cwd',
  'no-init',
  'wrong-step-id',
  'wrong-result-id',
  'missing-result',
  'missing-current-input',
  'malformed',
  'bad-utf8',
  'truncated-utf8',
  'failure',
  'empty',
  'error-then-success',
  'duplicate-result',
  'late-error',
  'nonzero',
  'no-newline',
]) {
  test(`agy rejects ${mode} even if native output or exit looks successful`, async (t) => {
    const f = await fixture(t);
    const run = await f.invoke(mode);
    assert.notEqual(run.code, 0, run.stdout);
    assert.ok(run.receipt, run.stderr + run.stdout);
    assert.equal(run.receipt.status, 'failed');
    assert.equal(run.receipt.result, null);
    assert.ok(run.receipt.error);
    assert.equal(run.receipt.process.closed, true);
    if (['wrong-model', 'wrong-cwd', 'no-init'].includes(mode)) {
      assert.equal(run.receipt.inputSent, false);
      assert.equal(
        (await readFile(run.trace, 'utf8')).includes('received'),
        false,
      );
    }
    if (mode === 'error-then-success')
      assert.match(run.receipt.error, /original native failure/);
    if (mode === 'bad-utf8')
      assert.ok(
        (await readFile(path.join(run.runDir, 'stdout.jsonl'))).includes(0xc3),
      );
  });
}

test('agy validates absent selections, aliases, unsafe directories, nonregular inputs and rules before writes or CLI launch', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    ['--model', 'auto'],
    ['--effort', 'ultra'],
    ['--instruction', f.cwd],
    ['--allow-permission', 'bad rule'],
    ['--timeout-ms', 'NaN'],
  ]) {
    const rejected = await f.invoke('normal', extra);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.receipt, null);
    await assert.rejects(readFile(rejected.trace), { code: 'ENOENT' });
  }
  const pluginAlias = path.join(f.root, 'plugin-alias');
  await symlink(f.plugin, pluginAlias);
  for (const location of [
    path.join(f.plugin, 'new-output'),
    path.join(pluginAlias, 'new-output'),
    f.cwd,
  ]) {
    const child = spawn(process.execPath, [
      f.runner,
      'run',
      '--cwd',
      f.cwd,
      '--run-dir',
      location,
      '--model',
      model,
      '--effort',
      'xhigh',
      '--executable',
      fake,
    ]);
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.stdin.end('task');
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.match(stderr, /outside plugin|already exists/);
  }
  const fresh = await f.invoke();
  const original = await readFile(path.join(fresh.runDir, 'result.json'));
  const child = spawn(process.execPath, [
    f.runner,
    'run',
    '--cwd',
    f.cwd,
    '--run-dir',
    fresh.runDir,
    '--model',
    model,
    '--effort',
    'xhigh',
    '--executable',
    fake,
  ]);
  child.stdin.end('task');
  await once(child, 'close');
  assert.deepEqual(
    await readFile(path.join(fresh.runDir, 'result.json')),
    original,
  );
});

test('agy exact receipt continuation consumes each predecessor permanently and keeps native cumulative usage', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke();
  const prior = path.join(first.runDir, 'result.json');
  const resumed = await f.invoke('normal', ['--resume', prior]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.receipt.conversationId, first.receipt.conversationId);
  assert.equal(resumed.receipt.terminalResult.num_turns, 2);
  assert.deepEqual(resumed.receipt.usage.value, {
    input_tokens: 22,
    output_tokens: 4,
    total_tokens: 26,
  });
  assert.equal(
    resumed.receipt.args[resumed.receipt.args.indexOf('--conversation') + 1],
    first.receipt.conversationId,
  );
  const edge = JSON.parse(
    await readFile(path.join(first.runDir, 'continued-by.json'), 'utf8'),
  );
  assert.equal(edge.resultPath, path.join(resumed.runDir, 'result.json'));
  const second = await f.invoke('normal', ['--resume', prior]);
  assert.notEqual(second.code, 0);
  assert.equal(second.receipt, null);
  assert.match(second.stderr, /permanent continuation/);
});

test('agy resumes a closed receipt when its historical PID identifies an unrelated live process group', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke();
  assert.equal(first.code, 0, JSON.stringify(first));
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  const unrelatedClosed = once(unrelated, 'close');
  t.after(async () => {
    unrelated.kill('SIGTERM');
    await unrelatedClosed;
  });
  await once(unrelated, 'spawn');
  assert.doesNotThrow(() => process.kill(-unrelated.pid!, 0));
  const prior = path.join(first.runDir, 'result.json');
  first.receipt.process.pid = unrelated.pid;
  await writeFile(prior, JSON.stringify(first.receipt));
  const resumed = await f.invoke('normal', ['--resume', prior]);
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(resumed.receipt?.status, 'completed');
  assert.equal(resumed.receipt.conversationId, first.receipt.conversationId);
  assert.doesNotThrow(() => process.kill(-unrelated.pid!, 0));
});

test('agy receipts name the inherited auth method from agy settings and environment without exposing the key or settings body', async (t) => {
  const f = await fixture(t);
  const key = 'fixture-gemini-key-value-never-recorded';
  const unrelated = 'settings-body-never-recorded';
  const settings = path.join(f.home, '.gemini/antigravity-cli/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  type Auth = {
    method: string;
    modelProvider: string | null;
    geminiApiKeyPresent: boolean;
    verified: false;
  };
  const cases: [string | null, Record<string, string>, Auth][] = [
    [
      JSON.stringify({ modelProvider: 'gemini', unrelated }),
      { GEMINI_API_KEY: key, AGY_ADC_AUTH: 'true' },
      {
        method: 'gemini-api-key',
        modelProvider: 'gemini',
        geminiApiKeyPresent: true,
        verified: false,
      },
    ],
    [
      JSON.stringify({ modelProvider: 'gemini' }),
      {},
      {
        method: 'gemini-api-key',
        modelProvider: 'gemini',
        geminiApiKeyPresent: false,
        verified: false,
      },
    ],
    [
      null,
      { AGY_ADC_AUTH: 'true', GEMINI_API_KEY: key },
      {
        method: 'adc',
        modelProvider: null,
        geminiApiKeyPresent: true,
        verified: false,
      },
    ],
    [
      JSON.stringify({ modelProvider: 'other', unrelated }),
      { GEMINI_API_KEY: '' },
      {
        method: 'inherited-default',
        modelProvider: 'other',
        geminiApiKeyPresent: false,
        verified: false,
      },
    ],
    [
      '{"modelProvider": "gemini"',
      { AGY_ADC_AUTH: 'false' },
      {
        method: 'inherited-default',
        modelProvider: null,
        geminiApiKeyPresent: false,
        verified: false,
      },
    ],
  ];
  for (const [contents, env, expected] of cases) {
    if (contents === null) await rm(settings, { force: true });
    else await writeFile(settings, contents);
    const detected = await f.invoke('normal', [], 'detect', env);
    assert.equal(detected.code, 0, detected.stderr);
    assert.deepEqual(detected.receipt.auth, expected);
    const runs = [
      await f.invoke('normal', [], 'catalog', env),
      await f.invoke('normal', [], 'run', env),
    ];
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      const receipt = JSON.parse(
        await readFile(path.join(run.runDir, 'result.json'), 'utf8'),
      );
      assert.deepEqual(receipt.auth, expected);
      assert.equal(receipt.authMode, expected.method);
      assert.equal(
        JSON.stringify(receipt.args).includes('modelProvider'),
        false,
      );
      for (const text of [
        detected.stdout,
        run.stdout,
        await readFile(path.join(run.runDir, 'result.json'), 'utf8'),
        await readFile(path.join(run.runDir, 'request.json'), 'utf8'),
      ])
        for (const secret of [key, unrelated])
          assert.equal(text.includes(secret), false);
    }
  }
});

test('agy resume rejects a prior receipt whose auth method differs from the inherited one', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke('normal', [], 'run', { AGY_ADC_AUTH: 'true' });
  assert.equal(first.receipt.authMode, 'adc');
  const prior = path.join(first.runDir, 'result.json');
  const settings = path.join(f.home, '.gemini/antigravity-cli/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ modelProvider: 'gemini' }));
  const rejected = await f.invoke('normal', ['--resume', prior], 'run', {
    AGY_ADC_AUTH: 'true',
  });
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.receipt, null);
  assert.match(rejected.stderr, /same inherited auth/);
  await assert.rejects(readFile(rejected.trace), { code: 'ENOENT' });
  await rm(settings);
  const resumed = await f.invoke('normal', ['--resume', prior], 'run', {
    AGY_ADC_AUTH: 'true',
  });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.receipt.auth.method, 'adc');
});

test('agy keeps a native ERROR terminal result and its usage in the failed receipt and never continues it', async (t) => {
  const f = await fixture(t);
  const run = await f.invoke('failure');
  assert.notEqual(run.code, 0);
  const prior = path.join(run.runDir, 'result.json');
  const receipt = JSON.parse(await readFile(prior, 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.result, null);
  assert.equal(receipt.terminalResult.status, 'ERROR');
  assert.equal(
    receipt.terminalResult.error,
    'Resource exhausted. Please try again later.',
  );
  assert.equal(receipt.terminalResult.finished_reason, 'error');
  assert.equal(receipt.terminalResult.conversation_id, receipt.conversationId);
  assert.deepEqual(receipt.usage, {
    scope: 'conversation-cumulative',
    source: 'native-agy-result',
    value: {
      input_tokens: 13417,
      output_tokens: 1084,
      thinking_tokens: 725,
      cache_read_tokens: 0,
      total_tokens: 14501,
    },
  });
  await assert.rejects(lstat(path.join(run.runDir, 'final.txt')), {
    code: 'ENOENT',
  });
  await writeFile(
    prior,
    JSON.stringify({
      ...receipt,
      status: 'completed',
      error: null,
      result: 'forged answer',
      process: {
        ...receipt.process,
        exitCode: 0,
        signal: null,
        shutdown: 'orderly',
      },
      terminalResult: { ...receipt.terminalResult, response: 'forged answer' },
    }),
  );
  const resumed = await f.invoke('normal', ['--resume', prior]);
  assert.notEqual(resumed.code, 0);
  assert.equal(resumed.receipt, null);
  assert.match(resumed.stderr, /terminal evidence/);
  await assert.rejects(readFile(resumed.trace), { code: 'ENOENT' });
});

test('agy rejects wrong resume route, cwd, auth, closure, receipt alias and naked conversation before worker launch', async (t) => {
  const f = await fixture(t);
  for (const defect of [
    'route',
    'cwd',
    'auth',
    'closure',
    'status',
    'session',
  ]) {
    const first = await f.invoke();
    const prior = path.join(first.runDir, 'result.json');
    const receipt = first.receipt;
    if (defect === 'route') receipt.requested.executor = 'pi';
    if (defect === 'cwd') receipt.cwd = '/wrong';
    if (defect === 'auth') receipt.authMode = 'different';
    if (defect === 'closure') receipt.process.groupClosed = false;
    if (defect === 'status') receipt.status = 'failed';
    if (defect === 'session') receipt.conversationId = 'unknown';
    await writeFile(prior, JSON.stringify(receipt));
    const rejected = await f.invoke('normal', ['--resume', prior]);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.receipt, null);
    await assert.rejects(readFile(rejected.trace), { code: 'ENOENT' });
  }
  const first = await f.invoke();
  const alias = path.join(f.root, 'alias.json');
  await symlink(path.join(first.runDir, 'result.json'), alias);
  const rejected = await f.invoke('normal', ['--resume', alias]);
  assert.match(rejected.stderr, /regular canonical/);
  const naked = await f.invoke('normal', [
    '--resume',
    first.receipt.conversationId,
  ]);
  assert.match(naked.stderr, /absolute path/);
});

test('agy rejects stale and mismatched resumed streams and retains their consumed continuation edge', async (t) => {
  const f = await fixture(t);
  for (const mode of ['stale', 'wrong-resume']) {
    const first = await f.invoke();
    const firstDiagnostic = `${mode} initial worker ${JSON.stringify(first)}`;
    assert.equal(first.code, 0, firstDiagnostic);
    assert.equal(first.receipt?.status, 'completed', firstDiagnostic);
    assert.equal(first.receipt.process.closed, true, firstDiagnostic);
    assert.equal(first.receipt.process.groupClosed, true, firstDiagnostic);
    const prior = path.join(first.runDir, 'result.json');
    const resumed = await f.invoke(mode, ['--resume', prior]);
    const resumedDiagnostic = `${mode} resumed worker ${JSON.stringify(resumed)}`;
    assert.notEqual(resumed.code, 0, resumedDiagnostic);
    assert.equal(resumed.receipt?.status, 'failed', resumedDiagnostic);
    assert.equal(resumed.receipt.result, null, resumedDiagnostic);
    assert.match(
      resumed.receipt.error,
      mode === 'stale'
        ? /stale or lacks current-turn count/
        : /Init conversation ID/,
      resumedDiagnostic,
    );
    assert.equal(resumed.receipt.process.closed, true, resumedDiagnostic);
    assert.equal(resumed.receipt.process.groupClosed, true, resumedDiagnostic);
    assert.equal(
      resumed.receipt.inputSent,
      mode === 'stale',
      resumedDiagnostic,
    );
    if (mode === 'wrong-resume') {
      assert.equal(
        (await readFile(resumed.trace, 'utf8')).includes('received'),
        false,
        resumedDiagnostic,
      );
    }
    const edge = JSON.parse(
      await readFile(path.join(first.runDir, 'continued-by.json'), 'utf8'),
    );
    assert.equal(edge.resultPath, path.join(resumed.runDir, 'result.json'));
    const retry = await f.invoke('normal', ['--resume', prior]);
    const retryDiagnostic = `${mode} retry ${JSON.stringify(retry)}`;
    assert.notEqual(retry.code, 0, retryDiagnostic);
    assert.equal(retry.receipt, null, retryDiagnostic);
    assert.match(retry.stderr, /permanent continuation/, retryDiagnostic);
  }
});

test(
  'agy timeout and SIGINT/SIGTERM override late success and terminate the owned process tree',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    for (const mode of ['hang', 'late-success', 'descendant', 'init-hang']) {
      const run = await f.invoke(mode, ['--timeout-ms', '350']);
      const diagnostic = `${mode} timeout ${JSON.stringify(run)}`;
      assert.notEqual(run.code, 0, diagnostic);
      assert.equal(run.receipt?.status, 'timed-out', diagnostic);
      assert.equal(run.receipt.result, null, diagnostic);
      assert.equal(run.receipt.process.closed, true, diagnostic);
      assert.equal(run.receipt.process.groupClosed, true, diagnostic);
      if (mode === 'descendant') {
        const pid = Number(await readFile(run.childPid, 'utf8'));
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
    }
    for (const [signal, status, code] of [
      ['SIGINT', 'interrupted', 130],
      ['SIGTERM', 'terminated', 143],
    ] as const) {
      const interrupted = await f.invoke('hang', [], 'run', {}, signal);
      assert.equal(interrupted.code, code, interrupted.stderr);
      assert.equal(interrupted.receipt.status, status);
      assert.equal(interrupted.receipt.result, null);
      assert.equal(interrupted.receipt.process.groupClosed, true);
    }
  },
);

test('agy capabilities reject auth routes and aliases while preserving explicit source provenance', async () => {
  const modulePath = path.join(path.dirname(source), 'agy-capabilities.mjs');
  const { agyEntry, agyCapability, parseAgyModels } = await import(modulePath);
  const entry = { executor: 'antigravity', model, reasoningEffort: 'xhigh' };
  assert.deepEqual(agyEntry(entry), entry);
  for (const field of [
    'auth',
    'authMode',
    'authentication',
    'apiKey',
    'provider',
    'credentials',
  ]) {
    assert.throws(() => agyEntry({ ...entry, [field]: 'explicit-route' }));
  }
  for (const alias of [
    'auto',
    'inherit-parent',
    'latest',
    'default',
    'gemini',
    'opus',
  ])
    assert.throws(() => agyEntry({ ...entry, model: alias }));
  const sourceEvidence = {
    kind: 'manual-confirmation',
    description: 'One explicit model and level confirmed by this fixture.',
  };
  const capability = agyCapability({
    ...entry,
    runtimeVersion: '1.5.9',
    supportedReasoningEfforts: ['xhigh'],
    source: sourceEvidence,
  });
  assert.deepEqual(capability.source, sourceEvidence);
  assert.equal(capability.runtimeVersion, '1.5.9');
  assert.deepEqual(capability.supportedReasoningEfforts, ['xhigh']);
  assert.throws(() =>
    agyCapability({
      ...entry,
      supportedReasoningEfforts: ['low', 'high'],
      source: { kind: 'host', description: 'Only global CLI effort syntax.' },
    }),
  );
  assert.deepEqual(
    parseAgyModels('custom-model\tCustom (High) label\n', '1.5.9').models,
    [],
  );
});

test('agy local runtime incompatibility does not consume a successful continuation receipt', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke();
  const prior = path.join(first.runDir, 'result.json');
  const rejected = await f.invoke('old-version', ['--resume', prior]);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.receipt.status, 'failed');
  await assert.rejects(lstat(path.join(first.runDir, 'continued-by.json')), {
    code: 'ENOENT',
  });
  const resumed = await f.invoke('normal', ['--resume', prior]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.receipt.conversationId, first.receipt.conversationId);
});

test('agy simultaneous continuations atomically admit exactly one worker', async (t) => {
  const f = await fixture(t);
  const first = await f.invoke();
  const prior = path.join(first.runDir, 'result.json');
  const results = await Promise.all([
    f.invoke('normal', ['--resume', prior]),
    f.invoke('normal', ['--resume', prior]),
  ]);
  assert.equal(results.filter((run) => run.code === 0).length, 1);
  const rejected = results.find((run) => run.code !== 0)!;
  assert.ok(
    rejected.stderr.includes('continuation') ||
      rejected.receipt?.error?.includes('EEXIST'),
  );
  const trace = await readFile(rejected.trace, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    },
  );
  assert.equal(trace.includes('"--model"'), false);
});

test('agy missing model or effort fails before writing output or launching any probe', async (t) => {
  const f = await fixture(t);
  for (const omitted of ['--model', '--effort']) {
    const runDir = path.join(f.root, `missing-${omitted}`);
    const trace = `${runDir}.trace`;
    const child = spawn(
      process.execPath,
      [
        f.runner,
        'run',
        '--cwd',
        f.cwd,
        '--run-dir',
        runDir,
        ...(omitted === '--model' ? [] : ['--model', model]),
        ...(omitted === '--effort' ? [] : ['--effort', 'xhigh']),
        '--executable',
        fake,
      ],
      { env: { ...process.env, AGY_TRACE: trace } },
    );
    child.stdin.end('task');
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    await assert.rejects(lstat(runDir), { code: 'ENOENT' });
    await assert.rejects(lstat(trace), { code: 'ENOENT' });
  }
});

test(
  'agy fails and closes a CLI that exited while a descendant holds its output pipes',
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t);
    const run = await f.invoke('pipe-descendant');
    assert.notEqual(run.code, 0);
    assert.equal(run.receipt.status, 'failed');
    assert.match(run.receipt.error, /descendant pipes|descendant processes/);
    assert.equal(run.receipt.process.closed, true);
    assert.equal(run.receipt.process.groupClosed, true);
    const pid = Number(await readFile(run.childPid, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);
