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
import { fileURLToPath } from 'node:url';
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
  const executable = path.join(root, 'fake codex');
  await writeFile(executable, fakeSource, { mode: 0o755 });
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
  ) =>
    spawnSync(process.execPath, args(name, extra), {
      env,
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
  return { root, runner, executable, cwd, env, args, run, receipt, events };
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
  const resume = (await f.events()).find(
    (event) => event.request?.method === 'thread/resume',
  );
  assert.equal(resume.request.params.threadId, first.threadId);
  assert.equal(resume.request.params.cwd, f.cwd);
  assert.equal(resume.request.params.sandbox, 'workspace-write');
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
