import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = await import(
  pathToFileURL(
    path.join(root, 'plugin/skills/poteto-mode/scripts/codex-boundary.mjs'),
  ).href
);
const canonicalGuard = path.join(
  root,
  'plugin/skills/poteto-mode/scripts/shell-boundary.mjs',
);
const program = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const read=()=>JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));
const save=s=>fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(s));
const digest=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sourcePath=path.join(process.env.CODEX_HOME,'config.toml');
const snapshot=process.argv[2]==='--snapshot';
const overrides=snapshot?JSON.parse(process.argv[3]):JSON.parse(execFileSync('python3',['-c','import sys,json,tomllib; r={}; [r.update(tomllib.loads(v)) for v in sys.argv[1:]]; print(json.dumps(r))',...process.argv.slice(2).filter((v,i,a)=>a[i-1]==='-c')],{encoding:'utf8'}));
function rows(s){
 const all=[];
 for(const [source,groups,file] of [['user',s.user.hooks.PreToolUse,sourcePath],['project',s.projectHooks,'/project/config.toml'],['sessionFlags',overrides.hooks?.PreToolUse??[], '/<session-flags>/config.toml']])
 for(const [g,group] of groups.entries())for(const [h,handler] of group.hooks.entries()){
  const key=file+':pre_tool_use:'+g+':'+h,currentHash=digest({group,handler});
  const state=source==='sessionFlags'?overrides.hooks?.state?.[key]??{}:s.user.hooks.state[key]??{};
  const trustStatus=state.trusted_hash===currentHash?'trusted':state.trusted_hash?'modified':'untrusted';
  all.push({key,eventName:'preToolUse',handlerType:handler.type,command:handler.command,async:handler.async??false,matcher:group.matcher,timeoutSec:handler.timeout??600,sourcePath:file,source,pluginId:null,enabled:state.enabled!==false&&trustStatus==='trusted',trustStatus,currentHash});
 }
 return all;
}
function response(method,params,s){
 switch(method){
 case 'initialize':return {};
 case 'configRequirements/read':return {requirements:s.failure==='managed-disabled'?{feature_requirements:{hooks:false}}:{}};
 case 'config/read':return {config:{features:{hooks:s.failure!=='user-disabled'},hooks:{PreToolUse:[...s.user.hooks.PreToolUse,...s.projectHooks],state:s.user.hooks.state}},layers:[{name:{type:'user',file:sourcePath},version:'v'+s.version,config:s.user},{name:{type:'project',file:'/project/config.toml'},version:'project-version',config:{hooks:{PreToolUse:s.projectHooks}}}]};
 case 'experimentalFeature/list':return {data:[{name:'hooks',enabled:s.failure!=='feature-disabled'}],nextCursor:null};
 case 'hooks/list':if(s.failure==='missing-api')throw new Error('hooks/list unavailable');return {data:[{cwd:process.cwd(),hooks:rows(s),warnings:[],errors:[]}]};
 case 'config/batchWrite':{
  const appending=params.edits.some(e=>e.keyPath==='hooks.PreToolUse');
  if(s.failure==='cas-conflict'){
   s.user.foreignConcurrent='preserve';s.version++;save(s);throw new Error('version conflict');
  }
  if(params.filePath!==sourcePath||params.expectedVersion!=='v'+s.version)throw new Error('missing or stale user-layer CAS');
  const metadata=path.join(process.env.CODEX_HOME,'pstack-codex/native-command-boundary');
  if(appending&&!fs.readdirSync(metadata).length)throw new Error('append requires persisted intent');
  const stage=appending?'append':'trust';
  if(s.failure===stage+'-before')throw new Error(stage+' interrupted before write');
  for(const e of params.edits){
   if(e.keyPath==='hooks.PreToolUse'){s.user.hooks.PreToolUse=e.value;continue;}
   const m=/^hooks\.state\.("(?:[^"\\]|\\.)*")\.(trusted_hash|enabled)$/.exec(e.keyPath);
   if(!m)throw new Error('unexpected write '+e.keyPath);
   const key=JSON.parse(m[1]);s.user.hooks.state[key]={...s.user.hooks.state[key],[m[2]]:e.value};
  }
  s.version++;save(s);
  if(s.failure==='metadata-after-trust'&&!appending)fs.chmodSync(metadata,0o500);
  if(s.failure===stage+'-after')throw new Error(stage+' interrupted after write');
  return {};
 }
 default:throw new Error('unexpected '+method);
 }
}
if(snapshot){console.log(JSON.stringify(response(process.argv[4],JSON.parse(process.argv[5]),read())));process.exit(0);}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(r)+'\n');
 if(r.method==='initialized')return;
 try{console.log(JSON.stringify({id:r.id,result:response(r.method,r.params,read())}));}
 catch(e){console.log(JSON.stringify({id:r.id,error:{code:-32001,message:e.message}}));}
});
lines.on('close',()=>process.exit(0));
`;

async function fixture(t: TestContext) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'pstack-frozen-boundary-')),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const setup = spawnSync(
    process.execPath,
    [
      path.join(root, 'plugin/skills/setup-pstack/scripts/register-agents.mjs'),
      '--definitions-only',
      '--codex-home',
      home,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const registration = JSON.parse(
    await readFile(
      path.join(home, 'pstack-codex/agent-registration.json'),
      'utf8',
    ),
  );
  const roles = [
    ...registration.config.block.matchAll(/^\[agents\.([A-Za-z0-9_-]+)\]$/gm),
  ].map((m) => m[1]);
  const guardPath = path.join(dir, 'package', 'shell-boundary.mjs');
  await mkdir(path.dirname(guardPath));
  await writeFile(guardPath, await readFile(canonicalGuard));
  const executable = path.join(dir, 'fake codex');
  await writeFile(
    executable,
    program.replace('#!/usr/bin/env node', '#!' + process.execPath),
    { mode: 0o755 },
  );
  const statePath = path.join(dir, 'state.json');
  const log = path.join(dir, 'rpc.jsonl');
  const state = {
    version: 1,
    failure: '',
    user: {
      features: { hooks: true },
      foreignText: 'preserve\u2028line\u2029paragraph',
      foreignConcurrent: '',
      hooks: {
        PreToolUse: [] as unknown[],
        state: {
          foreign: { trusted_hash: 'opaque-foreign', enabled: false },
        } as Record<string, Record<string, unknown>>,
      },
    },
    projectHooks: [
      {
        matcher: '^Read$',
        hooks: [
          { type: 'command', command: 'secret-project-command', timeout: 5 },
        ],
      },
    ],
  };
  await writeFile(statePath, JSON.stringify(state));
  const env = {
    ...process.env,
    CODEX_HOME: home,
    FIXTURE_STATE: statePath,
    FIXTURE_LOG: log,
  };
  const options = {
    cwd: dir,
    codexHome: home,
    executable,
    guardPath,
    pluginId: 'pstack-codex@pstack-codex',
    env,
    nativeRoles: roles,
    platform: 'darwin',
  };
  const read = async () =>
    JSON.parse(await readFile(statePath, 'utf8')) as typeof state;
  const change = async (mutate: (s: typeof state) => void) => {
    const s = await read();
    mutate(s);
    await writeFile(statePath, JSON.stringify(s));
  };
  const events = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((x) => JSON.parse(x));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  };
  const client = (overrides: unknown) => ({
    request: async (method: string, params: unknown) => {
      const result = spawnSync(
        executable,
        [
          '--snapshot',
          JSON.stringify(overrides),
          method,
          JSON.stringify(params),
        ],
        { cwd: dir, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
  });
  const command = async (index = -1) => {
    const groups = (await read()).user.hooks.PreToolUse as {
      hooks: { command: string }[];
    }[];
    return groups.at(index)!.hooks[0]!.command;
  };
  return {
    dir,
    home,
    options,
    read,
    change,
    events,
    client,
    command,
    guardPath,
    env,
    log,
  };
}

function invoke(
  command: string,
  agentType?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync('/bin/sh', ['-c', command], {
    env,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: "cat <<'EOF'\n$literal `bytes`\nEOF",
        description: 'preserve',
      },
      ...(agentType ? { agent_type: agentType } : {}),
    }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function isBoundaryError(reason?: string) {
  return (error: unknown) => {
    const e = error as { code?: string; commandBoundary?: { reason?: string } };
    assert.equal(e.code, 'COMMAND_BOUNDARY_UNAVAILABLE');
    if (reason) assert.equal(e.commandBoundary?.reason, reason);
    return true;
  };
}

test('native setup appends and trusts only a user-layer frozen binding with exact CAS, then repeated setup writes nothing', async (t) => {
  const f = await fixture(t);
  const receipt = await helper.trustNativeBoundary(f.options);
  assert.equal(receipt.status, 'active');
  assert.equal(receipt.activation, 'fresh-root-session-required');
  const state = await f.read();
  assert.equal(state.user.hooks.PreToolUse.length, 1);
  assert.equal(state.projectHooks.length, 1);
  assert.equal(state.user.foreignText, 'preserve\u2028line\u2029paragraph');
  assert.deepEqual(state.user.hooks.state.foreign, {
    trusted_hash: 'opaque-foreign',
    enabled: false,
  });
  const writes = (await f.events()).filter(
    (e) => e.method === 'config/batchWrite',
  );
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map((e) => e.params.expectedVersion),
    ['v1', 'v2'],
  );
  assert(
    writes.every((e) => e.params.filePath === path.join(f.home, 'config.toml')),
  );
  assert.equal(writes[0].params.edits[0].value.length, 1);
  assert(
    (await f.events())
      .filter((e) => e.method === 'config/read')
      .every((e) => e.params.includeLayers === true),
  );
  await helper.trustNativeBoundary(f.options);
  assert.equal(
    (await f.events()).filter((e) => e.method === 'config/batchWrite').length,
    2,
  );
  const inspected = await helper.inspectNativeBoundary({
    ...f.options,
    nativeRoles: undefined,
  });
  assert.equal(inspected.status, 'active');
  assert(!JSON.stringify(inspected).includes('secret-project-command'));
  assert(!JSON.stringify(inspected).includes('foreignText'));
});

test('native scope freezes actual setup roles, survives package deletion and ignores damaged registration bookkeeping', async (t) => {
  const f = await fixture(t);
  await helper.trustNativeBoundary(f.options);
  const command = await f.command();
  assert(!command.includes(f.guardPath));
  assert(
    command.startsWith(
      "'" + process.execPath + "' --input-type=module --eval ",
    ),
  );
  await rm(path.dirname(f.guardPath), { recursive: true });
  await writeFile(
    path.join(f.home, 'pstack-codex/agent-registration.json'),
    '{damaged',
  );
  for (const role of f.options.nativeRoles) {
    const output = invoke(command, role, f.env).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'allow');
    assert.equal(output.updatedInput.description, 'preserve');
    assert(
      output.updatedInput.command.endsWith(
        "cat <<'EOF'\n$literal `bytes`\nEOF",
      ),
    );
    const stopped = spawnSync('/bin/sh', ['-c', output.updatedInput.command], {
      env: { ...f.env, CODEX_SANDBOX: 'seatbelt' },
      encoding: 'utf8',
    });
    assert.equal(stopped.status, 125);
  }
  for (const role of ['default', 'other', 'poteto-agent-copy'])
    assert.deepEqual(invoke(command, role, f.env), {});
  assert.deepEqual(invoke(command, undefined, f.env), {});
  assert.deepEqual(
    invoke(command, f.options.nativeRoles[0], {
      ...f.env,
      PSTACK_CODEX_WORKER: '1',
    }),
    {},
  );
});

test('unchanged program and roles keep the same inline identity through unrelated package and config changes', async (t) => {
  const f = await fixture(t);
  const first = await helper.trustNativeBoundary(f.options);
  const command = await f.command();
  await writeFile(
    path.join(path.dirname(f.guardPath), 'README.md'),
    'same-version package replacement',
  );
  await f.change((s) => {
    s.user.foreignText = 'changed outside owned hook';
    s.version++;
  });
  const second = await helper.trustNativeBoundary(f.options);
  assert.equal(await f.command(), command);
  assert.equal(second.hook.key, first.hook.key);
  assert.equal(second.hook.currentHash, first.hook.currentHash);
  assert.equal((await f.read()).user.hooks.PreToolUse.length, 1);
});

test('changed frozen source appends a generation while retaining all old bodies and trust, and both gates compose', async (t) => {
  const f = await fixture(t);
  const first = await helper.trustNativeBoundary(f.options);
  const oldCommand = await f.command();
  await writeFile(
    f.guardPath,
    (await readFile(f.guardPath, 'utf8')) +
      '\n// A distinct reviewed generation.\n',
  );
  const second = await helper.trustNativeBoundary(f.options);
  assert.notEqual(second.hook.key, first.hook.key);
  assert.equal(await f.command(0), oldCommand);
  assert.equal(
    (await f.read()).user.hooks.state[first.hook.key]!.trusted_hash,
    first.hook.currentHash,
  );
  const one = invoke(oldCommand, f.options.nativeRoles[0], f.env)
    .hookSpecificOutput.updatedInput.command;
  const next = spawnSync('/bin/sh', ['-c', await f.command()], {
    env: f.env,
    input: JSON.stringify({
      tool_name: 'Bash',
      agent_type: f.options.nativeRoles[0],
      tool_input: { command: one },
    }),
    encoding: 'utf8',
  });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(
    JSON.parse(next.stdout).hookSpecificOutput.updatedInput.command,
    one,
  );
});

for (const stage of [
  'append-before',
  'append-after',
  'trust-before',
  'trust-after',
])
  test(`native setup recovers after ${stage} without duplicating or adopting unknown entries`, async (t) => {
    const f = await fixture(t);
    await f.change((s) => {
      s.failure = stage;
    });
    await assert.rejects(
      helper.trustNativeBoundary(f.options),
      isBoundaryError(),
    );
    await f.change((s) => {
      s.failure = '';
    });
    const receipt = await helper.trustNativeBoundary(f.options);
    assert.equal(receipt.status, 'active');
    assert.equal((await f.read()).user.hooks.PreToolUse.length, 1);
  });

test('installed metadata interruption repairs from persisted intent and exact trusted slot', async (t) => {
  const f = await fixture(t);
  await f.change((s) => {
    s.failure = 'metadata-after-trust';
  });
  await assert.rejects(
    helper.trustNativeBoundary(f.options),
    isBoundaryError(),
  );
  const metadata = path.join(f.home, 'pstack-codex/native-command-boundary');
  const { chmod } = await import('node:fs/promises');
  await chmod(metadata, 0o700);
  await f.change((s) => {
    s.failure = '';
  });
  assert.equal((await helper.trustNativeBoundary(f.options)).status, 'active');
  assert.equal((await f.read()).user.hooks.PreToolUse.length, 1);
});

test('fresh inspection is read only and reports a missing native binding', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  assert.equal(
    (await helper.inspectNativeBoundary(f.options)).status,
    'missing',
  );
  assert.deepEqual(await f.read(), before);
  assert.equal(
    (await f.events()).filter((e) => e.method === 'config/batchWrite').length,
    0,
  );
  await assert.rejects(
    readFile(path.join(f.home, 'pstack-codex/native-command-boundary')),
    { code: 'ENOENT' },
  );
});

test('foreign CAS conflicts cannot overwrite concurrent state or promote project hooks into the user layer', async (t) => {
  const f = await fixture(t);
  await f.change((s) => {
    s.failure = 'cas-conflict';
  });
  await assert.rejects(
    helper.trustNativeBoundary(f.options),
    isBoundaryError(),
  );
  assert.equal((await f.read()).user.foreignConcurrent, 'preserve');
  assert.equal((await f.read()).user.hooks.PreToolUse.length, 0);
  await f.change((s) => {
    s.failure = '';
  });
  assert.equal((await helper.trustNativeBoundary(f.options)).status, 'active');
});

for (const action of ['disable', 'remove', 'shift', 'modify'])
  test(`native setup respects a user ${action} of an installed binding`, async (t) => {
    const f = await fixture(t);
    const receipt = await helper.trustNativeBoundary(f.options);
    await f.change((s) => {
      if (action === 'disable')
        s.user.hooks.state[receipt.hook.key]!.enabled = false;
      if (action === 'remove') s.user.hooks.PreToolUse = [];
      if (action === 'shift')
        s.user.hooks.PreToolUse.unshift({
          matcher: '^Read$',
          hooks: [{ type: 'command', command: 'foreign-before', timeout: 5 }],
        });
      if (action === 'modify')
        (
          s.user.hooks.PreToolUse[0] as { hooks: { command: string }[] }
        ).hooks[0]!.command += ' changed-by-user';
      s.version++;
    });
    const before = await f.read();
    const writes = (await f.events()).filter(
      (e) => e.method === 'config/batchWrite',
    ).length;
    await assert.rejects(
      helper.trustNativeBoundary(f.options),
      isBoundaryError(),
    );
    assert.deepEqual(await f.read(), before);
    assert.equal(
      (await f.events()).filter((e) => e.method === 'config/batchWrite').length,
      writes,
    );
  });

test('native retirement disables observed owned keys without deleting bodies or reindexing foreign hooks, and explicit registration creates a new binding', async (t) => {
  const f = await fixture(t);
  const first = await helper.trustNativeBoundary(f.options);
  await f.change((s) => {
    s.user.hooks.PreToolUse.push({
      matcher: '^Read$',
      hooks: [{ type: 'command', command: 'foreign-tail', timeout: 5 }],
    });
    s.version++;
  });
  const before = await f.read();
  const retired = await helper.retireNativeBoundary({
    ...f.options,
    nativeRoles: undefined,
  });
  assert.equal(retired.status, 'retired');
  const state = await f.read();
  assert.deepEqual(state.user.hooks.PreToolUse, before.user.hooks.PreToolUse);
  assert.equal(state.user.hooks.state[first.hook.key]!.enabled, false);
  assert.equal(
    state.user.hooks.state[first.hook.key]!.trusted_hash,
    first.hook.currentHash,
  );
  assert.equal(
    Object.hasOwn(state.user.hooks.state[first.hook.key]!, 'disabled'),
    false,
  );
  assert.equal(
    (await helper.inspectNativeBoundary(f.options)).status,
    'retired',
  );
  const second = await helper.trustNativeBoundary(f.options);
  assert.equal(second.status, 'active');
  assert.notEqual(second.hook.key, first.hook.key);
  assert.equal((await f.read()).user.hooks.PreToolUse.length, 3);
});

test('equivalent commands without ownership metadata are never adopted or trusted', async (t) => {
  const f = await fixture(t);
  await helper.trustNativeBoundary(f.options);
  await rm(path.join(f.home, 'pstack-codex/native-command-boundary'), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    helper.trustNativeBoundary(f.options),
    isBoundaryError(),
  );
  assert.equal((await f.read()).user.hooks.PreToolUse.length, 1);
});

test('external preparation freezes the whole worker and accepts only owned native hooks which are noops under its marker', async (t) => {
  const f = await fixture(t);
  await helper.trustNativeBoundary(f.options);
  const native = await f.command();
  const prepared = await helper.prepareWorkerBoundary(f.options);
  assert.equal(prepared.commandBoundary.status, 'prepared');
  const command =
    prepared.configOverrides['hooks.PreToolUse'][0].hooks[0]!.command;
  assert(!command.includes(f.guardPath));
  await rm(path.dirname(f.guardPath), { recursive: true });
  const frozenEnv = { ...f.env, ...prepared.env };
  assert.deepEqual(invoke(native, f.options.nativeRoles[0], frozenEnv), {});
  assert(
    invoke(
      command,
      undefined,
      frozenEnv,
    ).hookSpecificOutput.updatedInput.command.includes(
      'PSTACK_REVIEW_REQUIRED',
    ),
  );
  await prepared.preTurnPreflight(f.client(prepared.configOverrides));
  assert.equal(prepared.commandBoundary.status, 'active');
  await f.change((s) => {
    const group = {
      matcher: '^Bash$',
      hooks: [
        { type: 'command', command: 'secret-foreign-rewriter', timeout: 5 },
      ],
    };
    s.user.hooks.PreToolUse.push(group);
    s.user.hooks.state[path.join(f.home, 'config.toml') + ':pre_tool_use:1:0'] =
      { trusted_hash: 'will-be-set' };
  });
  const snapshot = await f.client({}).request('hooks/list', { cwds: [f.dir] });
  const foreign = snapshot.data[0].hooks.find(
    (h: { command: string }) => h.command === 'secret-foreign-rewriter',
  );
  await f.change((s) => {
    s.user.hooks.state[foreign.key]!.trusted_hash = foreign.currentHash;
  });
  await assert.rejects(
    prepared.preTurnPreflight(f.client(prepared.configOverrides)),
    isBoundaryError('conflicting-hook'),
  );
  assert(
    !JSON.stringify(prepared.commandBoundary).includes(
      'secret-foreign-rewriter',
    ),
  );
});

for (const failure of [
  'managed-disabled',
  'user-disabled',
  'feature-disabled',
  'missing-api',
])
  test(`native setup rejects ${failure} before configuration changes`, async (t) => {
    const f = await fixture(t);
    await f.change((s) => {
      s.failure = failure;
    });
    await assert.rejects(
      helper.trustNativeBoundary(f.options),
      isBoundaryError(),
    );
    assert.equal(
      (await f.events()).filter((e) => e.method === 'config/batchWrite').length,
      0,
    );
  });

test('invalid native roles and an invalid Node interpreter fail before any config write', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    helper.trustNativeBoundary({ ...f.options, nativeRoles: ['invalid.role'] }),
    isBoundaryError(),
  );
  const badNode = path.join(f.dir, 'bad-node');
  await writeFile(badNode, '#!/bin/sh\nprintf old-node\n', { mode: 0o755 });
  await assert.rejects(
    helper.trustNativeBoundary({ ...f.options, nodeExecutable: badNode }),
    isBoundaryError(),
  );
  assert.equal(
    (await f.events()).filter((e) => e.method === 'config/batchWrite').length,
    0,
  );
});

test('cancelled preparation and non-macOS operations never launch configuration inspection', async (t) => {
  const f = await fixture(t);
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(helper.prepareWorkerBoundary({ ...f.options, signal }));
  for (const operation of [
    helper.trustNativeBoundary,
    helper.inspectNativeBoundary,
    helper.retireNativeBoundary,
  ])
    assert.equal(
      (await operation({ ...f.options, platform: 'linux' })).status,
      'notApplicable',
    );
  assert.equal(
    (await helper.prepareWorkerBoundary({ ...f.options, platform: 'linux' }))
      .commandBoundary.status,
    'notApplicable',
  );
  assert.equal((await f.events()).length, 0);
});

test('worker overrides remain valid TOML for shell quotes, Unicode and actual enabled fields', () => {
  const args = helper.boundaryConfigArgs({
    'hooks.PreToolUse': [
      {
        matcher: '^Bash$',
        hooks: [{ command: 'node "/tmp/한 글"', timeout: 5 }],
      },
    ],
    'hooks.state': {
      '/<session-flags>/config.toml:pre_tool_use:0:0': {
        trusted_hash: 'opaque',
        enabled: false,
      },
    },
  });
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import sys,json,tomllib; print(json.dumps([tomllib.loads(v) for v in sys.argv[1:]]))',
      ...args.filter((v: string) => v !== '-c'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(
    JSON.parse(parsed.stdout)[1].hooks.state[
      '/<session-flags>/config.toml:pre_tool_use:0:0'
    ].enabled,
    false,
  );
});
