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
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const log = (event) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({pid:process.pid,cwd:process.cwd(),...event})+'\n');
const rawArgs = process.argv.slice(2);
const overrides = {};
for (let i=0; i<rawArgs.length; i++) {
 if (rawArgs[i] !== '-c') continue;
 const parsed = spawnSync('python3',['-c','import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.argv[1])))',rawArgs[++i]],{encoding:'utf8'});
 if (parsed.status !== 0) { console.error(parsed.stderr); process.exit(4); }
 const merge = (target, source) => { for (const [key,value] of Object.entries(source)) { if (value && typeof value==='object' && !Array.isArray(value)) merge(target[key] ??= {},value); else target[key] = value; } };
 merge(overrides,JSON.parse(parsed.stdout));
}
const args = rawArgs.filter((_,i)=>rawArgs[i] !== '-c' && rawArgs[i-1] !== '-c');
log({args:rawArgs,overrides,worker:process.env.PSTACK_CODEX_WORKER ?? null});
const readUser=()=>JSON.parse(fs.readFileSync(process.env.FAKE_USER_CONFIG,'utf8'));
const userHooks=()=>{
 const user=readUser().config;
 return user.hooks.PreToolUse.flatMap((row,i)=>row.hooks.map((handler,j)=>{
  const sourcePath=process.env.CODEX_HOME+'/config.toml',key=sourcePath+':pre_tool_use:'+i+':'+j;
  const currentHash='sha256:'+createHash('sha256').update(JSON.stringify({row,handler})).digest('hex');
  const state=user.hooks.state[key]??{};
  const trustStatus=state.trusted_hash===currentHash?'trusted':state.trusted_hash?'modified':'untrusted';
  return {key,eventName:'preToolUse',handlerType:handler.type,command:handler.command,async:handler.async??false,matcher:row.matcher,timeoutSec:handler.timeout??600,sourcePath,source:'user',pluginId:null,currentHash,trustStatus,enabled:state.enabled!==false&&trustStatus==='trusted'};
 }));
};
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
 if (!request.method) return;
 const p = request.params;
 switch (request.method) {
 case 'initialize': if (!process.env.FAKE_HOLD_INITIALIZE) respond(request,{userAgent:'fixture'}); break;
 case 'initialized': break;
 case 'account/read': respond(request,process.env.FAKE_NO_AUTH ? {account:null,requiresOpenaiAuth:true} : {account:{type:'chatgpt',email:'private@example.invalid'},requiresOpenaiAuth:true}); break;
 case 'config/read': {
  const user=readUser(),config={...user.config,model_provider:'openai',model_providers:{fixture:{api_key:'fixture-private-config'}},features:{hooks:process.env.FAKE_BOUNDARY!=='user-disabled'}};
  respond(request,{config,layers:p.includeLayers ? [{name:{type:'user',file:process.env.CODEX_HOME+'/config.toml'},version:'v'+user.version,config:user.config}] : null}); break;
 }
 case 'config/batchWrite': {
  const user=readUser();
  if(p.filePath!==process.env.CODEX_HOME+'/config.toml'||p.expectedVersion!=='v'+user.version){send({id:request.id,error:{code:-32001,message:'missing or stale user-layer CAS'}});break;}
  for(const edit of p.edits){
   if(edit.keyPath==='hooks.PreToolUse'){user.config.hooks.PreToolUse=edit.value;continue;}
   const match=/^hooks\.state\.("(?:[^"\\]|\\.)*")\.(trusted_hash|enabled)$/.exec(edit.keyPath);
   if(!match)throw new Error('unexpected configuration edit');
   const key=JSON.parse(match[1]);user.config.hooks.state[key]={...user.config.hooks.state[key],[match[2]]:edit.value};
  }
  user.version++;fs.writeFileSync(process.env.FAKE_USER_CONFIG,JSON.stringify(user));respond(request,{});break;
 }
 case 'configRequirements/read': respond(request,{requirements:process.env.FAKE_BOUNDARY === 'managed-disabled' ? {feature_requirements:{hooks:false}} : {}}); break;
 case 'experimentalFeature/list': respond(request,{data:[{name:'hooks',enabled:(overrides.features?.hooks??readUser().config.features.hooks)===true && process.env.FAKE_BOUNDARY!=='disabled-feature'}],nextCursor:null}); break;
 case 'hooks/list': {
  if (process.env.FAKE_HOLD_HOOKS) break;
  if (process.env.FAKE_BOUNDARY==='missing-api') {send({id:request.id,error:{code:-32601,message:'hooks/list unavailable'}});break;}
  const rows = overrides.hooks?.PreToolUse ?? [];
  const effectiveState={...readUser().config.hooks.state,...(overrides.hooks?.state??{})};
  const owned = rows.flatMap((row,i)=>(row.hooks ?? []).map((handler,j)=>({key:'/<session-flags>/config.toml:pre_tool_use:'+i+':'+j,eventName:'preToolUse',handlerType:'command',command:handler.command,async:false,matcher:row.matcher,timeoutSec:handler.timeout,sourcePath:'/<session-flags>/config.toml',source:'sessionFlags',pluginId:null,currentHash:'sha256:'+('a'.repeat(64)),enabled:true,trustStatus:'untrusted'})));
  for (const h of owned) {
   h.trustStatus=effectiveState[h.key]?.trusted_hash===h.currentHash ? 'trusted' : 'untrusted';
   if (overrides.hooks?.state && h.matcher==='^Bash$') {
    if (process.env.FAKE_BOUNDARY==='wrong-hash') h.currentHash='sha256:'+('b'.repeat(64));
    if (process.env.FAKE_BOUNDARY==='untrusted') h.trustStatus='untrusted';
    if (process.env.FAKE_BOUNDARY==='disabled-hook') h.enabled=false;
    if (process.env.FAKE_BOUNDARY==='wrong-handler') h.command='other-command';
   }
  }
  for (const h of owned.filter(h=>h.matcher==='^Bash$')) {
    if(process.env.FAKE_BOUNDARY==='wrong-matcher')h.matcher='.*';
    if(process.env.FAKE_BOUNDARY==='wrong-source')h.source='project';
    if(process.env.FAKE_BOUNDARY==='wrong-timeout')h.timeoutSec=0;
  }
  if (process.env.FAKE_BOUNDARY==='missing-hook') owned.length=0;
  owned.push(...userHooks());
  if (process.env.FAKE_BOUNDARY==='conflict') owned.push({key:'competing',eventName:'preToolUse',handlerType:'command',command:'different-hook',matcher:'.*',enabled:true});
  if (process.env.FAKE_DUPLICATE_GUARD) owned.push({key:'duplicate',eventName:'preToolUse',handlerType:'command',command:'node '+JSON.stringify(process.env.FAKE_DUPLICATE_GUARD),matcher:'^Bash$',async:false,timeoutSec:5,enabled:true,pluginId:'pstack-codex@pstack-codex'});
  log({effectiveReadHookCount:owned.filter((h)=>h.matcher==='^Read$').length,effectiveUnrelatedTrust:effectiveState.unrelated?.trusted_hash});
  respond(request,{data:[{cwd:process.cwd(),hooks:owned,warnings:[],errors:[]}]}); break;
 }
 case 'model/list': respond(request,p.cursor ? {data:[{id:'second-model',model:'second-model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null} : {data:[{id:'selected-model',model:'selected-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'xhigh'}]}],nextCursor:'second-page'}); break;
 case 'thread/start': case 'thread/resume':
  if (process.env.FAKE_HOLD_THREAD) break;
  if (process.env.FAKE_MANAGED_REJECTION) {
   send({id:request.id,error:{code:-32000,message:'managed policy rejects auto-review'}}); break;
  }
  if (process.env.FAKE_MUTATE_SOURCE) {
   const target=process.env.FAKE_SOURCE_PATH;
   if(process.env.FAKE_MUTATE_SOURCE==='replace')fs.writeFileSync(target,'throw new Error("replacement source must not run");');
   else fs.rmSync(target,{recursive:true,force:true});
   log({sourceMutation:process.env.FAKE_MUTATE_SOURCE,target});
  }
  threadId = p.threadId ?? 'thread-'+process.pid;
  const policy = {
   approvalPolicy:p.approvalPolicy,
   approvalsReviewer:p.approvalsReviewer ?? 'auto_review',
   sandbox:{type:{'read-only':'readOnly','workspace-write':'workspaceWrite','danger-full-access':'dangerFullAccess'}[p.sandbox],networkAccess:false}
  };
  const altered = process.env.FAKE_POLICY_FIELDS;
  if (altered === 'missing-all') for (const key of Object.keys(policy)) delete policy[key];
  if (altered === 'missing-approval') delete policy.approvalPolicy;
  if (altered === 'missing-reviewer') delete policy.approvalsReviewer;
  if (altered === 'missing-sandbox') delete policy.sandbox;
  if (altered === 'wrong-approval') policy.approvalPolicy = 'never';
  if (altered === 'wrong-reviewer') policy.approvalsReviewer = 'user';
  if (altered === 'wrong-sandbox') policy.sandbox = {type:'dangerFullAccess'};
  if (process.env.FAKE_SERVER_REQUEST) send({id:request.id,method:'item/commandExecution/requestApproval',params:{threadId,command:'synthetic unsupported command'}});
  respond(request,{thread:{id:threadId},model:'observed-model',reasoningEffort:'high',cwd:p.cwd,...policy}); break;
 case 'turn/start': {
  turnId = 'turn-'+process.pid;
  const prompt = p.input[0].text;
  if (process.env.FAKE_RUN_GATED_SHELL) {
   const command='printf original-body';
   const input=JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command}});
   const handler=overrides.hooks.PreToolUse[0].hooks[0];
   for(const hook of userHooks().filter(h=>h.enabled&&new RegExp(h.matcher).test('Bash'))){
    const native=spawnSync('/bin/sh',['-c',hook.command],{input,encoding:'utf8',env:process.env});
    log({nativeHookExecution:{status:native.status,stdout:native.stdout,stderr:native.stderr}});
   }
   const executed=spawnSync('/bin/sh',['-c',handler.command],{input,encoding:'utf8',env:process.env});
   let output;try{output=JSON.parse(executed.stdout);}catch{}
   const wrapped=output?.hookSpecificOutput?.updatedInput?.command;
   log({hookExecution:{status:executed.status,stdout:executed.stdout,stderr:executed.stderr}});
   if(typeof wrapped!=='string') {send({id:request.id,error:{code:-32000,message:'prepared hook failed to rewrite'}});break;}
   const sandboxed=spawnSync('/bin/sh',['-c',wrapped],{encoding:'utf8',env:{...process.env,CODEX_SANDBOX:'seatbelt'}});
   const reviewedEnv={...process.env};delete reviewedEnv.CODEX_SANDBOX;
   const reviewed=spawnSync('/bin/sh',['-c',wrapped],{encoding:'utf8',env:reviewedEnv});
   log({shellExecution:{sandboxed:{status:sandboxed.status,stdout:sandboxed.stdout,stderr:sandboxed.stderr},reviewed:{status:reviewed.status,stdout:reviewed.stdout,stderr:reviewed.stderr}}});
  }
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
  const guard = path.join(
    plugin,
    'skills/poteto-mode/scripts/shell-boundary.mjs',
  );
  await mkdir(path.dirname(runner), { recursive: true });
  await cp(
    path.join(
      project,
      'plugin-claude/skills/poteto-mode/scripts/run-codex.mjs',
    ),
    runner,
  );
  await cp(
    path.join(project, 'plugin/skills/poteto-mode/scripts/codex-boundary.mjs'),
    path.join(path.dirname(runner), 'codex-boundary.mjs'),
  );
  await cp(
    path.join(project, 'plugin/skills/poteto-mode/scripts/shell-boundary.mjs'),
    guard,
  );
  const platformShim = path.join(root, 'platform.mjs');
  await writeFile(
    platformShim,
    "Object.defineProperty(process,'platform',{value:process.env.FAKE_PLATFORM ?? 'darwin'});",
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
  const codexHome = path.join(root, 'isolated-codex-home');
  const userConfig = path.join(root, 'user-config.json');
  await mkdir(codexHome);
  await writeFile(
    userConfig,
    JSON.stringify({
      version: 1,
      config: {
        features: { hooks: true },
        hooks: {
          PreToolUse: [
            {
              matcher: '^Read$',
              hooks: [
                {
                  type: 'command',
                  command: 'unrelated-reader fixture-private-hook',
                },
              ],
            },
          ],
          state: { unrelated: { trusted_hash: 'preserve-me', enabled: true } },
        },
      },
    }),
  );
  const env = {
    ...process.env,
    FAKE_LOG: log,
    CODEX_HOME: codexHome,
    FAKE_USER_CONFIG: userConfig,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(platformShim).href}`,
    ]
      .filter(Boolean)
      .join(' '),
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
    '--import',
    platformShim,
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
    guard,
    codexHome,
    userConfig,
    root,
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
  const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
  assert.equal(request.approvalMode, 'auto-review');
  assert.deepEqual(receipt.executionPolicy, {
    requested: { approvalMode: 'auto-review', sandbox: 'read-only' },
    observed: {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'readOnly', networkAccess: false },
    },
  });
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
  const resume = (await f.events()).find(
    (event) => event.request?.method === 'thread/resume',
  );
  assert.equal(resume.request.params.threadId, first.threadId);
  assert.equal(resume.request.params.cwd, f.cwd);
  assert.equal(resume.request.params.sandbox, 'workspace-write');
  assert.equal(resume.request.params.approvalPolicy, 'on-request');
  assert.equal(resume.request.params.approvalsReviewer, 'auto_review');
  assert.deepEqual(resumed.executionPolicy, {
    requested: { approvalMode: 'auto-review', sandbox: 'workspace-write' },
    observed: {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: { type: 'workspaceWrite', networkAccess: false },
    },
  });
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

for (const approvalMode of [undefined, 'never'])
  test(`prompt files retain unknown model settings and ${approvalMode ?? 'default'} policy evidence without reusing run records`, async (t) => {
    const f = await fixture(t);
    const prompt = path.join(f.root, 'prompt file.txt');
    await writeFile(prompt, 'Read this synthetic prompt file.\n');
    const result = spawnSync(
      process.execPath,
      f.args('prompt-file', [
        '--prompt-file',
        prompt,
        ...(approvalMode ? ['--approval-mode', approvalMode] : []),
      ]),
      {
        env: {
          ...f.env,
          FAKE_UNKNOWN_SETTINGS: '1',
          FAKE_PLATFORM: approvalMode === 'never' ? 'linux' : 'darwin',
          ...(approvalMode === 'never'
            ? { FAKE_POLICY_FIELDS: 'missing-all' }
            : {}),
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = await f.receipt('prompt-file');
    assert.deepEqual(receipt.observed, { model: null, effort: null });
    assert.deepEqual(receipt.executionPolicy, {
      requested: {
        approvalMode: approvalMode ?? 'auto-review',
        sandbox: 'read-only',
      },
      observed:
        approvalMode === 'never'
          ? { approvalPolicy: null, approvalsReviewer: null, sandbox: null }
          : {
              approvalPolicy: 'on-request',
              approvalsReviewer: 'auto_review',
              sandbox: { type: 'readOnly', networkAccess: false },
            },
    });
    assert.deepEqual(receipt.threadSettings, {
      model: 'observed-model',
      effort: 'high',
    });
    const before = await readFile(receipt.files.result, 'utf8');
    assert.equal(f.run('prompt-file').status, 1);
    assert.equal(await readFile(receipt.files.result, 'utf8'), before);
    const events = await f.events();
    const start = events.find(
      (event) => event.request?.method === 'thread/start',
    );
    assert.equal(
      start.request.params.approvalPolicy,
      approvalMode === 'never' ? 'never' : 'on-request',
    );
    if (approvalMode === 'never')
      assert(!('approvalsReviewer' in start.request.params));
    else assert.equal(start.request.params.approvalsReviewer, 'auto_review');
    const turn = events.find((event) => event.request?.method === 'turn/start');
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
    f.run(
      'explicit-access',
      'Synthetic authorized access.',
      ['--sandbox', 'danger-full-access', '--approval-mode', 'never'],
      { FAKE_PLATFORM: 'linux' },
    ).status,
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

for (const sandbox of ['read-only', 'workspace-write'])
  test(`default auto-review confirms ${sandbox} policy before both start and exact resume`, async (t) => {
    const f = await fixture(t);
    const extra = sandbox === 'read-only' ? [] : ['--write'];
    const first = f.run('review-start', 'Synthetic reviewed task.', extra);
    assert.equal(first.status, 0, first.stderr);
    const started = await f.receipt('review-start');
    const resumedRun = f.run('review-resume', 'Synthetic continuation.', [
      ...extra,
      '--resume',
      started.threadId,
    ]);
    assert.equal(resumedRun.status, 0, resumedRun.stderr);
    const resumed = await f.receipt('review-resume');
    assert.equal(resumed.threadId, started.threadId);
    const observed = {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: {
        type: sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
        networkAccess: false,
      },
    };
    for (const receipt of [started, resumed]) {
      const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
      assert.equal(request.approvalMode, 'auto-review');
      assert.deepEqual(receipt.executionPolicy, {
        requested: { approvalMode: 'auto-review', sandbox },
        observed,
      });
      assert.equal(receipt.status, 'completed');
    }
    const events = await f.events();
    for (const method of ['thread/start', 'thread/resume']) {
      const event = events.find((event) => event.request?.method === method);
      assert.equal(event.request.params.approvalPolicy, 'on-request');
      assert.equal(event.request.params.approvalsReviewer, 'auto_review');
      assert.equal(event.request.params.sandbox, sandbox);
    }
    assert.equal(
      events.filter((event) => event.request?.method === 'turn/start').length,
      2,
    );
    const explicitResume = f.run(
      'explicit-resume',
      'Continue with an explicit reviewed policy.',
      [
        '--resume',
        started.threadId,
        '--approval-mode',
        'auto-review',
        '--sandbox',
        sandbox,
      ],
    );
    assert.equal(explicitResume.status, 0, explicitResume.stderr);
    const explicitReceipt = await f.receipt('explicit-resume');
    assert.equal(explicitReceipt.threadId, started.threadId);
    assert.deepEqual(explicitReceipt.executionPolicy, {
      requested: { approvalMode: 'auto-review', sandbox },
      observed,
    });
    const resumes = (await f.events()).filter(
      (event) => event.request?.method === 'thread/resume',
    );
    assert.equal(resumes.at(-1).request.params.approvalPolicy, 'on-request');
    assert.equal(
      resumes.at(-1).request.params.approvalsReviewer,
      'auto_review',
    );
  });

test('approval mode validation rejects unknown modes and unrestricted auto-review before launch', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    ['--approval-mode', 'invented'],
    ['--sandbox', 'danger-full-access'],
    ['--approval-mode', 'auto-review', '--sandbox', 'danger-full-access'],
  ]) {
    const result = f.run('invalid-policy', 'Synthetic task.', extra);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /approval-mode|auto-review/i);
  }
  assert.deepEqual(await f.events().catch(() => []), []);
});

for (const altered of [
  'missing-all',
  'missing-approval',
  'missing-reviewer',
  'missing-sandbox',
  'wrong-approval',
  'wrong-reviewer',
  'wrong-sandbox',
])
  for (const resumed of [false, true])
    test(`default auto-review rejects ${altered} on ${resumed ? 'resume' : 'start'} before task execution`, async (t) => {
      const f = await fixture(t);
      const result = f.run(
        'policy-mismatch',
        'Must never execute this task.',
        ['--write', ...(resumed ? ['--resume', 'exact-existing-thread'] : [])],
        { FAKE_POLICY_FIELDS: altered },
      );
      assert.equal(result.status, 1, result.stderr);
      const receipt = await f.receipt('policy-mismatch');
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.turnId, null);
      assert.equal(receipt.process.closed, true);
      assert.equal(receipt.error.code, 'APPROVAL_POLICY_MISMATCH');
      assert.deepEqual(receipt.executionPolicy.requested, {
        approvalMode: 'auto-review',
        sandbox: 'workspace-write',
      });
      const observed = receipt.executionPolicy.observed;
      assert(observed);
      assert.equal(
        observed.approvalPolicy,
        ['missing-all', 'missing-approval'].includes(altered)
          ? null
          : altered === 'wrong-approval'
            ? 'never'
            : 'on-request',
      );
      assert.equal(
        observed.approvalsReviewer,
        ['missing-all', 'missing-reviewer'].includes(altered)
          ? null
          : altered === 'wrong-reviewer'
            ? 'user'
            : 'auto_review',
      );
      assert.deepEqual(
        observed.sandbox,
        ['missing-all', 'missing-sandbox'].includes(altered)
          ? null
          : altered === 'wrong-sandbox'
            ? { type: 'dangerFullAccess' }
            : { type: 'workspaceWrite', networkAccess: false },
      );
      assert(
        !(await f.events()).some(
          (event) => event.request?.method === 'turn/start',
        ),
      );
      const diagnostics = await readFile(receipt.files.diagnostics, 'utf8');
      assert(diagnostics.includes('thread/' + (resumed ? 'resume' : 'start')));
    });

test('managed auto-review rejection keeps policy evidence and never starts a task', async (t) => {
  const f = await fixture(t);
  const result = f.run(
    'managed-rejection',
    'Must never execute this task.',
    ['--write'],
    { FAKE_MANAGED_REJECTION: '1' },
  );
  assert.equal(result.status, 1, result.stderr);
  const receipt = await f.receipt('managed-rejection');
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.executionPolicy, {
    requested: { approvalMode: 'auto-review', sandbox: 'workspace-write' },
    observed: null,
  });
  assert.match(receipt.error.message, /managed policy rejects auto-review/);
  assert.equal(receipt.error.data.code, -32000);
  assert(
    !(await f.events()).some((event) => event.request?.method === 'turn/start'),
  );
});

test('same numeric server request id is refused without consuming client response diagnostics', async (t) => {
  const f = await fixture(t);
  const result = f.run('collision', 'Synthetic task.', [], {
    FAKE_SERVER_REQUEST: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('collision');
  assert.deepEqual(receipt.threadSettings, {
    model: 'observed-model',
    effort: 'high',
  });
  const events = await f.events();
  const start = events.find(
    (event) => event.request?.method === 'thread/start',
  );
  const refusal = events.find((event) => event.request?.error?.code === -32601);
  assert.equal(refusal.request.id, start.request.id);
  assert.deepEqual(receipt.capabilityGaps, [
    {
      id: start.request.id,
      method: 'item/commandExecution/requestApproval',
      response: { error: refusal.request.error },
    },
  ]);
  assert(!('result' in refusal.request));
  assert.equal(receipt.executionPolicy.observed.approvalPolicy, 'on-request');
  assert.equal(
    receipt.executionPolicy.observed.approvalsReviewer,
    'auto_review',
  );
  const diagnostics = await readFile(receipt.files.diagnostics, 'utf8');
  assert(diagnostics.includes('synthetic unsupported command'));
});

test('macOS boundary is process scoped and active before a new or resumed task', async (t) => {
  const f = await fixture(t);
  for (const [name, extra] of [
    ['boundary-new', []],
    ['boundary-resumed', ['--resume', 'exact-existing-thread']],
  ] as const) {
    const result = f.run(name, 'Ordinary verification brief.', [...extra]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = await f.receipt(name);
    assert.equal(receipt.commandBoundary.status, 'active');
    assert.equal(receipt.commandBoundary.hook.trustStatus, 'trusted');
    const diagnostics = await readFile(receipt.files.diagnostics, 'utf8');
    assert(!diagnostics.includes('fixture-private-config'));
    assert(!diagnostics.includes('fixture-private-hook'));
    assert.equal(receipt.commandBoundary.requested.platform, 'darwin');
    const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
    assert.deepEqual(request.commandBoundary, receipt.commandBoundary);
  }
  const events = await f.events();
  const turns = events.filter(
    (event) => event.request?.method === 'turn/start',
  );
  assert.equal(turns.length, 2);
  for (const event of events.filter(
    (entry) => entry.effectiveReadHookCount !== undefined,
  )) {
    assert.equal(event.effectiveReadHookCount, 1);
    assert.equal(event.effectiveUnrelatedTrust, 'preserve-me');
  }
  for (const turn of turns) {
    const processEvents = events.filter((event) => event.pid === turn.pid);
    const spawn = processEvents.find((event) => event.args);
    assert.equal(spawn.worker, '1');
    assert.equal(spawn.overrides.features.hooks, true);
    assert.equal(spawn.overrides.hooks.PreToolUse.length, 1);
    assert.equal(spawn.overrides.hooks.PreToolUse[0].matcher, '^Bash$');
    assert.equal(spawn.overrides.hooks.state.unrelated, undefined);
    const key = '/<session-flags>/config.toml:pre_tool_use:0:0';
    assert.equal(
      spawn.overrides.hooks.state[key].trusted_hash,
      'sha256:' + 'a'.repeat(64),
    );
    assert.deepEqual(Object.keys(spawn.overrides.hooks.state).sort(), [key]);
    const gate = processEvents.findIndex(
      (event) => event.request?.method === 'hooks/list',
    );
    assert(gate >= 0 && gate < processEvents.indexOf(turn));
    const thread = processEvents.find((event) =>
      ['thread/start', 'thread/resume'].includes(event.request?.method),
    );
    assert.match(thread.request.params.developerInstructions, /darwin/);
    assert.match(
      thread.request.params.developerInstructions,
      /restricted sandbox/,
    );
    assert.match(
      thread.request.params.developerInstructions,
      /require_escalated/,
    );
  }
  assert(
    !(
      await readFile((await f.receipt('boundary-new')).files.prompt, 'utf8')
    ).includes('PSTACK_REVIEW_REQUIRED'),
  );
});

for (const mutation of ['delete', 'replace', 'remove-plugin'])
  for (const resume of [false, true])
    test(`prepared worker guard survives ${mutation} before a ${resume ? 'resumed' : 'new'} turn`, async (t) => {
      const f = await fixture(t);
      const result = f.run(
        'frozen-boundary',
        'Ordinary verification brief.',
        resume ? ['--resume', 'exact-existing-thread'] : [],
        {
          FAKE_MUTATE_SOURCE: mutation,
          FAKE_SOURCE_PATH:
            mutation === 'remove-plugin'
              ? path.resolve(f.runner, '../../../..')
              : f.guard,
          FAKE_RUN_GATED_SHELL: '1',
        },
      );
      const receipt = await f.receipt('frozen-boundary');
      assert.equal(result.status, 0, receipt.error?.message ?? result.stderr);
      assert.equal(receipt.commandBoundary.status, 'active');
      const events = await f.events();
      const mutationIndex = events.findIndex((event) => event.sourceMutation);
      const turnIndex = events.findIndex(
        (event) => event.request?.method === 'turn/start',
      );
      assert(mutationIndex >= 0 && mutationIndex < turnIndex);
      assert.equal(
        events.find((event) => event.hookExecution)?.hookExecution.status,
        0,
      );
      const executed = events.find(
        (event) => event.shellExecution,
      )?.shellExecution;
      assert.equal(executed?.sandboxed.status, 125);
      assert.equal(executed.sandboxed.stdout, '');
      assert.match(executed.sandboxed.stderr, /PSTACK_REVIEW_REQUIRED/);
      assert.equal(executed.reviewed.status, 0);
      assert.equal(executed.reviewed.stdout, 'original-body');
      assert.equal(receipt.requested.model, 'selected-model');
      assert.equal(receipt.requested.effort, 'xhigh');
      assert.equal(
        receipt.executionPolicy.observed.approvalsReviewer,
        'auto_review',
      );
    });

for (const state of [
  'missing-api',
  'managed-disabled',
  'user-disabled',
  'disabled-feature',
  'missing-hook',
  'wrong-hash',
  'untrusted',
  'disabled-hook',
  'wrong-handler',
  'wrong-matcher',
  'wrong-source',
  'wrong-timeout',
  'conflict',
])
  for (const resume of [false, true])
    test(`macOS boundary rejects ${state} before ${resume ? 'resumed' : 'new'} model execution`, async (t) => {
      const f = await fixture(t);
      const result = f.run(
        'boundary-failed',
        'Never run this task.',
        resume ? ['--resume', 'exact-thread'] : [],
        { FAKE_BOUNDARY: state },
      );
      assert.equal(result.status, 1, result.stderr);
      const receipt = await f.receipt('boundary-failed');
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.error.code, 'COMMAND_BOUNDARY_UNAVAILABLE');
      assert.equal(receipt.commandBoundary.status, 'failed');
      assert.equal(receipt.turnId, null);
      assert(
        !(await f.events()).some(
          (event) => event.request?.method === 'turn/start',
        ),
      );
      const request = JSON.parse(await readFile(receipt.files.request, 'utf8'));
      assert.deepEqual(request.commandBoundary, receipt.commandBoundary);
    });

test('non-macOS leaves existing execution and environment unchanged', async (t) => {
  const f = await fixture(t);
  const result = f.run('linux', 'Ordinary verification.', [], {
    FAKE_PLATFORM: 'linux',
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('linux');
  assert.equal(receipt.commandBoundary.status, 'notApplicable');
  const events = await f.events();
  assert(
    !events.some((event) =>
      [
        'hooks/list',
        'configRequirements/read',
        'experimentalFeature/list',
      ].includes(event.request?.method),
    ),
  );
  const worker = events.find((event) => event.args?.includes('app-server'));
  assert.equal(worker.worker, process.env.PSTACK_CODEX_WORKER ?? null);
  assert.deepEqual(worker.overrides, {});
});

test('macOS explicit never retains the boundary without granting escalation', async (t) => {
  const f = await fixture(t);
  const result = f.run('never-boundary', 'Noninteractive task.', [
    '--approval-mode',
    'never',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = await f.receipt('never-boundary');
  assert.equal(receipt.commandBoundary.status, 'active');
  const start = (await f.events()).find(
    (event) => event.request?.method === 'thread/start',
  );
  assert.equal(start.request.params.approvalPolicy, 'never');
  assert.match(start.request.params.developerInstructions, /never/);
});

test('an enabled mutable-file duplicate is rejected even when its bytes match', async (t) => {
  const f = await fixture(t);
  const duplicate = path.join(f.root, 'shell-boundary.mjs');
  await cp(f.guard, duplicate);
  assert.equal(
    f.run('duplicate-bad', 'Task.', [], { FAKE_DUPLICATE_GUARD: duplicate })
      .status,
    1,
  );
  assert.equal(
    (await f.receipt('duplicate-bad')).commandBoundary.reason,
    'conflicting-hook',
  );
  assert(
    !(await f.events()).some((event) => event.request?.method === 'turn/start'),
  );
});

test('owned native generations return no rewrite beside each external new or resumed turn', async (t) => {
  const f = await fixture(t);
  const helper = await import(
    pathToFileURL(
      path.join(
        project,
        'plugin/skills/poteto-mode/scripts/codex-boundary.mjs',
      ),
    ).href
  );
  const native = await helper.trustNativeBoundary({
    cwd: f.cwd,
    codexHome: f.codexHome,
    guardPath: f.guard,
    executable: f.executable,
    env: f.env,
    platform: 'darwin',
    nativeRoles: ['poteto-agent'],
  });
  assert.equal(native.status, 'active');
  for (const resume of [false, true]) {
    const result = f.run(
      resume ? 'native-resumed' : 'native-new',
      'Ordinary verification.',
      resume ? ['--resume', 'exact-existing-thread'] : [],
      { FAKE_RUN_GATED_SHELL: '1' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const events = await f.events();
  const nativeRuns = events.filter((event) => event.nativeHookExecution);
  assert.equal(nativeRuns.length, 2);
  for (const event of nativeRuns) {
    assert.equal(event.nativeHookExecution.status, 0);
    assert.deepEqual(JSON.parse(event.nativeHookExecution.stdout), {});
  }
  const externalRuns = events.filter((entry) => entry.hookExecution);
  assert.equal(externalRuns.length, 2);
  for (const event of externalRuns) {
    const output = JSON.parse(event.hookExecution.stdout);
    assert.equal(
      output.hookSpecificOutput.updatedInput.command.split(
        'PSTACK_REVIEW_REQUIRED',
      ).length - 1,
      1,
    );
  }
  const shellRuns = events.filter((entry) => entry.shellExecution);
  assert.equal(shellRuns.length, 2);
  for (const event of shellRuns) {
    assert.equal(event.shellExecution.sandboxed.status, 125);
    assert.equal(event.shellExecution.sandboxed.stdout, '');
    assert.equal(event.shellExecution.reviewed.stdout, 'original-body');
  }
});

test('a native command without owned generation facts is rejected before a turn', async (t) => {
  const f = await fixture(t);
  const helper = await import(
    pathToFileURL(
      path.join(
        project,
        'plugin/skills/poteto-mode/scripts/codex-boundary.mjs',
      ),
    ).href
  );
  await helper.trustNativeBoundary({
    cwd: f.cwd,
    codexHome: f.codexHome,
    guardPath: f.guard,
    executable: f.executable,
    env: f.env,
    platform: 'darwin',
    nativeRoles: ['poteto-agent'],
  });
  await rm(path.join(f.codexHome, 'pstack-codex/native-command-boundary'), {
    recursive: true,
  });
  const result = f.run('unowned-native');
  assert.equal(result.status, 1);
  assert.equal(
    (await f.receipt('unowned-native')).commandBoundary.reason,
    'conflicting-hook',
  );
  assert(
    !(await f.events()).some((event) => event.request?.method === 'turn/start'),
  );
});

test('cancellation during boundary preflight closes its process without starting a turn', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, f.args('boundary-cancelled'), {
    env: { ...f.env, FAKE_HOLD_HOOKS: '1' },
  });
  child.stdin.end('Synthetic cancellation.');
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', resolve),
  );
  const deadline = Date.now() + 5000;
  while (
    !(await f.events().catch(() => [])).some(
      (event) => event.request?.method === 'hooks/list',
    )
  ) {
    assert(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  const receipt = await f.receipt('boundary-cancelled');
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.turnId, null);
  const events = await f.events();
  assert(!events.some((event) => event.request?.method === 'turn/start'));
  for (const event of events.filter((event) =>
    event.args?.includes('app-server'),
  ))
    assert.throws(() => process.kill(event.pid, 0), /ESRCH/);
});

test('macOS never rejects unrestricted or unconfirmed execution without a model turn', async (t) => {
  const f = await fixture(t);
  for (const [name, extra, env] of [
    [
      'unrestricted-never',
      ['--sandbox', 'danger-full-access', '--approval-mode', 'never'],
      {},
    ],
    [
      'unconfirmed-never',
      ['--approval-mode', 'never'],
      { FAKE_POLICY_FIELDS: 'missing-all' },
    ],
    [
      'substituted-never',
      ['--approval-mode', 'never'],
      { FAKE_POLICY_FIELDS: 'wrong-sandbox' },
    ],
  ] as const) {
    assert.equal(f.run(name, 'Never execute this.', [...extra], env).status, 1);
    const receipt = await f.receipt(name);
    assert.equal(receipt.error.code, 'COMMAND_BOUNDARY_UNAVAILABLE');
    assert.equal(receipt.commandBoundary.status, 'failed');
  }
  assert(
    !(await f.events()).some((event) => event.request?.method === 'turn/start'),
  );
});

for (const failure of ['missing', 'syntax', 'malformed', 'unwrapped'])
  test(`guard self-test rejects ${failure} before model execution`, async (t) => {
    const f = await fixture(t);
    if (failure === 'missing') await rm(f.guard);
    else
      await writeFile(
        f.guard,
        failure === 'syntax'
          ? 'bad syntax !'
          : failure === 'malformed'
            ? 'export async function runShellBoundary(){process.stdout.write("bad output");}'
            : 'export async function runShellBoundary(){process.stdout.write("{}");}',
      );
    const result = f.run('guard-failed');
    assert.equal(result.status, 1, result.stderr);
    const receipt = await f.receipt('guard-failed');
    assert.equal(receipt.error.code, 'COMMAND_BOUNDARY_UNAVAILABLE');
    assert.equal(receipt.commandBoundary.status, 'failed');
    assert(
      !(await f.events().catch(() => [])).some(
        (event) => event.request?.method === 'turn/start',
      ),
    );
  });
