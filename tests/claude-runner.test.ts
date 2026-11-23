import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { constants, existsSync, readFileSync } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL(
    '../plugin/skills/poteto-mode/scripts/run-claude.mjs',
    import.meta.url,
  ),
);
const sessionId = '917f82bf-4fe5-46b9-8c4a-58663982aa01';
const finalEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '원본 결과 🥔',
  session_id: sessionId,
  usage: { input_tokens: 123, output_tokens: 45 },
  permission_denials: [],
};
const streamBytes = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
    session_id: sessionId,
    tools: ['Read', 'Write', 'Bash'],
    plugins: [{ name: 'existing-user-plugin' }],
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'read-1', name: 'Read' }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  }),
  JSON.stringify(finalEvent),
].join('\n');
const fakeHelp = [
  '  -p, --print',
  '  --model <model>',
  '  --effort <level> Effort level (low, medium, high, xhigh, max)',
  '  --output-format <format> text, json, stream-json',
  '  --verbose',
  '  --resume <value>',
  '  --permission-mode <mode>  Permission mode to use for the session',
  '      (choices: "acceptEdits", "auto", "bypassPermissions", "manual")',
].join('\n');

async function fixture(t: TestContext) {
  const created = await mkdtemp(path.join(os.tmpdir(), 'pstack-claude-test-'));
  const root = await realpath(created);
  const plugin = path.join(root, 'read only plugin');
  const scripts = path.join(plugin, 'skills/poteto-mode/scripts');
  const runner = path.join(scripts, 'run-claude.mjs');
  const cwd = path.join(root, 'exact worktree');
  const instruction = path.join(cwd, 'AGENTS.md');
  const skill = path.join(root, 'source skill.md');
  const role = path.join(root, 'original role.md');
  const executable = path.join(root, 'fake claude');
  const callPath = path.join(root, 'call.json');
  await mkdir(scripts, { recursive: true });
  await mkdir(cwd);
  await cp(path.dirname(source), scripts, { recursive: true });
  const references = path.join(plugin, 'skills/poteto-mode/references');
  await mkdir(references);
  const workerContext = path.join(references, 'worker-context.md');
  await cp(
    path.join(path.dirname(source), '../references/worker-context.md'),
    workerContext,
  );
  await chmod(workerContext, 0o444);
  const instructionBytes = 'Use the project terminology.\r\n';
  const skillBytes =
    '---\nname: source-skill\n---\nRead the assigned evidence.\n';
  const roleBody = '# Original role\r\n\r\nShow the evidence you used.\r\n';
  const roleBytes = `---\r\nname: original-role\r\nmodel: upstream-model\r\n---\r\n${roleBody}`;
  await writeFile(instruction, instructionBytes);
  await writeFile(skill, skillBytes);
  await writeFile(role, roleBytes);
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log((process.env.PSTACK_FAKE_VERSION ?? '2.1.287') + ' (Claude Code)');
} else if (args[0] === '--help') {
  console.log(${JSON.stringify(fakeHelp)});
} else if (args[0] === 'auth' && process.env.PSTACK_FAKE_AUTH) {
  console.log(process.env.PSTACK_FAKE_AUTH === 'text-in' ? 'Logged in.' : 'Not logged in.');
  process.exitCode = process.env.PSTACK_FAKE_AUTH === 'text-in' ? 0 : 1;
} else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: process.env.PSTACK_FAKE_LOGGED_IN !== 'false', authMethod: 'oauth_token', email: 'private@example.invalid', token: 'private-fixture' }));
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(process.env.PSTACK_FAKE_CALL_PATH, JSON.stringify({
    args, cwd: process.cwd(), input,
    inheritedMarker: process.env.PSTACK_FAKE_INHERITED_MARKER,
  }));
  const scenario = process.env.PSTACK_FAKE_SCENARIO;
  const named = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const sid = scenario === 'foreign-session' ? '00000000-0000-4000-8000-000000000000' : named('--session-id') ?? named('--resume');
  if (scenario === 'signal') process.kill(process.pid, 'SIGTERM');
  else if (scenario === 'cancel-exit' || scenario === 'cancel-aborted') {
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (scenario === 'cancel-aborted') process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', session_id: sid}) + '\\n', () => process.exit(0));
      else process.exit(23);
    });
    writeFileSync(process.env.PSTACK_FAKE_READY, 'ready');
    await new Promise(() => setInterval(() => {}, 1000));
  }
  else if (scenario === 'error') {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Original authentication failure', session_id: sid}) + '\\n');
    process.stderr.write('original stderr\\n');
    process.exitCode = 7;
  } else if (scenario === 'malformed-stderr') {
    process.stdout.write('unexpected stdout\\n');
    process.stderr.write('Failed to load model file\\n');
    process.exitCode = 2;
  } else if (scenario === 'other-missing') {
    process.stderr.write('No conversation found with session ID: 00000000-0000-4000-8000-000000000042\\n');
    process.stdout.write(JSON.stringify({type: 'result', subtype: process.env.PSTACK_FAKE_SUBTYPE ?? 'success', is_error: process.env.PSTACK_FAKE_SUBTYPE !== undefined, result: 'resumed answer', session_id: sid}) + '\\n');
    process.exitCode = process.env.PSTACK_FAKE_SUBTYPE === undefined ? 0 : 1;
  } else if (scenario === 'foreign-result') {
    process.stdout.write(JSON.stringify({type: 'system', subtype: 'init', session_id: sid, permissionMode: 'auto'}) + '\\n');
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'foreign answer', session_id: '00000000-0000-4000-8000-000000000042'}) + '\\n');
  } else if (scenario === 'error-credential') {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 401 Authorization: Bearer abcDEF123456789xyz', errors: ['request failed: api_key=sk-ant-api03-' + 'A'.repeat(44)], session_id: sid}) + '\\n');
    process.exitCode = 1;
  } else if (scenario === 'malformed') {
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    process.stdout.write('not JSON\\n');
  } else if (scenario === 'denied') {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'Read was denied.', session_id: sid, permission_denials: [{tool_name: 'Read', tool_use_id: 'toolu_denied', tool_input: {file_path: '/outside/secret.txt'}}]}) + '\\n');
  } else if (scenario === 'missing-session') {
    process.stderr.write('No conversation found with session ID: ' + sid + '\\n');
    process.exitCode = 1;
  } else if (scenario === 'missing-session-result') {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: ' + sid], session_id: sid}) + '\\n');
    process.exitCode = 1;
  } else if (scenario === 'stderr-crash') {
    for (let line = 1; line <= 1000; line++) process.stderr.write('stderr line ' + String(line).padStart(4, '0') + ' xxxxxxxxxxxx\\n');
    process.stderr.write('token=fixture-secret-value\\n');
    process.exitCode = 3;
  } else if (scenario === 'aborted-error' || scenario === 'aborted-success' || scenario === 'aborted-143') {
    const error = scenario === 'aborted-error';
    process.stdout.write(JSON.stringify({type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, terminal_reason: error ? 'aborted_tools' : 'aborted_streaming', session_id: sid}) + '\\n');
    if (scenario === 'aborted-143') process.exitCode = 143;
  } else if (scenario === 'lingering-helper') {
    const { spawn } = await import('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref();
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sid}) + '\\n');
  } else if (scenario === 'pipe-holder') {
    const { spawn } = await import('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 1, 2] });
    holder.unref();
    writeFileSync(process.env.PSTACK_FAKE_READY, String(holder.pid));
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'held', session_id: sid}) + '\\n');
  } else if (scenario === 'missing-result') {
    process.stdout.write(JSON.stringify({type: 'system', subtype: 'init', session_id: sid}) + '\\n');
  } else {
    const model = args[args.indexOf('--model') + 1];
    const events = ${JSON.stringify(streamBytes)}.split('\\n').map(line => JSON.parse(line));
    for (const value of events) value.session_id = sid;
    if (scenario === 'refused-auto') events[0].permissionMode = 'default';
    if (scenario === 'missing-permission-mode') delete events[0].permissionMode;
    if (scenario === 'missing-model') delete events[0].model;
    else events[0].model = scenario === 'mismatched-model' ? 'claude-other-fixture-20300101' : model;
    const bytes = Buffer.from(events.map(value => JSON.stringify(value)).join('\\n'));
    const split = bytes.indexOf(Buffer.from('🥔')) + 2;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 5));
    process.stdout.write(bytes.subarray(split));
    process.stderr.write('native hook diagnostic\\n');
  }
}
`,
    { mode: 0o755 },
  );
  await chmod(runner, 0o444);
  const directories = [
    references,
    scripts,
    path.dirname(scripts),
    path.join(plugin, 'skills'),
    plugin,
  ];
  for (const directory of directories) await chmod(directory, 0o555);
  t.after(async () => {
    for (const directory of directories) await chmod(directory, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const invoke = (
    command: string[],
    input = 'Apply this assignment only.\n',
    env: Record<string, string> = {},
  ) =>
    spawnSync(
      process.execPath,
      [runner, ...command, '--executable', executable],
      {
        cwd: root,
        input,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PSTACK_FAKE_CALL_PATH: callPath,
          PSTACK_FAKE_INHERITED_MARKER: 'existing environment preserved',
          PSTACK_STATE_HOME: path.join(root, 'state'),
          ...env,
        },
      },
    );
  const runDir = path.join(root, 'local run');
  const runArgs = [
    'run',
    '--cwd',
    cwd,
    '--run-dir',
    runDir,
    '--effort',
    'xhigh',
    '--instruction',
    instruction,
    '--skill',
    skill,
    '--model',
    'claude-opus-5-5',
  ];
  return {
    root,
    runner,
    plugin,
    executable,
    cwd,
    runDir,
    role,
    callPath,
    instruction,
    skill,
    instructionBytes,
    skillBytes,
    roleBytes,
    roleBody,
    workerContext,
    invoke,
    runArgs,
  };
}

test('detect checks installed CLI capability without asserting model execution', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(['detect']);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.executor, 'claude-code');
  assert.equal(receipt.executable, f.executable);
  assert.equal(receipt.version, '2.1.287');
  assert.equal(receipt.minimumVersion, '2.1.280');
  assert.equal(receipt.compatible, true);
  assert.equal(receipt.modelExecutionVerified, false);
  assert.deepEqual(receipt.requiredOptions, {
    print: true,
    model: true,
    effort: true,
    outputFormat: true,
    verbose: true,
    resume: true,
    permissionModeAuto: true,
  });
  assert.deepEqual(receipt.effortSyntax, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.equal(receipt.models, undefined);
  await assert.rejects(access(f.callPath));
});

test('detect reports incompatibility below the adapter CLI minimum', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(['detect'], '', { PSTACK_FAKE_VERSION: '2.1.279' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).compatible, false);
});

test('explicit exact model IDs reach argv and request', async (t) => {
  for (const selected of [
    'claude-opus-5-5',
    'claude-sonnet-fixture-20300101',
    'provider.anthropic.model-fixture-v1:0',
    'claude-opus-4-6[1m]',
    'provider.anthropic.model-fixture-v1:0[1m]',
  ]) {
    const f = await fixture(t);
    const args = [...f.runArgs.slice(0, -2), '--model', selected];
    const result = f.invoke(args);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    const call = JSON.parse(await readFile(f.callPath, 'utf8'));
    const request = JSON.parse(await readFile(receipt.requestPath, 'utf8'));
    const expected = selected;
    assert.equal(call.args[call.args.indexOf('--model') + 1], expected);
    assert.equal(request.model, expected);
    assert.equal(receipt.model, expected);
    assert.equal(receipt.observedModel, expected);
    assert.equal(receipt.modelSelection, 'explicit');
    assert.deepEqual(request.args, call.args);
  }
});

test('requested nondefault model stays separate from missing or mismatched stream observations', async (t) => {
  for (const [scenario, observed] of [
    ['missing-model', null],
    ['mismatched-model', 'claude-other-fixture-20300101'],
  ]) {
    const f = await fixture(t);
    const selected = 'claude-sonnet-fixture-20300101';
    const result = f.invoke(
      [...f.runArgs.slice(0, -2), '--model', selected],
      undefined,
      {
        PSTACK_FAKE_SCENARIO: scenario!,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.model, selected);
    assert.equal(receipt.observedModel, observed);
    assert.equal(receipt.result, finalEvent.result);
  }
});

test('explicit nondefault resume retains the model, exact session and normal tool/context binding', async (t) => {
  const f = await fixture(t);
  const selected = 'claude-sonnet-fixture-20300101';
  const result = f.invoke([
    ...f.runArgs.slice(0, -2),
    '--model',
    selected,
    '--resume',
    sessionId,
    '--role',
    f.role,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], selected);
  assert.equal(call.args[call.args.indexOf('--resume') + 1], sessionId);
  assert.equal(receipt.model, selected);
  assert.equal(receipt.observedModel, selected);
  assert.equal(receipt.resumeSessionId, sessionId);
  assert.ok(call.input.includes(f.roleBody));
});

test('invalid or missing explicit models fail before launch', async (t) => {
  const f = await fixture(t);
  const omitted = f.invoke(f.runArgs.slice(0, -2));
  assert.equal(omitted.status, 1);
  await assert.rejects(access(f.callPath));
  await assert.rejects(access(f.runDir));
  for (const selected of [
    '',
    ' ',
    ' leading',
    'embedded\nnewline',
    '--flag',
    'auto',
    'inherit-parent',
    'opus',
    'sonnet',
    'haiku',
    'default',
    'sonnet[1m]',
    'opus[1m]',
  ]) {
    const result = f.invoke([...f.runArgs.slice(0, -2), '--model', selected]);
    assert.equal(result.status, 1, selected);
    await assert.rejects(access(f.callPath));
    await assert.rejects(access(f.runDir));
  }
  assert.equal(
    f.invoke([
      ...f.runArgs,
      '--model',
      'claude-exact-v1',
      '--model',
      'claude-exact-v2',
    ]).status,
    1,
  );
  await assert.rejects(access(f.callPath));
});

test('run preserves cwd, stdin context, role body, raw trace, and immutable bundle bytes', async (t) => {
  const f = await fixture(t);
  const runnerBefore = await readFile(f.runner);
  const task = 'Read the code; show the original evidence. $() `literal` 🥔\n';
  const result = f.invoke(
    [
      ...f.runArgs,
      '--role',
      f.role,
      '--allowed-tool',
      'Bash(node --test index.test.mjs)',
      '--allowed-tool',
      `Edit(/${path.join(f.cwd, 'index.mjs')})`,
    ],
    task,
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const receipt = JSON.parse(result.stdout);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  const named = receipt.requestedSessionId;
  assert.match(
    named,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(call.cwd, f.cwd);
  assert.equal(receipt.cwd, f.cwd);
  assert.equal(call.inheritedMarker, 'existing environment preserved');
  assert.deepEqual(call.args, [
    '-p',
    '--model',
    'claude-opus-5-5',
    '--effort',
    'xhigh',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
    '--session-id',
    named,
    '--allowedTools',
    'Bash(node --test index.test.mjs)',
    '--allowedTools',
    `Edit(/${path.join(f.cwd, 'index.mjs')})`,
  ]);
  assert.ok(call.input.includes(f.instructionBytes));
  assert.ok(call.input.includes(f.skillBytes));
  assert.ok(call.input.includes(f.roleBody));
  assert.ok(!call.input.includes('model: upstream-model'));
  assert.ok(call.input.endsWith(task));
  assert.equal(receipt.sessionId, named);
  assert.equal(receipt.observedModel, 'claude-opus-5-5');
  assert.equal(receipt.result, finalEvent.result);
  assert.deepEqual(receipt.resultEvent, { ...finalEvent, session_id: named });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.stop, {
    kind: 'completed',
    code: 'completed',
    cause: 'completed',
    continuable: true,
  });
  assert.equal(receipt.spawnError, null);
  assert.equal(receipt.parseError, null);
  assert.ok(Number.isInteger(receipt.pid));
  assert.deepEqual(
    await readFile(receipt.stdoutPath),
    Buffer.from(streamBytes.replaceAll(sessionId, named)),
  );
  assert.equal(
    await readFile(receipt.stderrPath, 'utf8'),
    'native hook diagnostic\n',
  );
  assert.equal(await readFile(receipt.promptPath, 'utf8'), call.input);
  assert.deepEqual(
    JSON.parse(await readFile(receipt.resultPath, 'utf8')),
    receipt,
  );
  assert.deepEqual(
    JSON.parse(await readFile(receipt.requestPath, 'utf8')).args,
    call.args,
  );
  assert.equal(receipt.resumeSessionId, null);
  assert.deepEqual(await readFile(f.runner), runnerBefore);
  assert.equal(await readFile(f.role, 'utf8'), f.roleBytes);
  await access(f.plugin, constants.R_OK);
});

test('runner assembles complete installed instructions while keeping linked references separate', async (t) => {
  const f = await fixture(t);
  const plugin = path.resolve(path.dirname(source), '../../..');
  const project = path.dirname(plugin);
  const linked = path.join(f.cwd, 'separate evidence.txt');
  const linkedBody =
    'Evidence stays in its own file until the worker reads it.\n';
  const role = await readFile(
    path.join(plugin, 'agents/poteto-agent.md'),
    'utf8',
  );
  const roleBody = role.slice(role.indexOf('\n---\n') + 5);
  const skill = await readFile(
    path.join(plugin, 'skills/poteto-mode/SKILL.md'),
    'utf8',
  );
  const instruction =
    (await readFile(path.join(project, 'AGENTS.md'), 'utf8')) +
    `\nRead the evidence at ${linked}.\n`;
  const leaf = path.join(f.root, 'applied principle.md');
  const leafBody = await readFile(
    path.join(plugin, 'skills/principle-prove-it-works/SKILL.md'),
    'utf8',
  );
  await writeFile(f.role, role);
  await writeFile(f.skill, skill);
  await writeFile(f.instruction, instruction);
  await writeFile(leaf, leafBody);
  await writeFile(linked, linkedBody);
  const task = 'Inspect the assigned evidence and return its value.\n';
  const result = f.invoke(
    [...f.runArgs, '--role', f.role, '--skill', leaf],
    task,
  );
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  const receipt = JSON.parse(result.stdout);
  const request = JSON.parse(await readFile(receipt.requestPath, 'utf8'));
  assert.deepEqual(request.context, [
    { kind: 'instruction', path: f.instruction },
    { kind: 'skill', path: f.skill },
    { kind: 'skill', path: leaf },
    { kind: 'role', path: f.role },
  ]);
  let end = 0;
  for (const body of [
    instruction,
    skill,
    leafBody,
    roleBody,
    await readFile(f.workerContext, 'utf8'),
    task,
  ]) {
    const start = call.input.indexOf(body, end);
    assert.ok(start >= end);
    end = start + body.length;
  }
  assert.ok(!call.input.includes(linkedBody));
  assert.ok(!call.input.includes(role.slice(0, role.indexOf('\n---\n') + 5)));
  assert.equal(await readFile(receipt.promptPath, 'utf8'), call.input);
});

for (const category of ['instruction', 'skill', 'role'])
  test(`missing ${category} body fails before launching Claude`, async (t) => {
    const f = await fixture(t);
    const result = f.invoke([
      ...f.runArgs,
      `--${category}`,
      path.join(f.root, 'missing.md'),
    ]);
    assert.equal(result.status, 1);
    await assert.rejects(access(f.callPath), { code: 'ENOENT' });
    await assert.rejects(access(f.runDir), { code: 'ENOENT' });
  });

test('documented invocation runs in auto mode and passes only the supplied approved rules', async (t) => {
  const f = await fixture(t);
  const leaf = path.join(f.root, 'installed skill/principles/source.md');
  const leafRule = `Read(/${leaf})`;
  const verificationRule = 'Bash(node --test index.test.mjs)';
  const result = f.invoke([
    ...f.runArgs,
    '--allowed-tool',
    leafRule,
    '--allowed-tool',
    verificationRule,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  const allowedTools = call.args.flatMap((arg: string, index: number) =>
    arg === '--allowedTools' ? [call.args[index + 1]] : [],
  );
  assert.deepEqual(allowedTools, [leafRule, verificationRule]);
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!call.input.includes(f.roleBody));
});

test('generic reviewer omits original role and resumes only an exact session', async (t) => {
  const f = await fixture(t);
  const rubric = path.join(f.root, 'review rubric.md');
  await writeFile(rubric, 'Judge the supplied candidate on correctness.\n');
  const result = f.invoke([
    ...f.runArgs,
    '--instruction',
    rubric,
    '--resume',
    sessionId,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  const resumeIndex = call.args.indexOf('--resume');
  assert.equal(call.args[resumeIndex + 1], sessionId);
  assert.ok(!call.args.includes(`Read(/${rubric})`));
  assert.ok(
    call.input.includes('Judge the supplied candidate on correctness.'),
  );
  assert.ok(!call.input.includes(f.roleBody));
  assert.ok(!call.args.includes('--continue'));
  assert.ok(!call.args.includes('--fork-session'));
  assert.equal(receipt.resumeSessionId, sessionId);
});

test('child failure preserves the original result, stderr, and exit status', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'error',
  });
  assert.equal(result.status, 7, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.exitCode, 7);
  assert.equal(receipt.result, 'Original authentication failure');
  assert.equal(receipt.resultEvent.is_error, true);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.stop, {
    kind: 'error',
    code: 'failed',
    cause: 'error_during_execution',
    continuable: true,
  });
  assert.equal(await readFile(receipt.stderrPath, 'utf8'), 'original stderr\n');
});

test("a failed result's provider text is redacted in the receipt and kept raw in the trace", async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'error-credential',
  });
  assert.equal(result.status, 1, result.stderr);
  const secrets = /abcDEF123456789xyz|sk-ant-api03/g;
  const written = await readFile(path.join(f.runDir, 'result.json'), 'utf8');
  assert.deepEqual(
    [written.match(secrets), result.stdout.match(secrets)],
    [null, null],
  );
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.result, 'API Error: 401 [redacted:labeled-kv]');
  assert.equal(receipt.resultEvent.result, receipt.result);
  assert.deepEqual(receipt.resultEvent.errors, [
    'request failed: [redacted:labeled-kv]',
  ]);
  assert.equal(
    (await readFile(receipt.stdoutPath, 'utf8')).match(secrets)?.length,
    2,
  );
});

test('a run whose registry cannot be written still runs and records why', async (t) => {
  const f = await fixture(t);
  const blocked = path.join(f.root, 'state is a file');
  await writeFile(blocked, '');
  const result = f.invoke(f.runArgs, undefined, {
    PSTACK_STATE_HOME: blocked,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(
    await readFile(path.join(f.runDir, 'result.json'), 'utf8'),
  );
  assert.equal(receipt.status, 'completed');
  assert.match(receipt.registry.error, /ENOTDIR/);
});

test('a run records its turn completion between its start and stop events', async (t) => {
  const f = await fixture(t);
  assert.equal(f.invoke(f.runArgs).status, 0);
  const events = (await readFile(path.join(f.runDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map(({ type, status }) => [type, status]),
    [
      ['started', undefined],
      ['activity', undefined],
      ['turn-completed', 'success'],
      ['stopped', undefined],
    ],
  );
});

test('a child startup failure returns a receipt without fabricating a result', async (t) => {
  const f = await fixture(t);
  await writeFile(f.executable, '#!/nonexistent/pstack-test-interpreter\n');
  const result = f.invoke(f.runArgs);
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.spawnError, /ENOENT/);
  assert.equal(receipt.resultEvent, null);
  assert.equal(receipt.sessionId, null);
  assert.equal(receipt.stop.kind, 'error');
  assert.equal(receipt.stop.continuable, false);
  assert.equal(receipt.pid, null);
  assert.equal((await readFile(receipt.stdoutPath)).length, 0);
  assert.equal((await readFile(receipt.stderrPath)).length, 0);
});

test('malformed output is preserved byte for byte and cannot become a successful result', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'malformed',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.result, null);
  assert.ok(receipt.parseError);
  assert.deepEqual(
    await readFile(receipt.stdoutPath),
    Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from('not JSON\n')]),
  );
});

test('a missing final result preserves session evidence and returns failure', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'missing-result',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.sessionId, receipt.requestedSessionId);
  assert.equal(receipt.resultEvent, null);
});

test('child termination preserves the signal and conventional process exit status', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'signal',
  });
  assert.equal(result.status, 143, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.signal, 'SIGTERM');
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.stop.kind, 'interrupted');
  assert.equal(receipt.stop.cause, 'SIGTERM');
});

// Runs the fake CLI's scenario, sends the runner SIGINT once the CLI is ready, and
// returns the runner's exit code and receipt.
async function cancelled(
  f: Awaited<ReturnType<typeof fixture>>,
  scenario: string,
) {
  const ready = path.join(f.root, `${scenario}.ready`);
  const runner = spawn(
    process.execPath,
    [f.runner, ...f.runArgs, '--executable', f.executable],
    {
      cwd: f.root,
      env: {
        ...process.env,
        PSTACK_FAKE_CALL_PATH: f.callPath,
        PSTACK_FAKE_SCENARIO: scenario,
        PSTACK_FAKE_READY: ready,
        PSTACK_STATE_HOME: path.join(f.root, 'state'),
      },
    },
  );
  let stdout = '';
  runner.stdout.on('data', (bytes) => (stdout += bytes));
  runner.stdin.end('Perform the assignment.');
  const deadline = Date.now() + 5000;
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'the CLI never became ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  runner.kill('SIGINT');
  const [code] = await once(runner, 'close');
  return { code, receipt: JSON.parse(stdout) };
}

test("a cancelled run exits with the runner's signal and records the CLI's own exit", async (t) => {
  const f = await fixture(t);
  const { code, receipt } = await cancelled(f, 'cancel-exit');
  assert.equal(code, 130);
  assert.deepEqual(
    [receipt.exitCode, receipt.signal, receipt.status],
    [23, null, 'interrupted'],
  );
  assert.deepEqual(
    [receipt.stop.kind, receipt.stop.code, receipt.stop.cause],
    ['interrupted', 'signal', 'SIGINT'],
  );
});

test('an aborted result is a signal stop only when the runner sent the signal', async (t) => {
  const f = await fixture(t);
  const { receipt: stopped } = await cancelled(f, 'cancel-aborted');
  assert.equal(stopped.terminalReason, 'aborted_streaming');
  assert.deepEqual(
    [stopped.stop.kind, stopped.stop.code, stopped.stop.cause],
    ['interrupted', 'signal', 'SIGINT'],
  );
  const g = await fixture(t);
  const result = g.invoke(g.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'aborted-143',
  });
  const ended = JSON.parse(result.stdout);
  assert.equal(ended.exitCode, 143);
  assert.deepEqual(
    [ended.stop.kind, ended.stop.code, ended.stop.cause],
    [
      'interrupted',
      'failed',
      'Claude ended the turn early (aborted_streaming)',
    ],
  );
});

test("a helper outside the CLI's group holding its output cannot delay the receipt past the drain bound", async (t) => {
  const f = await fixture(t);
  const holder = path.join(f.root, 'holder.pid');
  t.after(() => {
    try {
      process.kill(Number(readFileSync(holder, 'utf8')));
    } catch {}
  });
  const startedAt = Date.now();
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'pipe-holder',
    PSTACK_FAKE_READY: holder,
  });
  assert.equal(result.status, 0, result.stderr);
  // Without the bound, the runner would wait out the holder's 20 s.
  assert.ok(Date.now() - startedAt < 8000, `${Date.now() - startedAt} ms`);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result, 'held');
  assert.match(await readFile(receipt.stdoutPath, 'utf8'), /"result":"held"/);
});

test('a run records whether the supervisor killed descendants that outlived Claude', async (t) => {
  const f = await fixture(t);
  for (const [scenario, reaped] of [
    ['success', false],
    ['lingering-helper', true],
  ] as const) {
    await rm(f.runDir, { recursive: true, force: true });
    const result = f.invoke(f.runArgs, 'Perform the assignment.', {
      PSTACK_FAKE_SCENARIO: scenario,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'completed', scenario);
    assert.equal(receipt.descendantsReaped, reaped, scenario);
  }
});

test('permission denials mark a completed Claude run for an approved continuation', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, 'Perform the assignment.', {
    PSTACK_FAKE_SCENARIO: 'denied',
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.stop, {
    kind: 'permission',
    code: 'permission-denied',
    cause: 'permission denial',
    continuable: true,
    permissionDenials: [
      {
        tool_name: 'Read',
        tool_use_id: 'toolu_denied',
        tool_input: { file_path: '/outside/secret.txt' },
      },
    ],
  });
});

test('run rejects unresolved inputs before starting Claude or writing inside the plugin', async (t) => {
  const f = await fixture(t);
  for (const [index, value] of [
    [2, 'relative-worktree'],
    [6, 'unsupported-effort'],
    [4, path.join(f.plugin, 'runtime logs')],
  ] as const) {
    const args = [...f.runArgs];
    args[index] = value;
    const result = f.invoke(args);
    assert.equal(result.status, 1);
    await assert.rejects(access(f.callPath));
  }
  await assert.rejects(access(path.join(f.plugin, 'runtime logs')), {
    code: 'ENOENT',
  });
  const resume = f.invoke([...f.runArgs, '--resume', 'latest']);
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /exact original session UUID/);
  const empty = f.invoke(f.runArgs, '');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /task prompt on stdin/);
  await assert.rejects(access(f.callPath));
});

test('run rejects symlinked destinations inside the plugin before creating output directories', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'plugin alias');
  const newDirectory = path.join(f.plugin, 'new run');
  await symlink(f.plugin, alias, 'dir');
  // Bundle containment must hold even when the installation is writable.
  await chmod(f.plugin, 0o755);
  const bundleBefore = await readdir(f.plugin, { recursive: true });
  const runnerBefore = await readFile(f.runner);
  const args = [...f.runArgs];
  args[4] = path.join(alias, 'new run', 'nested');

  const result = f.invoke(args);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--run-dir must be outside the plugin/);
  assert.equal(result.stdout, '');
  await assert.rejects(access(f.callPath), { code: 'ENOENT' });
  await assert.rejects(access(newDirectory), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.plugin, { recursive: true }), bundleBefore);
  assert.deepEqual(await readFile(f.runner), runnerBefore);
});

test('run accepts symlinked output destinations outside the plugin', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'external output');
  const alias = path.join(f.root, 'output alias');
  await mkdir(destination);
  await symlink(destination, alias, 'dir');
  const runDir = path.join(alias, 'new run', 'nested');
  const args = [...f.runArgs];
  args[4] = runDir;

  const result = f.invoke(args);

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.result, finalEvent.result);
  assert.equal(receipt.resultPath, path.join(runDir, 'result.json'));
  assert.equal(
    await realpath(receipt.resultPath),
    path.join(destination, 'new run', 'nested', 'result.json'),
  );
  await access(f.callPath);
});

test('selected Claude detection reports missing installation and safe login guidance without a worker', async (t) => {
  const f = await fixture(t);
  const missing = spawnSync(
    process.execPath,
    [f.runner, 'detect', '--executable', path.join(f.root, 'missing-cli')],
    { encoding: 'utf8' },
  );
  assert.equal(missing.status, 1, missing.stderr);
  const unavailable = JSON.parse(missing.stdout);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.guidance[0].action, 'install');
  const loggedOut = f.invoke(['detect'], undefined, {
    PSTACK_FAKE_LOGGED_IN: 'false',
  });
  assert.equal(loggedOut.status, 0, loggedOut.stderr);
  const receipt = JSON.parse(loggedOut.stdout);
  assert.equal(receipt.auth.loggedIn, false);
  assert.equal(receipt.guidance[0].command, 'claude auth login');
  assert.ok(!loggedOut.stdout.includes('private-fixture'));
  assert.ok(!loggedOut.stdout.includes('private@example'));
  await assert.rejects(access(f.callPath));
});

test('a self-contained prompt runs with an explicit model and effort without context files', async (t) => {
  const f = await fixture(t);
  const result = f.invoke([
    'run',
    '--cwd',
    f.cwd,
    '--run-dir',
    f.runDir,
    '--model',
    'claude-opus-5-5',
    '--effort',
    'high',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  assert.ok(call.input.includes('Apply this assignment only.'));
  assert.ok(!call.args.includes('--allowedTools'));
  const request = JSON.parse(
    await readFile(path.join(f.runDir, 'request.json'), 'utf8'),
  );
  assert.equal(request.reasoningEffort, 'high');
  assert.deepEqual(request.context, []);
});

test('omitted effort uses the CLI default with zero or one supplied context category', async (t) => {
  for (const category of ['none', 'instruction', 'skill']) {
    const f = await fixture(t);
    const context =
      category === 'instruction'
        ? ['--instruction', f.instruction]
        : category === 'skill'
          ? ['--skill', f.skill]
          : [];
    const result = f.invoke([
      'run',
      '--cwd',
      f.cwd,
      '--run-dir',
      f.runDir,
      '--model',
      'claude-opus-5-5',
      ...context,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(await readFile(f.callPath, 'utf8'));
    assert.ok(!call.args.includes('--effort'));
    const request = JSON.parse(
      await readFile(path.join(f.runDir, 'request.json'), 'utf8'),
    );
    assert.equal(request.reasoningEffort, null);
    assert.deepEqual(
      request.context.map((entry: { kind: string }) => entry.kind),
      category === 'none' ? [] : [category],
    );
  }
});

test('Claude transport injects its receiving executor and the bundled shared context', async (t) => {
  const f = await fixture(t);
  await chmod(f.workerContext, 0o644);
  await writeFile(f.workerContext, 'Shared receiving fixture context.');
  await chmod(f.workerContext, 0o444);
  const result = f.invoke([...f.runArgs, '--role', f.role]);
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  const request = JSON.parse(
    await readFile(path.join(f.runDir, 'request.json'), 'utf8'),
  );
  assert.equal(request.executor, 'claude-code');
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.reasoningEffort, 'xhigh');
  assert.ok(call.input.includes(f.roleBody));
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.ok(call.input.includes(`Receiving executor is ${request.executor}.`));
  assert.ok(call.input.includes('Shared receiving fixture context.'));
  assert.ok(
    call.input.indexOf('Shared receiving fixture context.') <
      call.input.indexOf('## Assigned task'),
  );
});

test('a fresh run names its session before spawning and a resume does not', async (t) => {
  const f = await fixture(t);
  const fresh = f.invoke(f.runArgs);
  assert.equal(fresh.status, 0, fresh.stderr);
  const receipt = JSON.parse(fresh.stdout);
  const request = JSON.parse(await readFile(receipt.requestPath, 'utf8'));
  const call = JSON.parse(await readFile(f.callPath, 'utf8'));
  assert.equal(request.requestedSessionId, receipt.requestedSessionId);
  assert.equal(
    call.args[call.args.indexOf('--session-id') + 1],
    request.requestedSessionId,
  );
  const [startedLine] = (
    await readFile(path.join(f.runDir, 'events.jsonl'), 'utf8')
  ).split('\n');
  const started = JSON.parse(startedLine!);
  assert.equal(started.sessionId, request.requestedSessionId);
  assert.equal(receipt.stop.continuable, true);

  const g = await fixture(t);
  const resumed = g.invoke([...g.runArgs, '--resume', sessionId]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumeCall = JSON.parse(await readFile(g.callPath, 'utf8'));
  assert.ok(!resumeCall.args.includes('--session-id'));
  assert.equal(JSON.parse(resumed.stdout).requestedSessionId, null);
});

test('a stream from another conversation is not continuable', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'foreign-session',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.sessionId, null);
  assert.equal(
    receipt.foreignSessionId,
    '00000000-0000-4000-8000-000000000000',
  );
  assert.equal(receipt.result, null);
  assert.deepEqual(
    [receipt.status, receipt.stop.kind, receipt.stop.continuable],
    ['failed', 'error', false],
  );
});

test("another conversation's result is never the named session's answer", async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'foreign-result',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.sessionId, receipt.requestedSessionId);
  assert.equal(receipt.resultEvent, null);
  assert.equal(receipt.result, null);
  assert.deepEqual(receipt.stop, {
    kind: 'error',
    code: 'failed',
    cause: `Claude reported session 00000000-0000-4000-8000-000000000042 instead of ${receipt.requestedSessionId}`,
    continuable: false,
  });
});

test('a run Claude started outside auto mode stops with permission-mode', async (t) => {
  const f = await fixture(t);
  const refused = f.invoke(f.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'refused-auto',
  });
  assert.equal(refused.status, 0, refused.stderr);
  const receipt = JSON.parse(refused.stdout);
  assert.equal(receipt.observedPermissionMode, 'default');
  assert.equal(receipt.stop.kind, 'error');
  assert.equal(receipt.stop.code, 'permission-mode');
  assert.match(receipt.stop.cause, /default mode instead of auto/);
  const events = (await readFile(path.join(f.runDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).code, 'permission-mode');

  for (const [scenario, observed] of [
    [undefined, 'auto'],
    ['missing-permission-mode', null],
  ] as const) {
    const g = await fixture(t);
    const result = g.invoke(
      g.runArgs,
      undefined,
      scenario ? { PSTACK_FAKE_SCENARIO: scenario } : {},
    );
    assert.equal(result.status, 0, result.stderr);
    const ran = JSON.parse(result.stdout);
    assert.equal(ran.observedPermissionMode, observed);
    assert.equal(ran.stop.code, 'completed');
  }
});

for (const scenario of ['missing-session', 'missing-session-result'])
  test(`a resume of a conversation Claude cannot find stops with missing-session (${scenario})`, async (t) => {
    const f = await fixture(t);
    const result = f.invoke([...f.runArgs, '--resume', sessionId], undefined, {
      PSTACK_FAKE_SCENARIO: scenario,
    });
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.stop.kind, 'error');
    assert.equal(receipt.stop.code, 'missing-session');
    assert.equal(receipt.stop.continuable, false);
    assert.ok(
      receipt.stop.cause.includes(
        `No conversation found with session ID: ${sessionId}`,
      ),
    );
  });

test("another conversation's missing notice never marks a resume missing-session", async (t) => {
  const f = await fixture(t);
  const resumed = f.invoke([...f.runArgs, '--resume', sessionId], undefined, {
    PSTACK_FAKE_SCENARIO: 'other-missing',
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const receipt = JSON.parse(resumed.stdout);
  assert.equal(receipt.result, 'resumed answer');
  assert.deepEqual(
    [receipt.stop.code, receipt.stop.continuable],
    ['completed', true],
  );
  const g = await fixture(t);
  const failed = g.invoke([...g.runArgs, '--resume', sessionId], undefined, {
    PSTACK_FAKE_SCENARIO: 'other-missing',
    PSTACK_FAKE_SUBTYPE: 'error_during_execution',
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(
    [
      JSON.parse(failed.stdout).stop.code,
      JSON.parse(failed.stdout).stop.continuable,
    ],
    ['failed', true],
  );
});

test("a run with malformed output and no result names stderr's diagnosis before the parse error", async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'malformed-stderr',
  });
  assert.equal(result.status, 2, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.parseError, /not valid JSON/);
  assert.equal(
    receipt.stop.cause,
    `claude stream-json exited (code 2): Failed to load model file\nstdout was not stream-json: ${receipt.parseError}`,
  );
});

test('a run without a result reports its last whole stderr lines, redacted', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(f.runArgs, undefined, {
    PSTACK_FAKE_SCENARIO: 'stderr-crash',
  });
  assert.equal(result.status, 3, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.resultEvent, null);
  assert.equal(receipt.stop.code, 'failed');
  const { cause } = receipt.stop;
  assert.ok(cause.length <= 2000);
  assert.match(
    cause,
    /^claude stream-json exited \(code 3\): stderr line \d{4} x{12}\n/,
  );
  assert.ok(
    cause.endsWith('stderr line 1000 xxxxxxxxxxxx\n[redacted:labeled-kv]'),
  );
  assert.ok(!cause.includes('fixture-secret-value'));
  assert.match(
    await readFile(receipt.stderrPath, 'utf8'),
    /token=fixture-secret-value/,
  );
});

test('a result Claude cut short is an interrupted stop, not a completion or failure', async (t) => {
  for (const [scenario, reason] of [
    ['aborted-error', 'aborted_tools'],
    ['aborted-success', 'aborted_streaming'],
  ]) {
    const f = await fixture(t);
    const result = f.invoke(f.runArgs, undefined, {
      PSTACK_FAKE_SCENARIO: scenario!,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.terminalReason, reason);
    assert.equal(receipt.status, 'interrupted');
    assert.equal(receipt.stop.kind, 'interrupted');
    assert.equal(receipt.stop.continuable, true);
    assert.match(receipt.stop.cause, new RegExp(reason!));
  }
  const g = await fixture(t);
  const ran = JSON.parse(g.invoke(g.runArgs).stdout);
  assert.equal(ran.terminalReason, null);
  assert.equal(ran.stop.kind, 'completed');
});

test('detect reads sign-in from the exit code when auth status output does not parse', async (t) => {
  const f = await fixture(t);
  for (const [output, loggedIn] of [
    ['text-in', true],
    ['text-out', false],
  ] as const) {
    const result = f.invoke(['detect'], '', { PSTACK_FAKE_AUTH: output });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt.auth, { verified: true, loggedIn, method: null });
    assert.equal(receipt.guidance.length, loggedIn ? 0 : 1);
  }
});
