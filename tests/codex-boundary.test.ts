import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(
  new URL(
    '../plugin/skills/poteto-mode/scripts/codex-boundary.mjs',
    import.meta.url,
  ),
);
const source = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const log = (request) => fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(request)+'\n');
const send = (request,result) => console.log(JSON.stringify({id:request.id,result}));
const lines = readline.createInterface({input:process.stdin});
const key = 'pstack-codex@pstack-codex:hooks/hooks.json:pre_tool_use:0:0';
const hash = 'sha256:'+('a'.repeat(64))+'/sha256:'+('b'.repeat(64));
lines.on('line',(line)=>{
 const request=JSON.parse(line); log(request);
 const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));
 switch(request.method) {
 case 'initialize': send(request,{}); break;
 case 'initialized': break;
 case 'configRequirements/read': send(request,{requirements:process.env.FIXTURE_FAILURE==='managed-disabled'?{feature_requirements:{hooks:false}}:{}}); break;
 case 'config/read': send(request,{config:{features:{hooks:process.env.FIXTURE_FAILURE!=='user-disabled'},hooks:{state}}}); break;
 case 'experimentalFeature/list': send(request,{data:[{name:'hooks',enabled:process.env.FIXTURE_FAILURE!=='feature-disabled'}],nextCursor:null}); break;
 case 'hooks/list': {
  if(process.env.FIXTURE_FAILURE==='missing-api'){console.log(JSON.stringify({id:request.id,error:{code:-32601,message:'hooks/list unavailable'}}));break;}
  const trust=state[key]?.trusted_hash;
  const trusted=trust===hash;
  const hook={key,eventName:'preToolUse',handlerType:'command',command:'node '+JSON.stringify(process.env.FIXTURE_GUARD),async:false,matcher:'^Bash$',timeoutSec:5,sourcePath:process.env.FIXTURE_ROOT+'/hooks/hooks.json',source:'plugin',pluginId:'pstack-codex@pstack-codex',enabled:trusted,trustStatus:trusted?'trusted':trust?'modified':'untrusted',currentHash:hash};
  if(process.env.FIXTURE_FAILURE==='wrong-path')hook.command='node "/other/shell-boundary.mjs"';
  if(process.env.FIXTURE_FAILURE==='disabled-hook' && trusted)hook.enabled=false;
  if(process.env.FIXTURE_FAILURE==='wrong-hash' && trusted)hook.currentHash='sha256:'+('c'.repeat(64));
  const hooks=process.env.FIXTURE_FAILURE==='missing-hook'?[]:[hook];
  if(process.env.FIXTURE_FAILURE==='conflict')hooks.push({key:'other',eventName:'preToolUse',handlerType:'command',command:'rewrite-command',enabled:true,matcher:'Bash'});
  send(request,{data:[{cwd:process.cwd(),hooks,warnings:[],errors:[]}]}); break;
 }
 case 'config/batchWrite': {
  const edit=request.params.edits[0];
  const owned=JSON.parse(edit.keyPath.slice('hooks.state.'.length,-'.trusted_hash'.length));
  state[owned]={...(state[owned]??{}),trusted_hash:edit.value};
  fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));
  send(request,{});break;
 }
 default: console.log(JSON.stringify({id:request.id,error:{code:-32601,message:'unexpected '+request.method}}));
 }
});
lines.on('close',()=>process.exit(0));
`;

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack-native-boundary-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = path.join(root, 'shell-boundary.mjs');
  const executable = path.join(root, 'fake codex');
  const state = path.join(root, 'state.json');
  const log = path.join(root, 'rpc.jsonl');
  const shim = path.join(root, 'platform.mjs');
  await writeFile(
    guard,
    `let text=''; for await(const chunk of process.stdin) text+=chunk; const input=JSON.parse(text); process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'CODEX_SANDBOX seatbelt exit 125 PSTACK_REVIEW_REQUIRED\\n'+input.tool_input.command}}}));`,
  );
  await writeFile(
    executable,
    source.replace('#!/usr/bin/env node', '#!' + process.execPath),
    { mode: 0o755 },
  );
  await writeFile(
    state,
    JSON.stringify({
      unrelated: { trusted_hash: 'preserved', disabled: true },
    }),
  );
  await writeFile(
    shim,
    "Object.defineProperty(process,'platform',{value:process.env.FIXTURE_PLATFORM ?? 'darwin'});",
  );
  const invoke = (command: string, failure?: string, extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        shim,
        helper,
        command,
        '--cwd',
        root,
        '--plugin-id',
        'pstack-codex@pstack-codex',
        '--guard',
        guard,
        '--executable',
        executable,
        ...extra,
      ],
      {
        env: {
          ...process.env,
          FIXTURE_ROOT: root,
          FIXTURE_GUARD: guard,
          FIXTURE_STATE: state,
          FIXTURE_LOG: log,
          ...(failure ? { FIXTURE_FAILURE: failure } : {}),
          ...(failure === 'missing-node' ? { PATH: root } : {}),
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
  const events = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { root, guard, executable, state, log, shim, invoke, events };
}

test('native inspection reports exact untrusted identity without writing, then trust changes only its hash and confirms readback', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.state, 'utf8');
  const inspected = f.invoke('inspect');
  assert.equal(inspected.status, 1, inspected.stderr);
  const info = JSON.parse(inspected.stdout);
  assert.equal(info.status, 'untrusted');
  assert.equal(info.hook.pluginId, 'pstack-codex@pstack-codex');
  assert.equal(await readFile(f.state, 'utf8'), before);
  const result = f.invoke('trust');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'active');
  assert.equal(receipt.hook.trustStatus, 'trusted');
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.deepEqual(state.unrelated, {
    trusted_hash: 'preserved',
    disabled: true,
  });
  assert.deepEqual(
    Object.keys(state).sort(),
    ['unrelated', receipt.hook.key].sort(),
  );
  assert.equal(state[receipt.hook.key].trusted_hash, receipt.hook.currentHash);
  const events = await f.events();
  const writes = events.filter((event) => event.method === 'config/batchWrite');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params.edits, [
    {
      keyPath:
        'hooks.state.' + JSON.stringify(receipt.hook.key) + '.trusted_hash',
      value: receipt.hook.currentHash,
      mergeStrategy: 'replace',
    },
  ]);
  assert(
    events
      .slice(events.indexOf(writes[0]) + 1)
      .some((event) => event.method === 'hooks/list'),
  );
  assert(
    !events.some(
      (event) =>
        event.method?.startsWith('thread/') ||
        event.method?.startsWith('turn/') ||
        event.method?.startsWith('account/'),
    ),
  );
});

test('native update can re-trust only the changed owned hook', async (t) => {
  const f = await fixture(t);
  const key = 'pstack-codex@pstack-codex:hooks/hooks.json:pre_tool_use:0:0';
  await writeFile(
    f.state,
    JSON.stringify({
      unrelated: { trusted_hash: 'preserved' },
      [key]: { trusted_hash: 'old-hash', disabled: false },
    }),
  );
  assert.equal(
    JSON.parse(f.invoke('inspect').stdout).hook.trustStatus,
    'modified',
  );
  const result = f.invoke('trust');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(state[key].disabled, false);
  assert.equal(state.unrelated.trusted_hash, 'preserved');
});

for (const failure of [
  'managed-disabled',
  'user-disabled',
  'feature-disabled',
  'missing-api',
  'missing-hook',
  'wrong-path',
  'conflict',
])
  test(`native setup rejects ${failure} before any trust write`, async (t) => {
    const f = await fixture(t);
    const before = await readFile(f.state, 'utf8');
    const result = f.invoke('trust', failure);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert.equal(await readFile(f.state, 'utf8'), before);
    assert(
      !(await f.events()).some((event) => event.method === 'config/batchWrite'),
    );
  });

for (const failure of ['wrong-hash', 'disabled-hook'])
  test(`native setup does not report active after ${failure} readback`, async (t) => {
    const f = await fixture(t);
    const result = f.invoke('trust', failure);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert(
      (await f.events()).some((event) => event.method === 'config/batchWrite'),
    );
  });

test('non-macOS native helper does not launch Codex', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      f.shim,
      helper,
      'trust',
      '--cwd',
      f.root,
      '--plugin-id',
      'pstack-codex@pstack-codex',
      '--guard',
      f.guard,
      '--executable',
      f.executable,
    ],
    { env: { ...process.env, FIXTURE_PLATFORM: 'linux' }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'notApplicable');
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('worker CLI overrides are valid TOML for spaces, quotes, Unicode, arrays and exact hook keys', async () => {
  const script = `import {boundaryConfigArgs} from ${JSON.stringify('file://' + helper)}; console.log(JSON.stringify(boundaryConfigArgs({'hooks.PreToolUse':[{matcher:'^Bash$',hooks:[{command:'node \"/tmp/한 글\"',timeout:5}]}],'hooks.state':{'/<session-flags>/config.toml:pre_tool_use:0:0':{trusted_hash:'sha256:abc',disabled:false}}})));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout);
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import sys,json,tomllib; print(json.dumps([tomllib.loads(v) for v in sys.argv[1:]]))',
      ...args.filter((value: string) => value !== '-c'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  const values = JSON.parse(parsed.stdout);
  assert.equal(
    values[0].hooks.PreToolUse[0].hooks[0].command,
    'node "/tmp/한 글"',
  );
  assert.equal(
    values[1].hooks.state['/<session-flags>/config.toml:pre_tool_use:0:0']
      .disabled,
    false,
  );
});

test('native user-disabled trust state remains an error without writes', async (t) => {
  const f = await fixture(t);
  const key = 'pstack-codex@pstack-codex:hooks/hooks.json:pre_tool_use:0:0';
  await writeFile(
    f.state,
    JSON.stringify({
      [key]: { disabled: true },
      unrelated: { trusted_hash: 'preserve' },
    }),
  );
  const before = await readFile(f.state, 'utf8');
  const result = f.invoke('trust');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'disabled-hook');
  assert.equal(await readFile(f.state, 'utf8'), before);
  assert(
    !(await f.events()).some((event) => event.method === 'config/batchWrite'),
  );
});

test('native handler must resolve Node in its receiving PATH before trust', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.state, 'utf8');
  const result = f.invoke('trust', 'missing-node');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'guard-self-test');
  assert.equal(await readFile(f.state, 'utf8'), before);
  assert(
    !(await f.events()).some((event) => event.method === 'config/batchWrite'),
  );
});
