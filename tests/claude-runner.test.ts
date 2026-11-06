import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
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
  if (scenario === 'signal') process.kill(process.pid, 'SIGTERM');
  else if (scenario === 'error') {
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Original authentication failure', session_id: '${sessionId}'}) + '\\n');
    process.stderr.write('original stderr\\n');
    process.exitCode = 7;
  } else if (scenario === 'malformed') {
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    process.stdout.write('not JSON\\n');
  } else if (scenario === 'missing-result') {
    process.stdout.write(JSON.stringify({type: 'system', subtype: 'init', session_id: '${sessionId}'}) + '\\n');
  } else {
    const model = args[args.indexOf('--model') + 1];
    const events = ${JSON.stringify(streamBytes)}.split('\\n').map(line => JSON.parse(line));
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
    '--allowedTools',
    `Read(/${f.instruction})`,
    '--allowedTools',
    `Read(/${f.skill})`,
    '--allowedTools',
    `Read(/${f.role})`,
    '--allowedTools',
    'Bash(node --test index.test.mjs)',
    '--allowedTools',
    `Edit(/${path.join(f.cwd, 'index.mjs')})`,
  ]);
  assert.ok(call.input.includes(`## instruction: ${f.instruction}`));
  assert.ok(call.input.includes(f.instructionBytes));
  assert.ok(call.input.includes(f.skillBytes));
  assert.ok(call.input.includes(f.roleBody));
  assert.ok(!call.input.includes('model: upstream-model'));
  assert.ok(call.input.endsWith(task));
  assert.equal(receipt.sessionId, sessionId);
  assert.equal(receipt.observedModel, 'claude-opus-5-5');
  assert.equal(receipt.result, finalEvent.result);
  assert.deepEqual(receipt.resultEvent, finalEvent);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.spawnError, null);
  assert.equal(receipt.parseError, null);
  assert.ok(Number.isInteger(receipt.pid));
  assert.deepEqual(
    await readFile(receipt.stdoutPath),
    Buffer.from(streamBytes),
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

test('documented invocation grants exact context reads and task-authorized leaf and verification access', async (t) => {
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
  assert.deepEqual(allowedTools, [
    `Read(/${f.instruction})`,
    `Read(/${f.skill})`,
    leafRule,
    verificationRule,
  ]);
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.ok(!call.args.includes('--permission-mode'));
  assert.ok(!call.input.includes('## role:'));
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
  assert.ok(call.args.includes(`Read(/${rubric})`));
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
  assert.equal(await readFile(receipt.stderrPath, 'utf8'), 'original stderr\n');
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
  assert.equal(receipt.sessionId, sessionId);
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
