import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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
const fakePrelude = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const log = (event) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({pid:process.pid,cwd:process.cwd(),...event})+'\n');
const args = process.argv.slice(2);
log({args});
`;
const fakeStandalone = String.raw`
if (args.length === 1 && args[0] === '--version') { console.log('codex-app-server 0.fixture'); process.exit(0); }
if (args.length === 3 && args.join(' ') === '--session-source app-server --help') {
 console.log(process.env.FAKE_NO_SOURCE_FLAG ? 'Usage: codex-app-server' : 'Usage: codex-app-server --session-source <SOURCE>'); process.exit(0);
}
if (args.length !== 2 || args.join(' ') !== '--session-source app-server') { console.error('unsupported standalone arguments'); process.exit(3); }
`;
const fakeUmbrella = String.raw`
if (args.length === 1 && args[0] === '--version') { console.log('codex-cli 0.fixture'); process.exit(0); }
if (args.length === 2 && args.join(' ') === 'app-server --help') { console.log('Usage: codex app-server'); process.exit(0); }
if (args.length !== 1 || args[0] !== 'app-server') { console.error('unsupported umbrella arguments'); process.exit(3); }
`;
const fakeProtocol = String.raw`
const send = (value) => console.log(JSON.stringify(value));
const notify = (method, params) => send({method,params});
const respond = (request, result) => send({id:request.id,result});
let threadId, turnId, rollout, timer;
const lines = readline.createInterface({input:process.stdin});
lines.on('line', (line) => {
 const request = JSON.parse(line); log({request});
 const p = request.params;
 switch (request.method) {
 case undefined: break;
 case 'initialize': if (process.env.FAKE_INSPECT_CASE === 'initialize-error') { send({id:request.id,error:{code:-32000,message:'initialize unavailable'}}); break; } if (!process.env.FAKE_HOLD_INITIALIZE) respond(request,{userAgent:'fixture'}); break;
 case 'initialized': break;
 case 'account/read':
  if (process.env.FAKE_INSPECT_CASE === 'account-error') { send({id:request.id,error:{code:-32000,message:'account unavailable'}}); break; }
  if (process.env.FAKE_ACCOUNT_JSON) { respond(request,JSON.parse(process.env.FAKE_ACCOUNT_JSON)); break; }
  respond(request,process.env.FAKE_NO_AUTH ? {account:null,requiresOpenaiAuth:true} : {account:{type:'chatgpt',email:'private@example.invalid'},requiresOpenaiAuth:true}); break;
 case 'config/read': respond(request,{config:{model_provider:'openai'}}); break;
 case 'model/list': if (process.env.FAKE_INSPECT_CASE === 'catalog-error') { send({id:request.id,error:{code:-32000,message:'catalog unavailable'}}); break; } respond(request,p.cursor ? {data:[{id:'second-model',model:'second-model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null} : {data:[{id:'selected-model',model:'selected-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'xhigh'}]}],nextCursor:'second-page'}); break;
 case 'thread/start': case 'thread/resume':
  if (process.env.FAKE_HOLD_THREAD) break;
  if (p.threadId && process.env.FAKE_NO_ROLLOUT) { send({id:request.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}}); break; }
  threadId = p.threadId && process.env.FAKE_RESUME_OTHER ? 'thread-other' : p.threadId ?? 'thread-'+process.pid;
  rollout = process.env.FAKE_LOG+'.'+threadId+'.rollout.jsonl';
  fs.appendFileSync(rollout,JSON.stringify({type:'turn_context',payload:{turn_id:'earlier-turn',model:'earlier-model',effort:'ultra'}})+'\n{"type":\n');
  respond(request,{thread:{id:threadId,path:rollout},model:'observed-model',reasoningEffort:'high',cwd:p.cwd}); break;
 case 'turn/start': {
  if (process.env.FAKE_HOLD_TURN_STARTED) break;
  turnId = 'turn-'+process.pid;
  const prompt = p.input[0].text;
  if (!process.env.FAKE_UNKNOWN_SETTINGS) fs.appendFileSync(rollout,JSON.stringify({type:'turn_context',payload:{turn_id:turnId,model:'turn-model',effort:'low'}})+'\n');
  notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  const started = () => {
   respond(request,{turn:{id:turnId,status:'inProgress'}});
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
   if (prompt.includes('DENY')) {
    const review = (reviewId,status,thread) => ({threadId:thread,turnId,startedAtMs:1,completedAtMs:2,reviewId,targetItemId:'call-'+reviewId,decisionSource:'agent',review:{status,riskLevel:'high',userAuthorization:'low',rationale:'synthetic '+status},action:{type:'mcpToolCall',server:'cua_repl',toolName:'js',connectorId:'node_repl',connectorName:'Node REPL',toolTitle:'Read app state'}});
    notify('item/autoApprovalReview/completed',review('review-approved','approved',threadId));
    notify('item/autoApprovalReview/completed',review('review-denied','denied',threadId));
    notify('item/autoApprovalReview/completed',review('review-other-thread','denied','other-thread'));
   }
   if (prompt.includes('ASK')) JSON.parse(process.env.FAKE_SERVER_REQUESTS).forEach((method,index)=>send({id:'ask-'+index,method,params:{threadId,turnId}}));
   if (prompt.includes('RETRY')) notify('error',{threadId,turnId,willRetry:true,error:{message:'transient stream retry',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:502}},additionalDetails:null}});
   if (prompt.includes('FINAL_ERROR')) notify('error',{threadId,turnId,willRetry:false,error:{message:'final stream failure',codexErrorInfo:JSON.parse(process.env.FAKE_FINAL_ERROR_INFO ?? '"other"'),additionalDetails:null}});
   notify('item/completed',{threadId,turnId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'answer for '+threadId}});
   if (prompt.includes('EXIT')) { setTimeout(()=>process.exit(7),40); return; }
   timer = setTimeout(()=>notify('turn/completed',{threadId,turn:{id:turnId,status:prompt.includes('FAIL')?'failed':'completed',error:prompt.includes('FAIL')?JSON.parse(process.env.FAKE_TURN_ERROR ?? 'null') ?? {message:'actual terminal failure',codexErrorInfo:JSON.parse(process.env.FAKE_TURN_ERROR_INFO ?? 'null')}:null}}),prompt.includes('FAIL')?450:40);
  };
  if (!process.env.FAKE_HOLD_TURN_RESPONSE) started();
  break;
 }
 case 'thread/approveGuardianDeniedAction': if (process.env.FAKE_REJECT_APPROVAL) { send({id:request.id,error:{code:-32600,message:'approval rejected'}}); break; } respond(request,{}); break;
 case 'turn/interrupt': clearTimeout(timer); if (process.env.FAKE_IGNORE_INTERRUPT) break; if (process.env.FAKE_INTERRUPT_NOT_RUNNING) { send({id:request.id,error:{code:-32600,message:'no active turn to interrupt'}}); break; } respond(request,{}); notify('turn/completed',{threadId,turn:{id:turnId,status:'interrupted'}}); break;
 default: send({id:request.id,error:{code:-32601,message:'unexpected '+request.method}});
 }
});
lines.on('close',()=>process.exit(0));
`;

async function stopRunner(runner: ChildProcess) {
  if (runner.exitCode !== null || runner.signalCode !== null) return;
  const exited = once(runner, 'exit');
  runner.kill('SIGKILL');
  await exited;
}

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack codex worker ')),
  );
  const runners: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(runners.map(stopRunner));
    await rm(root, { recursive: true, force: true });
  });
  const plugin = path.join(root, 'copied plugin with spaces');
  await cp(
    path.join(project, 'plugin-claude/vendor'),
    path.join(plugin, 'vendor'),
    { recursive: true },
  );
  await cp(
    path.join(project, 'plugin-claude/skills/setup-pstack/scripts'),
    path.join(plugin, 'skills/setup-pstack/scripts'),
    { recursive: true },
  );
  const runner = path.join(plugin, 'skills/poteto-mode/scripts/run-codex.mjs');
  await mkdir(path.dirname(runner), { recursive: true });
  for (const name of [
    'run-codex.mjs',
    'worker-runtime.mjs',
    'worker-supervisor.mjs',
  ])
    await cp(
      path.join(project, 'plugin-claude/skills/poteto-mode/scripts', name),
      path.join(path.dirname(runner), name),
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
  const executable = path.join(root, 'fake standalone codex');
  const umbrella = path.join(root, 'codex');
  for (const [file, launch] of [
    [executable, fakeStandalone],
    [umbrella, fakeUmbrella],
  ])
    await writeFile(
      file!,
      (fakePrelude + launch + fakeProtocol).replace(
        '#!/usr/bin/env node',
        '#!' + process.execPath,
      ),
      { mode: 0o755 },
    );
  const cwd = path.join(root, 'assigned worktree');
  await mkdir(cwd);
  const log = path.join(root, 'server.jsonl');
  const claudeHome = path.join(root, 'claude home');
  const saveCodexWorkers = async (codexWorkers: 'hidden' | 'visible') => {
    await mkdir(path.join(claudeHome, 'pstack-cc'), { recursive: true });
    await writeFile(
      path.join(claudeHome, 'pstack-cc/models.json'),
      JSON.stringify({ schemaVersion: 1, host: 'claude-code', codexWorkers }),
    );
  };
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    FAKE_LOG: log,
    CODEX_COMPANION_APP_SERVER_ENDPOINT: '/must-not-use-shared-broker',
    PSTACK_STATE_HOME: path.join(root, 'state'),
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
  const start = (name: string, extraEnv: Record<string, string> = {}) => {
    const runner = spawn(process.execPath, args(name), {
      env: { ...env, ...extraEnv },
    });
    runners.push(runner);
    return runner;
  };
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
    umbrella,
    saveCodexWorkers,
    cwd,
    env,
    args,
    run,
    start,
    receipt,
    events,
  };
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function assertClosedByClient(server: {
  pid: number;
  closed: boolean;
  exitCode: number | null;
  signal: string | null;
}) {
  assert.equal(server.closed, true);
  assert(
    (server.exitCode === 0 && server.signal === null) ||
      (server.exitCode === null && server.signal === 'SIGTERM'),
    `The app-server neither exited cleanly after stdin closed nor stopped on the client's SIGTERM: ${JSON.stringify(server)}`,
  );
  assert.equal(running(server.pid), false);
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
  assert.deepEqual(receipt.stop, {
    kind: 'completed',
    code: 'completed',
    cause: 'completed',
    continuable: true,
  });
  assert.equal(receipt.finalText, `answer for ${receipt.threadId}`);
  assert.deepEqual(receipt.requested, {
    model: 'selected-model',
    effort: 'xhigh',
  });
  assert.deepEqual(receipt.observed, { model: 'turn-model', effort: 'low' });
  assert.deepEqual(receipt.threadSettings, {
    model: 'observed-model',
    effort: 'high',
  });
  assert.equal(
    receipt.rolloutPath,
    `${f.root}/server.jsonl.${receipt.threadId}.rollout.jsonl`,
  );
  assertClosedByClient(receipt.process);
  assert.equal(receipt.runtime.workers, 'hidden');
  assert.equal(receipt.runtime.kind, 'standalone-app-server');
  assert.equal(receipt.runtime.executable, f.executable);
  assert.equal(receipt.runtime.version, 'codex-app-server 0.fixture');
  assert.deepEqual(receipt.runtime.args, ['--session-source', 'app-server']);
  const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
  assert.equal(request.runtime.executable, f.executable);
  assert.deepEqual(request.runtime.args, receipt.runtime.args);
  const diagnostics = (await readFile(receipt.files.diagnostics, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const launch = diagnostics.find((event) => event.event === 'spawn');
  assert.equal(launch.executable, f.executable);
  assert.deepEqual(launch.args, receipt.runtime.args);
  const events = await f.events(),
    start = events.find((event) => event.request?.method === 'thread/start');
  assert.equal(start.cwd, f.cwd);
  assert.equal(start.request.params.cwd, f.cwd);
  assert.equal(start.request.params.ephemeral, false);
  assert.equal(start.request.params.sandbox, 'workspace-write');
  assert.equal(start.request.params.approvalPolicy, 'on-request');
  assert.equal(start.request.params.approvalsReviewer, 'auto_review');
  assert.equal(Object.hasOwn(start.request.params, 'threadSource'), false);
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
      (event) => event.args?.join(' ') === '--session-source app-server',
    ).length,
    1,
  );
});

test('generic vendor keeps the umbrella CLI default when appServerArgs is omitted', async (t) => {
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
        executable: f.umbrella,
        prompt: 'Do the synthetic task.',
      })});`,
    ],
    { env: f.env, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const events = await f.events();
  const start = events.find(
    (event) => event.request?.method === 'thread/start',
  );
  assert.equal(Object.hasOwn(start.request.params, 'threadSource'), false);
  assert.deepEqual(
    events.filter((event) => event.args).map((event) => event.args),
    [['--version'], ['app-server', '--help'], ['app-server']],
  );
});

test('saved visible codexWorkers launches the Codex CLI app-server', async (t) => {
  const f = await fixture(t);
  await f.saveCodexWorkers('visible');
  const args = f.args('visible');
  args[args.indexOf('--executable') + 1] = f.umbrella;
  const result = spawnSync(process.execPath, args, {
    env: f.env,
    input: 'Use the Codex CLI.',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('visible');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.runtime.workers, 'visible');
  assert.equal(receipt.runtime.kind, 'codex-cli');
  assert.equal(receipt.runtime.version, 'codex-cli 0.fixture');
  assert.deepEqual(receipt.runtime.args, ['app-server']);
  assert.deepEqual(
    (await f.events()).filter((event) => event.args).map((event) => event.args),
    [
      ['--version'],
      ['app-server', '--help'],
      ['--version'],
      ['app-server', '--help'],
      ['app-server'],
    ],
  );
});

test('visible codexWorkers detects, catalogs, and runs codex from PATH and rejects the standalone server', async (t) => {
  const f = await fixture(t);
  await f.saveCodexWorkers('visible');
  await cp(f.executable, path.join(f.root, 'codex-app-server'));
  const env = { ...f.env, PATH: f.root };
  for (const command of ['detect', 'catalog']) {
    const result = spawnSync(
      process.execPath,
      [f.runner, command, '--cwd', f.cwd],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const detected = JSON.parse(result.stdout);
    assert.equal(detected.cli.available, true);
    assert.equal(detected.cli.workers, 'visible');
    assert.equal(detected.cli.executable, f.umbrella);
    if (command === 'catalog')
      assert.deepEqual(
        detected.models.map((model: { id: string }) => model.id),
        ['selected-model', 'second-model'],
      );
  }
  const pathArgs = f.args('visible-path');
  pathArgs.splice(pathArgs.indexOf('--executable'), 2);
  const run = spawnSync(process.execPath, pathArgs, {
    env,
    input: 'Use the PATH CLI.',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const pathReceipt = await f.receipt('visible-path');
  assert.equal(pathReceipt.status, 'completed');
  assert.equal(pathReceipt.runtime.executable, f.umbrella);
  assert.deepEqual(pathReceipt.runtime.args, ['app-server']);
  const args = f.args('standalone-for-visible');
  args[args.indexOf('--executable') + 1] = f.executable;
  const result = spawnSync(process.execPath, args, {
    env,
    input: 'Do not create a thread.',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = await f.receipt('standalone-for-visible');
  assert.equal(receipt.threadId, null);
  assert.match(
    receipt.error.message,
    /Codex CLI app-server unavailable for visible Codex workers/,
  );
  assert.match(receipt.error.message, /npm i -g @openai\/codex/);
});

test('--codex-workers overrides the saved setting only for detect and catalog', async (t) => {
  const f = await fixture(t);
  await f.saveCodexWorkers('visible');
  const detected = JSON.parse(
    spawnSync(
      process.execPath,
      [
        f.runner,
        'detect',
        '--codex-workers',
        'hidden',
        '--executable',
        f.executable,
      ],
      { env: f.env, encoding: 'utf8', timeout: 10_000 },
    ).stdout,
  );
  assert.equal(detected.cli.available, true);
  assert.equal(detected.cli.workers, 'hidden');
  assert.deepEqual(detected.cli.args, ['--session-source', 'app-server']);
  const result = f.run('override', 'Do the task.', [
    '--codex-workers',
    'hidden',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run uses the saved codexWorkers setting/);
  const home = path.join(f.root, 'home');
  await mkdir(home);
  const unset = f.run('empty-config-dir', 'Do the task.', [], {
    CLAUDE_CONFIG_DIR: '',
    HOME: home,
  });
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal((await f.receipt('empty-config-dir')).runtime.workers, 'hidden');
});

test('runner skips directories on PATH across detect, catalog, and run', async (t) => {
  const f = await fixture(t);
  const name =
    process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  const shadow = path.join(f.root, 'earlier bin');
  await mkdir(path.join(shadow, name), { recursive: true });
  const discovered = path.join(f.root, name);
  await cp(f.executable, discovered);
  const env = { ...f.env, PATH: [shadow, f.root].join(path.delimiter) };
  for (const command of ['detect', 'catalog']) {
    const result = spawnSync(
      process.execPath,
      [f.runner, command, '--cwd', f.cwd],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const detected = JSON.parse(result.stdout);
    assert.equal(detected.cli.available, true);
    assert.equal(detected.cli.executable, discovered);
    assert.equal(detected.auth.loggedIn, true);
    if (command === 'catalog')
      assert.deepEqual(
        detected.models.map((model: { id: string }) => model.id),
        ['selected-model', 'second-model'],
      );
  }
  const args = f.args('path-runtime');
  args.splice(args.indexOf('--executable'), 2);
  const result = spawnSync(process.execPath, args, {
    env,
    input: 'Use the PATH runtime.',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (await f.receipt('path-runtime')).runtime.executable,
    discovered,
  );
  assert(
    (await f.events()).some(
      (event) => event.args?.join(' ') === '--session-source app-server',
    ),
  );
});

for (const kind of [
  'missing',
  'no-source-flag',
  'umbrella',
  'rejected-source',
] as const)
  test(`runner rejects ${kind} runtime before initialize and retains a failed receipt`, async (t) => {
    const f = await fixture(t);
    const selected =
      kind === 'missing'
        ? path.join(f.root, 'absent')
        : kind === 'umbrella'
          ? f.umbrella
          : f.executable;
    if (kind === 'rejected-source')
      await writeFile(
        selected,
        `#!${process.execPath}\nif(process.argv[2]==='--version') console.log('codex-app-server old'); else { console.error('unknown argument --session-source'); process.exit(2); }\n`,
        { mode: 0o755 },
      );
    const args = f.args(kind);
    args[args.indexOf('--executable') + 1] = selected;
    const env = {
      ...f.env,
      ...(kind === 'no-source-flag' ? { FAKE_NO_SOURCE_FLAG: '1' } : {}),
    };
    const result = spawnSync(process.execPath, args, {
      env,
      input: 'Do not create a thread.',
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    const receipt = await f.receipt(kind);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.threadId, null);
    assert.equal(receipt.process.pid, null);
    assert.equal(receipt.runtime.executable, selected);
    assert.match(
      receipt.error.message,
      /Standalone Codex app-server unavailable/,
    );
    assert(!receipt.error.message.includes('npm install'));
    const events = await f.events().catch(() => []);
    assert.equal(
      events.some((event) => event.request),
      false,
    );
    const detected = JSON.parse(
      spawnSync(
        process.execPath,
        [f.runner, 'detect', '--executable', selected],
        { env, encoding: 'utf8', timeout: 10_000 },
      ).stdout,
    );
    assert.equal(detected.schemaVersion, 1);
    assert.equal(detected.cli.available, false);
    assert.equal(detected.auth.available, false);
    assert.equal(detected.auth.loggedIn, null);
    assert.equal(detected.cli.executable, selected);
  });

test('missing standalone runtime does not fall back to an umbrella CLI on PATH', async (t) => {
  const f = await fixture(t);
  const args = f.args('no-fallback');
  args.splice(args.indexOf('--executable'), 2);
  const result = spawnSync(process.execPath, args, {
    env: { ...f.env, PATH: f.root },
    input: 'Do not use codex.',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal((await f.receipt('no-fallback')).threadId, null);
  await assert.rejects(f.events(), { code: 'ENOENT' });
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
    assertClosedByClient(receipt.process);
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
  while (running(receipt.process.pid)) {
    assert(
      Date.now() < deadline,
      'Malformed output left its app-server alive.',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  assert.equal(failed.stop.kind, 'error');
  assert.equal(failed.stop.continuable, true);
  assert.match(JSON.stringify(failed.error), /actual terminal failure/);
  assert.equal(f.run('exited', 'EXIT').status, 1);
  const exited = await f.receipt('exited');
  assert.equal(exited.status, 'failed');
  assert.equal(exited.process.exitCode, 7);
});

test('a failed turn keeps provider credentials out of every receipt copy of its error', async (t) => {
  const f = await fixture(t);
  const run = f.run('leak', 'FAIL', [], {
    FAKE_TURN_ERROR: JSON.stringify({
      message: 'authentication failed: Bearer sample-only',
      data: { api_key: 'sample-only', note: 'api_token=sample-only' },
    }),
  });
  assert.equal(run.status, 1);
  const receipt = await f.receipt('leak');
  assert.equal(run.stdout.includes('sample-only'), false, run.stdout);
  assert.equal(JSON.stringify(receipt).includes('sample-only'), false);
  assert.deepEqual(receipt.turn.error, {
    message: 'authentication failed: [redacted:labeled-kv]',
    data: { note: 'api_token=[redacted:labeled-kv]' },
  });
  assert.match(
    await readFile(receipt.files.diagnostics, 'utf8'),
    /Bearer sample-only/,
  );
});

test('a retried Codex error stays out of the receipt and a final one is kept', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run('retried', 'RETRY').status, 0);
  const retried = await f.receipt('retried');
  assert.equal(retried.status, 'completed');
  assert.equal(retried.stop.code, 'completed');
  assert.equal(retried.error, null);
  assert.match(
    await readFile(retried.files.progress, 'utf8'),
    /Codex retrying: transient stream retry/,
  );
  assert.equal(f.run('final', 'RETRY FINAL_ERROR FAIL').status, 1);
  const final = await f.receipt('final');
  assert.equal(final.stop.kind, 'error');
  assert.equal(final.error.message, 'final stream failure');
});

test('only sign-out evidence stops a failed Codex turn as not-signed-in', async (t) => {
  const f = await fixture(t);
  for (const [name, prompt, variable, info, code] of [
    [
      'unauthorized',
      'FAIL',
      'FAKE_TURN_ERROR_INFO',
      '"unauthorized"',
      'not-signed-in',
    ],
    [
      'http-401',
      'FAIL',
      'FAKE_TURN_ERROR_INFO',
      '{"httpConnectionFailed":{"httpStatusCode":401}}',
      'not-signed-in',
    ],
    [
      'notified',
      'FINAL_ERROR FAIL',
      'FAKE_FINAL_ERROR_INFO',
      '"unauthorized"',
      'not-signed-in',
    ],
    [
      'http-500',
      'FAIL',
      'FAKE_TURN_ERROR_INFO',
      '{"httpConnectionFailed":{"httpStatusCode":500}}',
      'failed',
    ],
  ] as const) {
    assert.equal(f.run(name, prompt, [], { [variable]: info }).status, 1);
    const receipt = await f.receipt(name);
    assert.equal(receipt.stop.kind, 'error', name);
    assert.equal(receipt.stop.code, code, name);
  }
});

test('every Codex server request gets an unattended answer that the receipt records', async (t) => {
  const f = await fixture(t);
  const declined = { result: { decision: 'decline' } };
  const aborted = { result: { decision: 'abort' } };
  const refused = (code: number, message: string) => ({
    error: { code, message },
  });
  const expected = [
    ['item/commandExecution/requestApproval', declined],
    ['item/fileChange/requestApproval', declined],
    [
      'mcpServer/elicitation/request',
      { result: { action: 'decline', content: null, _meta: null } },
    ],
    [
      'item/tool/requestUserInput',
      refused(-32001, 'Nobody is watching this worker to answer.'),
    ],
    [
      'item/permissions/requestApproval',
      { result: { permissions: {}, scope: 'turn', strictAutoReview: true } },
    ],
    ['item/tool/call', { result: { contentItems: [], success: false } }],
    ['applyPatchApproval', aborted],
    ['execCommandApproval', aborted],
    [
      'account/chatgptAuthTokens/refresh',
      refused(-32001, 'pstack cannot refresh app-server auth tokens'),
    ],
    [
      'attestation/generate',
      refused(-32001, 'pstack did not negotiate attestation'),
    ],
    [
      'item/unknown/request',
      refused(
        -32000,
        'pstack rejected unrecognized blocking request item/unknown/request',
      ),
    ],
  ] as const;
  const result = f.run('asked', 'ASK', [], {
    FAKE_SERVER_REQUESTS: JSON.stringify(expected.map(([method]) => method)),
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('asked');
  assert.deepEqual(
    receipt.clientRequests,
    expected.map(([method, answer]) => ({ method, answer })),
  );
  const replies = (await f.events())
    .filter((event) => String(event.request?.id).startsWith('ask-'))
    .map(({ request: { id, ...answer } }) => [id, answer]);
  assert.deepEqual(
    replies,
    expected.map(([, answer], index) => [`ask-${index}`, answer]),
  );
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
    f.run('resumed', 'Continue that worker.', ['--resume', first.threadId])
      .status,
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
  assert.equal(resume.request.params.excludeTurns, true);
  assert.equal(Object.hasOwn(resume.request.params, 'threadSource'), false);
  assert.equal(
    events.some(
      (event) =>
        event.pid === resume.pid && event.request?.method === 'thread/start',
    ),
    false,
  );
});

test('a resume that opens no thread or another thread is not continuable', async (t) => {
  const f = await fixture(t);
  for (const [name, variable, code, message] of [
    [
      'missing',
      'FAKE_NO_ROLLOUT',
      'missing-session',
      /no rollout found for thread id thread-saved$/,
    ],
    [
      'other',
      'FAKE_RESUME_OTHER',
      'failed',
      /resumed thread-other instead of thread-saved/,
    ],
  ] as const) {
    const result = f.run(name, 'Continue.', ['--resume', 'thread-saved'], {
      [variable]: '1',
    });
    assert.equal(result.status, 1, name);
    const receipt = await f.receipt(name);
    assert.equal(receipt.threadId, null, name);
    assert.equal(receipt.rolloutPath, null, name);
    assert.equal(receipt.stop.kind, 'error', name);
    assert.equal(receipt.stop.code, code, name);
    assert.equal(receipt.stop.continuable, false, name);
    assert.match(receipt.error.message, message, name);
    const methods = (await f.events())
      .filter((entry) => entry.pid === receipt.process.pid && entry.request)
      .map((entry) => entry.request.method);
    assert.equal(methods.includes('turn/start'), false, name);
  }
});

for (const { prompt, signal, turnKnown, startPending, reply, outcome } of [
  {
    prompt: 'WAIT',
    signal: 'SIGTERM',
    turnKnown: true,
    startPending: false,
    reply: {},
    outcome: 'acknowledged',
  },
  {
    prompt: 'GONE WAIT',
    signal: 'SIGTERM',
    turnKnown: true,
    startPending: false,
    reply: { FAKE_INTERRUPT_NOT_RUNNING: '1' },
    outcome: 'not-running',
  },
  {
    prompt: 'EARLY WAIT',
    signal: 'SIGINT',
    turnKnown: true,
    startPending: true,
    reply: { FAKE_IGNORE_INTERRUPT: '1' },
    outcome: 'timed-out',
  },
  {
    prompt: 'NO_ID WAIT',
    signal: 'SIGINT',
    turnKnown: false,
    startPending: true,
    reply: {},
    outcome: null,
  },
] as const)
  test(`signal cancels the active turn and closes its process for ${prompt}`, async (t) => {
    const f = await fixture(t),
      child = f.start('cancelled', {
        ...reply,
        FAKE_HOLD_TURN_STARTED: turnKnown ? '' : '1',
        FAKE_HOLD_TURN_RESPONSE: startPending ? '1' : '',
      });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(prompt);
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    const deadline = Date.now() + 10_000;
    let startRequestId: number | undefined;
    while (true) {
      startRequestId = (await f.events().catch(() => [])).find(
        (event) => event.request?.method === 'turn/start',
      )?.request.id;
      const diagnostics = await readFile(
        path.join(f.root, 'cancelled/diagnostics.jsonl'),
        'utf8',
      ).catch(() => '');
      const received = diagnostics
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.direction === 'receive')
        .map((event) => JSON.parse(event.line));
      if (
        startRequestId !== undefined &&
        (!turnKnown ||
          received.some((message) =>
            startPending
              ? message.method === 'turn/started'
              : message.id === startRequestId,
          ))
      )
        break;
      assert(Date.now() < deadline, stderr);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill(signal);
    assert.equal(await exited, signal === 'SIGINT' ? 130 : 143, stderr);
    const receipt = await f.receipt('cancelled');
    assert.equal(receipt.status, 'interrupted');
    assert.deepEqual(receipt.stop, {
      kind: 'interrupted',
      code: 'signal',
      cause: signal,
      continuable: receipt.threadId !== null,
    });
    assertClosedByClient(receipt.process);
    const diagnostics = (await readFile(receipt.files.diagnostics, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      diagnostics.some(
        (event) =>
          event.direction === 'receive' &&
          JSON.parse(event.line).id === startRequestId,
      ),
      !startPending,
    );
    const events = await f.events(),
      interrupts = events.filter(
        (event) => event.request?.method === 'turn/interrupt',
      );
    assert.equal(interrupts.length, turnKnown ? 1 : 0);
    assert.equal(receipt.interrupt?.outcome ?? null, outcome);
    if (turnKnown) {
      assert.equal(receipt.interrupt.turnId, receipt.turnId);
      assert.equal(receipt.turnId, `turn-${receipt.process.pid}`);
      assert.equal(interrupts[0].request.params.threadId, receipt.threadId);
      assert.equal(interrupts[0].request.params.turnId, receipt.turnId);
      assert.equal(interrupts[0].pid, receipt.process.pid);
    } else assert.equal(receipt.turnId, null);
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

test('denied reviews are recorded and an exact approval precedes the resumed turn', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run('denied', 'DENY the synthetic action.').status, 0);
  const denied = await f.receipt('denied');
  assert.deepEqual(
    denied.deniedReviews.map((review: { reviewId: string }) => review.reviewId),
    ['review-denied'],
  );
  assert.equal(denied.stop.kind, 'permission');
  assert.equal(denied.approvedReview, null);
  const result = f.run('approved', 'Retry the approved action.', [
    '--resume',
    denied.threadId,
    '--approve-review',
    'review-denied',
    '--review-receipt',
    denied.files.result,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const approved = await f.receipt('approved');
  assert.equal(approved.status, 'completed');
  assert.equal(approved.threadId, denied.threadId);
  assert.equal(approved.approvedReview, 'review-denied');
  const event = {
    id: 'review-denied',
    target_item_id: 'call-review-denied',
    turn_id: denied.turnId,
    started_at_ms: 1,
    completed_at_ms: 2,
    status: 'denied',
    risk_level: 'high',
    user_authorization: 'low',
    rationale: 'synthetic denied',
    decision_source: 'agent',
    action: {
      type: 'mcp_tool_call',
      server: 'cua_repl',
      tool_name: 'js',
      connector_id: 'node_repl',
      connector_name: 'Node REPL',
      tool_title: 'Read app state',
    },
  };
  const request = JSON.parse(await readFile(approved.files.request, 'utf8'));
  assert.deepEqual(request.approvedReview, {
    reviewId: 'review-denied',
    receipt: denied.files.result,
    event,
  });
  const methods = (await f.events())
    .filter((entry) => entry.pid === approved.process.pid && entry.request)
    .map((entry) => entry.request.method);
  assert.deepEqual(methods.slice(-3), [
    'thread/resume',
    'thread/approveGuardianDeniedAction',
    'turn/start',
  ]);
  const approval = (await f.events()).find(
    (entry) => entry.request?.method === 'thread/approveGuardianDeniedAction',
  );
  assert.deepEqual(approval.request.params, {
    threadId: denied.threadId,
    event,
  });
});

test('approval conversion covers every supported action and refuses unsupported or mismatched reviews', async (t) => {
  const f = await fixture(t);
  const receipt = path.join(f.root, 'prior result.json');
  const review = (reviewId: string, action: Record<string, unknown>) => ({
    threadId: 'thread-prior',
    turnId: 'turn-prior',
    startedAtMs: 3,
    completedAtMs: 4,
    reviewId,
    targetItemId: null,
    decisionSource: 'agent',
    review: {
      status: 'denied',
      riskLevel: 'medium',
      userAuthorization: 'unknown',
      rationale: null,
    },
    action,
  });
  const converted = [
    [
      'network',
      {
        type: 'networkAccess',
        target: 'socks5://example.invalid:1080',
        host: 'example.invalid',
        protocol: 'socks5Tcp',
        port: 1080,
      },
      {
        type: 'network_access',
        target: 'socks5://example.invalid:1080',
        host: 'example.invalid',
        protocol: 'socks5_tcp',
        port: 1080,
      },
    ],
    [
      'command',
      {
        type: 'command',
        source: 'unifiedExec',
        command: 'rm -rf build',
        cwd: '/tmp',
      },
      {
        type: 'command',
        source: 'unified_exec',
        command: 'rm -rf build',
        cwd: '/tmp',
      },
    ],
    [
      'execve',
      {
        type: 'execve',
        source: 'shell',
        program: '/bin/rm',
        argv: ['rm', '-rf', 'build'],
        cwd: '/tmp',
      },
      {
        type: 'execve',
        source: 'shell',
        program: '/bin/rm',
        argv: ['rm', '-rf', 'build'],
        cwd: '/tmp',
      },
    ],
    [
      'patch',
      { type: 'applyPatch', cwd: '/tmp', files: ['/tmp/a.ts'] },
      { type: 'apply_patch', cwd: '/tmp', files: ['/tmp/a.ts'] },
    ],
  ] as const;
  await writeFile(
    receipt,
    JSON.stringify({
      threadId: 'thread-prior',
      deniedReviews: [
        ...converted.map(([reviewId, action]) => review(reviewId, action)),
        review('stdin', {
          type: 'writeStdin',
          approvalId: 'a',
          processId: 'p',
          stdin: 'y\n',
          cwd: '/tmp',
        }),
      ],
    }),
  );
  const approve = (name: string, extra: string[]) =>
    f.run(name, 'Retry.', extra);
  const exact = (reviewId: string) => [
    '--resume',
    'thread-prior',
    '--approve-review',
    reviewId,
    '--review-receipt',
    receipt,
  ];
  for (const [reviewId, , action] of converted) {
    assert.equal(approve(reviewId, exact(reviewId)).status, 0, reviewId);
    const request = JSON.parse(
      await readFile(path.join(f.root, reviewId, 'request.json'), 'utf8'),
    );
    assert.deepEqual(request.approvedReview.event.action, action);
    assert.equal(request.approvedReview.event.rationale, null);
    assert.equal(
      Object.hasOwn(request.approvedReview.event, 'target_item_id'),
      false,
    );
  }
  for (const [name, extra, message] of [
    [
      'stdin',
      [
        '--resume',
        'thread-prior',
        '--approve-review',
        'stdin',
        '--review-receipt',
        receipt,
      ],
      /denied writeStdin action is unsupported/,
    ],
    [
      'missing',
      [
        '--resume',
        'thread-prior',
        '--approve-review',
        'absent',
        '--review-receipt',
        receipt,
      ],
      /no denied review absent/,
    ],
    [
      'thread',
      [
        '--resume',
        'thread-other',
        '--approve-review',
        'network',
        '--review-receipt',
        receipt,
      ],
      /different thread/,
    ],
    [
      'no-resume',
      ['--approve-review', 'network', '--review-receipt', receipt],
      /requires --resume/,
    ],
    [
      'no-receipt',
      ['--resume', 'thread-prior', '--approve-review', 'network'],
      /--review-receipt go together/,
    ],
  ] as const) {
    const result = approve(name, [...extra]);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, message, name);
    await assert.rejects(readFile(path.join(f.root, name, 'request.json')));
  }
  const rejected = f.run('rejected', 'Retry.', exact('network'), {
    FAKE_REJECT_APPROVAL: '1',
  });
  assert.equal(rejected.status, 1);
  const failed = await f.receipt('rejected');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error.message, /approval rejected/);
  const methods = (await f.events())
    .filter((entry) => entry.pid === failed.process.pid && entry.request)
    .map((entry) => entry.request.method);
  assert.equal(methods.includes('turn/start'), false);
});

for (const [method, variable] of [
  ['initialize', 'FAKE_HOLD_INITIALIZE'],
  ['thread/start', 'FAKE_HOLD_THREAD'],
] as const)
  test(`signal closes the owned server while ${method} is pending`, async (t) => {
    const f = await fixture(t);
    const child = f.start('startup-cancelled', { [variable]: '1' });
    child.stdin.end('Synthetic startup cancellation.');
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    const deadline = Date.now() + 10_000;
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

test('the Claude launch template passes only options the Codex runner accepts', async () => {
  const plugin = path.join(project, 'plugin-claude');
  const reference = await readFile(
    path.join(plugin, 'skills/poteto-mode/references/execution.md'),
    'utf8',
  );
  const template = reference
    .split('\n')
    .find((line) => line.includes('run-codex.mjs\\" run'));
  assert.ok(template, 'execution reference shows a Codex launch template');
  const help = spawnSync(
    process.execPath,
    [path.join(plugin, 'skills/poteto-mode/scripts/run-codex.mjs'), '--help'],
    { encoding: 'utf8' },
  ).stdout;
  const accepted = new Set(help.match(/--[a-z-]+/g));
  for (const flag of template.match(/--[a-z-]+/g) ?? [])
    assert.ok(accepted.has(flag), `runner accepts ${flag}`);
});

test('explicit sandbox selection is recorded and read-only is refused', async (t) => {
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
    f.run('read-only-access', 'Synthetic task.', ['--sandbox', 'read-only'])
      .status,
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
  assert.equal(request.sandbox, 'workspace-write');
  const events = await f.events();
  const start = events.find(
    (event) => event.request?.method === 'thread/start',
  );
  const turn = events.find((event) => event.request?.method === 'turn/start');
  assert.equal(start.request.params.sandbox, 'workspace-write');
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

test('Codex auth remains unknown until explicit account evidence and survives catalog failure', async (t) => {
  const f = await fixture(t);
  const cases: {
    env: Record<string, string>;
    loggedIn: boolean | null;
    verified: boolean;
  }[] = [
    {
      env: { FAKE_INSPECT_CASE: 'initialize-error' },
      loggedIn: null,
      verified: false,
    },
    {
      env: { FAKE_INSPECT_CASE: 'account-error' },
      loggedIn: null,
      verified: false,
    },
    ...[
      null,
      {},
      { account: null },
      { requiresOpenaiAuth: true },
      { account: { type: 7 }, requiresOpenaiAuth: true },
    ].map((account) => ({
      env: { FAKE_ACCOUNT_JSON: JSON.stringify(account) },
      loggedIn: null,
      verified: false,
    })),
    { env: { FAKE_NO_AUTH: '1' }, loggedIn: false, verified: false },
    {
      env: {
        FAKE_ACCOUNT_JSON: JSON.stringify({
          account: null,
          requiresOpenaiAuth: false,
        }),
      },
      loggedIn: true,
      verified: false,
    },
    {
      env: { FAKE_INSPECT_CASE: 'catalog-error' },
      loggedIn: true,
      verified: true,
    },
    {
      env: { FAKE_INSPECT_CASE: 'catalog-error', FAKE_NO_AUTH: '1' },
      loggedIn: false,
      verified: false,
    },
  ];
  for (const entry of cases) {
    const result = spawnSync(
      process.execPath,
      [f.runner, 'catalog', '--cwd', f.cwd, '--executable', f.executable],
      { env: { ...f.env, ...entry.env }, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const detected = JSON.parse(result.stdout);
    assert.equal(
      detected.auth.loggedIn,
      entry.loggedIn,
      JSON.stringify(entry.env),
    );
    assert.equal(detected.auth.verified, entry.verified);
    if (entry.env.FAKE_INSPECT_CASE === 'catalog-error') {
      assert.match(detected.error, /catalog unavailable/);
      assert.equal(detected.auth.error, null);
    }
  }
});
