import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';

const project = fileURLToPath(new URL('..', import.meta.url));
const fakeSource = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const log = (event) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({pid:process.pid,cwd:process.cwd(),...event})+'\n');
const args = process.argv.slice(2);
log({args});
if (args[0] === '--version') { console.log('codex-cli 0.fixture'); process.exit(0); }
if (args[0] === 'app-server' && args[1] === '--help') { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(3);
const send = (value) => console.log(JSON.stringify(value));
const notify = (method, params) => send({method,params});
const respond = (request, result) => send({id:request.id,result});
let threadId, turnId, timer;
const lines = readline.createInterface({input:process.stdin});
lines.on('line', (line) => {
 const request = JSON.parse(line); log({request});
 const p = request.params;
 switch (request.method) {
 case 'initialize': if (!process.env.FAKE_HOLD_INITIALIZE) respond(request,{userAgent:'fixture'}); break;
 case 'initialized': break;
 case 'account/read': respond(request,process.env.FAKE_NO_AUTH ? {account:null,requiresOpenaiAuth:true} : {account:{type:'chatgpt',email:'private@example.invalid'},requiresOpenaiAuth:true}); break;
 case 'config/read': respond(request,{config:{model_provider:'openai'}}); break;
 case 'model/list': respond(request,p.cursor ? {data:[{id:'second-model',model:'second-model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null} : {data:[{id:'selected-model',model:'selected-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'xhigh'}]}],nextCursor:'second-page'}); break;
 case 'thread/start': case 'thread/resume':
  if (process.env.FAKE_HOLD_THREAD) break;
  threadId = p.threadId ?? 'thread-'+process.pid;
  respond(request,{thread:{id:threadId},model:'observed-model',reasoningEffort:'high',cwd:p.cwd}); break;
 case 'turn/start': {
  turnId = 'turn-'+process.pid;
  const prompt = p.input[0].text;
  if (!prompt.includes('NO_ID')) notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  const started = () => {
   if (prompt.includes('NO_ID')) notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
   respond(request,{turn:{id:turnId,status:'inProgress'},...(process.env.FAKE_UNKNOWN_SETTINGS ? {} : {model:'observed-model',effort:'high'})});
   if (prompt.includes('WAIT')) return;
   if (process.env.FAKE_MALFORMED_OUTPUT) { process.stdout.write('{"method":\n'); return; }
   if (process.env.FAKE_OUTPUT !== undefined) {
    const text = process.env.FAKE_OUTPUT;
    const records = [
     {method:'item/commandExecution/outputDelta',params:{threadId,turnId,itemId:'command',delta:text}},
     {method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text}}},
     {method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}}
    ];
    const wire = records.map((record)=>JSON.stringify(record)).join('\n');
    if (process.env.FAKE_OUTPUT_EOF) { process.stdout.end(wire); return; }
    const bytes = Buffer.from(wire+'\n');
    const cuts = process.env.FAKE_SPLIT_OUTPUT
     ? [0,bytes.indexOf(Buffer.from('\u2028'))+1,bytes.indexOf(Buffer.from('\u2029'))+2,bytes.length]
     : [0,bytes.length];
    const write = (index) => process.stdout.write(bytes.subarray(cuts[index],cuts[index+1]),()=>{
     if (index+2<cuts.length) setTimeout(()=>write(index+1),10);
    });
    write(0); return;
   }
   notify('item/completed',{threadId,turnId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'answer for '+threadId}});
   if (prompt.includes('EXIT')) { setTimeout(()=>process.exit(7),40); return; }
   timer = setTimeout(()=>notify('turn/completed',{threadId,turn:{id:turnId,status:prompt.includes('FAIL')?'failed':'completed',error:prompt.includes('FAIL')?{message:'actual terminal failure'}:null}}),prompt.includes('FAIL')?450:40);
  };
  if (prompt.includes('EARLY') || prompt.includes('NO_ID')) setTimeout(started,180); else started();
  break;
 }
 case 'turn/interrupt': clearTimeout(timer); if (process.env.FAKE_IGNORE_INTERRUPT) break; respond(request,{}); notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted'}}); break;
 default: send({id:request.id,error:{code:-32601,message:'unexpected '+request.method}});
 }
});
lines.on('close',()=>process.exit(0));
process.on('exit',(code)=>log({exitCode:code}));
`;

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack codex worker ')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'copied plugin with spaces');
  await cp(
    path.join(project, 'plugin-claude/vendor'),
    path.join(plugin, 'vendor'),
    { recursive: true },
  );
  const runner = path.join(plugin, 'skills/poteto-mode/scripts/run-codex.mjs');
  await mkdir(path.dirname(runner), { recursive: true });
  await cp(
    path.join(
      project,
      'plugin-claude/skills/poteto-mode/scripts/run-codex.mjs',
    ),
    runner,
  );
  const workerContext = path.join(
    plugin,
    'skills/poteto-mode/references/worker-context.md',
  );
  await mkdir(path.dirname(workerContext), { recursive: true });
  await cp(
    path.join(
      project,
      'plugin-claude/skills/poteto-mode/references/worker-context.md',
    ),
    workerContext,
  );
  const executable = path.join(root, 'fake codex');
  await writeFile(
    executable,
    fakeSource.replace('#!/usr/bin/env node', '#!' + process.execPath),
    { mode: 0o755 },
  );
  const cwd = path.join(root, 'assigned worktree');
  await mkdir(cwd);
  const log = path.join(root, 'server.jsonl');
  const env = {
    ...process.env,
    FAKE_LOG: log,
    CODEX_COMPANION_APP_SERVER_ENDPOINT: '/must-not-use-shared-broker',
  };
  const role = path.join(root, 'role.md'),
    instruction = path.join(root, 'AGENTS.md'),
    skill = path.join(root, 'skill.md');
  await writeFile(
    role,
    '---\nname: original-role\n---\nFull role instructions.\n',
  );
  await writeFile(instruction, 'Full project instructions.\r\n');
  await writeFile(skill, 'Full skill instructions and principles.\n');
  const args = (run: string, extra: string[] = []) => [
    runner,
    'run',
    '--cwd',
    cwd,
    '--run-dir',
    path.join(root, run),
    '--model',
    'selected-model',
    '--effort',
    'xhigh',
    '--executable',
    executable,
    '--role',
    role,
    '--instruction',
    instruction,
    '--skill',
    skill,
    ...extra,
  ];
  const run = (
    name: string,
    prompt = 'Do the synthetic task.',
    extra: string[] = [],
    extraEnv: Record<string, string> = {},
  ) =>
    spawnSync(process.execPath, args(name, extra), {
      env: { ...env, ...extraEnv },
      input: prompt,
      encoding: 'utf8',
      timeout: 10_000,
    });
  const receipt = async (name: string) =>
    JSON.parse(await readFile(path.join(root, name, 'result.json'), 'utf8'));
  const events = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    role,
    instruction,
    skill,
    workerContext,
    root,
    plugin,
    runner,
    executable,
    cwd,
    env,
    args,
    run,
    receipt,
    events,
  };
}

test('locked selected source has a complete executable import closure and exact source mappings', async () => {
  const lock = JSON.parse(
    await readFile(path.join(project, 'codex-runtime.lock.json'), 'utf8'),
  );
  assert.equal(lock.schemaVersion, 1);
  const runtime = lock.codexRuntime;
  assert.equal(runtime.revision, 'db52e28f4d9ded852ab3942cea316258ae4ef346');
  const snapshot = path.join(project, 'upstream/codex-runtime');
  assert.equal(await computeSnapshotDigest(snapshot), runtime.snapshotSha256);
  const sources = new Set<string>(
    runtime.files.map((file: { source: string }) => file.source),
  );
  for (const file of runtime.files) {
    assert.equal(file.target, `vendor/codex-plugin-cc/${file.source}`);
    if (!file.source.endsWith('.mjs')) continue;
    const body = await readFile(path.join(snapshot, file.source), 'utf8');
    for (const match of body.matchAll(
      /(?:from\s+|import\s*\(|new URL\s*\()\s*["'](\.[^"']+)["']/g,
    )) {
      let relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.source), match[1]!),
      );
      if (!path.posix.extname(relative)) relative += '.d.ts';
      assert(
        sources.has(relative),
        `Missing import ${relative} from ${file.source}`,
      );
    }
  }
  for (const required of [
    'LICENSE',
    'NOTICE',
    'plugins/codex/LICENSE',
    'plugins/codex/NOTICE',
    'plugins/codex/.claude-plugin/plugin.json',
  ])
    assert(sources.has(required));
});

test('copied runner delivers settings and full instruction bodies, then awaits terminal completion', async (t) => {
  const f = await fixture(t),
    result = f.run('completed', 'Use only this task.');
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('completed');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.finalText, `answer for ${receipt.threadId}`);
  assert.deepEqual(receipt.requested, {
    model: 'selected-model',
    effort: 'xhigh',
  });
  assert.deepEqual(receipt.observed, {
    model: 'observed-model',
    effort: 'high',
  });
  assert.equal(receipt.process.closed, true);
  assert.equal(receipt.process.exitCode, 0);
  const events = await f.events(),
    start = events.find((event) => event.request?.method === 'thread/start');
  assert.equal(start.cwd, f.cwd);
  assert.equal(start.request.params.cwd, f.cwd);
  assert.equal(start.request.params.ephemeral, false);
  assert.equal(start.request.params.sandbox, 'read-only');
  assert.equal(start.request.params.approvalPolicy, 'on-request');
  assert.equal(start.request.params.approvalsReviewer, 'auto_review');
  assert.equal(start.request.params.threadSource, 'chatgpt_hidden');
  const turn = events.find((event) => event.request?.method === 'turn/start');
  assert.equal(turn.request.params.model, 'selected-model');
  assert.equal(turn.request.params.effort, 'xhigh');
  const prompt = turn.request.params.input[0].text;
  for (const body of [
    'Full role instructions.',
    'Full project instructions.\r\n',
    'Full skill instructions and principles.',
    'Use only this task.',
  ])
    assert(prompt.includes(body));
  assert.equal(await readFile(receipt.files.prompt, 'utf8'), prompt);
  assert(
    (await readFile(receipt.files.diagnostics, 'utf8')).includes(
      'turn/completed',
    ),
  );
  assert.equal(
    events.filter(
      (event) => event.args?.[0] === 'app-server' && event.args.length === 1,
    ).length,
    1,
  );
});

for (const threadSource of [undefined, 'custom-source'])
  test(`generic vendor preserves ${threadSource ?? 'omitted'} thread source`, async (t) => {
    const f = await fixture(t);
    const module = pathToFileURL(
      path.join(
        f.plugin,
        'vendor/codex-plugin-cc/plugins/codex/scripts/lib/codex.mjs',
      ),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { runAppServerTurn } = await import(${JSON.stringify(module)});
await runAppServerTurn(${JSON.stringify(f.cwd)}, ${JSON.stringify({
          direct: true,
          executable: f.executable,
          prompt: 'Do the synthetic task.',
          threadSource,
        })});`,
      ],
      { env: f.env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const start = (await f.events()).find(
      (event) => event.request?.method === 'thread/start',
    );
    assert.equal(
      Object.hasOwn(start.request.params, 'threadSource'),
      threadSource !== undefined,
    );
    assert.equal(start.request.params.threadSource, threadSource);
  });

for (const [name, text, extraEnv] of [
  ['escaped newline', 'before\nmiddle\nafter', {}],
  ['U+2028', 'before\u2028middle\u2028after', {}],
  ['U+2029', 'before\u2029middle\u2029after', {}],
  [
    'split UTF-8 separators',
    'before\nmiddle\u2028line\u2029after',
    { FAKE_SPLIT_OUTPUT: '1' },
  ],
  [
    'EOF without trailing LF',
    'before\nmiddle\nafter',
    { FAKE_OUTPUT_EOF: '1' },
  ],
] as const)
  test(`runner preserves exact command output and final text for ${name}`, async (t) => {
    const f = await fixture(t);
    const result = f.run('text', 'Return the synthetic text.', [], {
      FAKE_OUTPUT: text,
      ...extraEnv,
    });
    const receipt = await f.receipt('text');
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(receipt.error),
    );
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.finalText, text);
    assert.equal(await readFile(receipt.files.final, 'utf8'), text);
    const received = (await readFile(receipt.files.diagnostics, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (event) =>
          event.direction === 'receive' && typeof event.line === 'string',
      )
      .map((event) => JSON.parse(event.line));
    assert.deepEqual(
      received
        .filter((event) => event.method === 'item/commandExecution/outputDelta')
        .map((event) => event.params.delta),
      [text],
    );
    assert.equal(
      received.filter((event) => event.method === 'item/completed').length,
      1,
    );
    assert.equal(receipt.process.closed, true);
    assert.equal(receipt.process.exitCode, 0);
  });

test('runner rejects malformed JSONL and closes its app-server', async (t) => {
  const f = await fixture(t);
  const result = f.run('malformed', 'Return malformed fixture output.', [], {
    FAKE_MALFORMED_OUTPUT: '1',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = await f.receipt('malformed');
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.error.message, /Failed to parse codex app-server JSONL/);
  assert.equal(receipt.finalText, '');
  const deadline = Date.now() + 1000;
  while (
    !(await f.events()).some(
      (event) =>
        event.pid === receipt.process.pid && event.exitCode !== undefined,
    )
  ) {
    assert(
      Date.now() < deadline,
      'Malformed output left its app-server alive.',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.throws(() => process.kill(receipt.process.pid, 0), /ESRCH/);
});

test('runner assembles complete installed instructions while keeping linked references separate', async (t) => {
  const f = await fixture(t);
  const plugin = path.join(project, 'plugin-claude');
  const linked = path.join(f.cwd, 'separate evidence.txt');
  const linkedBody =
    'Evidence stays in its own file until the worker reads it.\n';
  const role = await readFile(
    path.join(plugin, 'agents/poteto-agent.md'),
    'utf8',
  );
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
  const task = 'Inspect the assigned evidence and return its value.';
  const result = f.run('complete-instructions', task, ['--skill', leaf]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('complete-instructions');
  const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
  assert.deepEqual(request.instructions, [
    { kind: 'role', path: f.role, body: role },
    { kind: 'instruction', path: f.instruction, body: instruction },
    { kind: 'skill', path: f.skill, body: skill },
    { kind: 'skill', path: leaf, body: leafBody },
  ]);
  const turn = (await f.events()).find(
    (event) => event.request?.method === 'turn/start',
  );
  const prompt = turn.request.params.input[0].text;
  let end = 0;
  for (const body of [
    role,
    instruction,
    skill,
    leafBody,
    await readFile(f.workerContext, 'utf8'),
    task,
  ]) {
    const start = prompt.indexOf(body, end);
    assert.ok(start >= end);
    end = start + body.length;
  }
  assert.ok(!prompt.includes(linkedBody));
  assert.equal(await readFile(receipt.files.prompt, 'utf8'), prompt);
});

for (const category of ['instruction', 'skill', 'role'])
  test(`missing ${category} body fails before launching Codex`, async (t) => {
    const f = await fixture(t);
    await rm(f[category as 'instruction' | 'skill' | 'role']);
    const result = f.run('missing-body');
    assert.equal(result.status, 1);
    await assert.rejects(
      readFile(path.join(f.root, 'missing-body/request.json')),
      { code: 'ENOENT' },
    );
    await assert.rejects(f.events(), { code: 'ENOENT' });
  });

test('terminal failure wins over an earlier final answer and abrupt server exit fails', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run('failed', 'FAIL').status, 1);
  const failed = await f.receipt('failed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.turn.status, 'failed');
  assert.match(JSON.stringify(failed.error), /actual terminal failure/);
  assert.equal(f.run('exited', 'EXIT').status, 1);
  const exited = await f.receipt('exited');
  assert.equal(exited.status, 'failed');
  assert.equal(exited.process.exitCode, 7);
});

test('parallel workers and interleaved exact continuation retain separate identities and outputs', async (t) => {
  const f = await fixture(t);
  const launch = (name: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, f.args(name), { env: f.env });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('exit', (code) => resolve({ code, stderr }));
      child.stdin.end('Synthetic parallel task.');
    });
  for (const result of await Promise.all([launch('first'), launch('second')]))
    assert.equal(result.code, 0, result.stderr);
  const first = await f.receipt('first'),
    second = await f.receipt('second');
  assert.notEqual(first.threadId, second.threadId);
  assert.notEqual(first.files.progress, second.files.progress);
  assert.equal(
    f.run('resumed', 'Continue that worker.', [
      '--resume',
      first.threadId,
      '--write',
    ]).status,
    0,
  );
  const resumed = await f.receipt('resumed');
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.finalText, `answer for ${first.threadId}`);
  const events = await f.events();
  const resume = events.find(
    (event) => event.request?.method === 'thread/resume',
  );
  assert.equal(resume.request.params.threadId, first.threadId);
  assert.equal(resume.request.params.cwd, f.cwd);
  assert.equal(resume.request.params.sandbox, 'workspace-write');
  assert.equal(resume.request.params.approvalPolicy, 'on-request');
  assert.equal(resume.request.params.approvalsReviewer, 'auto_review');
  assert.equal(Object.hasOwn(resume.request.params, 'threadSource'), false);
  assert.equal(
    events.some(
      (event) =>
        event.pid === resume.pid && event.request?.method === 'thread/start',
    ),
    false,
  );
});

for (const prompt of ['WAIT', 'EARLY WAIT'])
  test(`signal interrupts the exact active turn and closes its process for ${prompt}`, async (t) => {
    const f = await fixture(t),
      child = spawn(process.execPath, f.args('cancelled'), {
        env: { ...f.env, FAKE_IGNORE_INTERRUPT: '1' },
      });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(prompt);
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    const deadline = Date.now() + 5000;
    while (
      !(await f.events().catch(() => [])).some(
        (event) => event.request?.method === 'turn/start',
      )
    ) {
      assert(Date.now() < deadline, stderr);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill(prompt.startsWith('EARLY') ? 'SIGINT' : 'SIGTERM');
    assert.equal(await exited, prompt.startsWith('EARLY') ? 130 : 143, stderr);
    const receipt = await f.receipt('cancelled');
    assert.equal(receipt.status, 'interrupted');
    assert.equal(receipt.process.closed, true);
    const events = await f.events(),
      interrupt = events.find(
        (event) => event.request?.method === 'turn/interrupt',
      );
    assert.equal(interrupt.request.params.threadId, receipt.threadId);
    assert.equal(interrupt.request.params.turnId, receipt.turnId);
    assert(
      events.some(
        (event) => event.pid === interrupt.pid && event.exitCode === 0,
      ),
    );
    assert.throws(() => process.kill(interrupt.pid, 0), /ESRCH/);
  });

test('catalog walks every page and keeps authentication distinct from model execution', async (t) => {
  const f = await fixture(t);
  const invoke = (command: string, extraEnv = {}) =>
    spawnSync(
      process.execPath,
      [f.runner, command, '--cwd', f.cwd, '--executable', f.executable],
      { env: { ...f.env, ...extraEnv }, encoding: 'utf8', timeout: 10_000 },
    );
  const detected = JSON.parse(invoke('detect').stdout);
  assert.equal(detected.cli.available, true);
  assert.equal(detected.auth.loggedIn, true);
  assert.equal(detected.execution.verified, false);
  assert(!JSON.stringify(detected).includes('private@example.invalid'));
  const catalog = JSON.parse(invoke('catalog').stdout);
  assert.deepEqual(
    catalog.models.map((model: { id: string }) => model.id),
    ['selected-model', 'second-model'],
  );
  assert.equal(catalog.pages.length, 2);
  assert.equal(catalog.execution.verified, false);
  assert.equal(
    JSON.parse(invoke('detect', { FAKE_NO_AUTH: '1' }).stdout).auth.loggedIn,
    false,
  );
});

test('prompt files and unknown effective settings stay explicit, and run records cannot be reused', async (t) => {
  const f = await fixture(t);
  const prompt = path.join(f.root, 'prompt file.txt');
  await writeFile(prompt, 'Read this synthetic prompt file.\n');
  const result = spawnSync(
    process.execPath,
    f.args('prompt-file', ['--prompt-file', prompt]),
    {
      env: { ...f.env, FAKE_UNKNOWN_SETTINGS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('prompt-file');
  assert.deepEqual(receipt.observed, { model: null, effort: null });
  assert.deepEqual(receipt.threadSettings, {
    model: 'observed-model',
    effort: 'high',
  });
  const before = await readFile(receipt.files.result, 'utf8');
  assert.equal(f.run('prompt-file').status, 1);
  assert.equal(await readFile(receipt.files.result, 'utf8'), before);
  const turn = (await f.events()).find(
    (event) => event.request?.method === 'turn/start',
  );
  assert.equal(
    await readFile(receipt.files.prompt, 'utf8'),
    turn.request.params.input[0].text,
  );
});

for (const [method, variable] of [
  ['initialize', 'FAKE_HOLD_INITIALIZE'],
  ['thread/start', 'FAKE_HOLD_THREAD'],
] as const)
  test(`signal closes the owned server while ${method} is pending`, async (t) => {
    const f = await fixture(t);
    const child = spawn(process.execPath, f.args('startup-cancelled'), {
      env: { ...f.env, [variable]: '1' },
    });
    child.stdin.end('Synthetic startup cancellation.');
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    const deadline = Date.now() + 5000;
    while (
      !(await f.events().catch(() => [])).some(
        (event) => event.request?.method === method,
      )
    ) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGTERM');
    assert.equal(await exited, 143);
    const receipt = await f.receipt('startup-cancelled');
    assert.equal(receipt.status, 'interrupted');
    assert.equal(receipt.turnId, null);
    assert.equal(receipt.process.closed, true);
    assert.throws(() => process.kill(receipt.process.pid, 0), /ESRCH/);
  });

test('explicit sandbox selection is recorded without changing the default or write shorthand', async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.run('explicit-access', 'Synthetic authorized access.', [
      '--sandbox',
      'danger-full-access',
    ]).status,
    0,
  );
  const receipt = await f.receipt('explicit-access');
  assert.equal(receipt.sandbox, 'danger-full-access');
  const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
  assert.equal(request.sandbox, 'danger-full-access');
  const start = (await f.events()).find(
    (event) => event.request?.method === 'thread/start',
  );
  assert.equal(start.request.params.sandbox, 'danger-full-access');
  assert.equal(
    f.run('conflicting-access', 'Synthetic task.', [
      '--sandbox',
      'read-only',
      '--write',
    ]).status,
    1,
  );
  assert.equal(
    f.run('invalid-access', 'Synthetic task.', ['--sandbox', 'invented'])
      .status,
    1,
  );
});

test('Codex transport injects its receiving executor and the bundled shared context', async (t) => {
  const f = await fixture(t);
  await writeFile(f.workerContext, 'Shared receiving fixture context.');
  const result = f.run('receiving-context');
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(
    await readFile(path.join(f.root, 'receiving-context/request.json'), 'utf8'),
  );
  const prompt = await readFile(
    path.join(f.root, 'receiving-context/prompt.txt'),
    'utf8',
  );
  assert.equal(request.executor, 'codex');
  assert.deepEqual(request.requested, {
    model: 'selected-model',
    effort: 'xhigh',
  });
  assert.equal(request.sandbox, 'read-only');
  const events = await f.events();
  const start = events.find(
    (event) => event.request?.method === 'thread/start',
  );
  const turn = events.find((event) => event.request?.method === 'turn/start');
  assert.equal(start.request.params.sandbox, 'read-only');
  assert.equal(turn.request.params.model, 'selected-model');
  assert.equal(turn.request.params.effort, 'xhigh');
  assert.equal(turn.request.params.input[0].text, prompt);
  assert.ok(prompt.includes('Full role instructions.'));
  assert.ok(prompt.includes(`Receiving executor is ${request.executor}.`));
  assert.ok(prompt.includes('Shared receiving fixture context.'));
  assert.ok(
    prompt.indexOf('Shared receiving fixture context.') <
      prompt.indexOf('Task\n\n'),
  );
});
