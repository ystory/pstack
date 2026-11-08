import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(
  root,
  'plugin/skills/poteto-mode/scripts/shell-boundary.mjs',
);
const boundary = await import(pathToFileURL(script).href);
const input = (command: unknown, agentType?: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'Keep the original input fields.' },
  ...(agentType === undefined ? {} : { agent_type: agentType }),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pstack-shell-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function shell(command: string, sandbox?: string) {
  const env = { ...process.env };
  delete env.CODEX_SANDBOX;
  if (sandbox !== undefined) env.CODEX_SANDBOX = sandbox;
  return spawnSync('/bin/sh', ['-c', command], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
}

function hook(raw: string, codexHome: string, externalWorker = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.PSTACK_CODEX_WORKER;
  if (externalWorker) env.PSTACK_CODEX_WORKER = '1';
  return spawnSync(process.execPath, [script], {
    input: raw,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
}

async function registeredHome(t: TestContext) {
  const home = path.join(await directory(t), 'codex');
  const registration = spawnSync(
    process.execPath,
    [
      path.join(root, 'plugin/skills/setup-pstack/scripts/register-agents.mjs'),
      '--definitions-only',
      '--codex-home',
      home,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(registration.status, 0, registration.stderr);
  const file = path.join(home, 'pstack-codex/agent-registration.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return { home, file, raw, registration: boundary.normalizeRegistration(raw) };
}

test('direct and nested shell programs have zero side effects in seatbelt and run once after review', async (t) => {
  const dir = await directory(t);
  const effects = path.join(dir, 'effects');
  const program = `require('node:fs').appendFileSync(${JSON.stringify(effects)}, 'ran\\n')`;
  const direct = `${quote(process.execPath)} -e ${quote(program)}`;
  const nestedFile = path.join(dir, 'nested program.mjs');
  await writeFile(
    nestedFile,
    `import { spawnSync } from 'node:child_process';\nconst result = spawnSync(process.execPath, ['-e', ${JSON.stringify(program)}], { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`,
  );
  for (const command of [
    direct,
    `${quote(process.execPath)} ${quote(nestedFile)}`,
  ]) {
    const output = boundary.shellBoundaryOutput(input(command), {
      platform: 'darwin',
      externalWorker: true,
    });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(
      output.hookSpecificOutput.updatedInput.description,
      'Keep the original input fields.',
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /reviewed.*same|same.*reviewed/i,
    );
    const guarded = output.hookSpecificOutput.updatedInput.command;
    const denied = shell(guarded, 'seatbelt');
    assert.equal(denied.status, 125, denied.stderr);
    assert.match(denied.stderr, /PSTACK_REVIEW_REQUIRED/);
    await assert.rejects(readFile(effects), { code: 'ENOENT' });
    const reviewed = shell(guarded);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(await readFile(effects, 'utf8'), 'ran\n');
    await rm(effects);
  }
});

test('shell quotes, multiline commands and heredocs retain their bytes and effects', async (t) => {
  const dir = await directory(t);
  const outputFile = path.join(dir, "quotes ' dollar $ backtick ` file");
  const body =
    'literal $HOME `command` "double" and \'single\'\nsecond line\\n\n';
  const command = `cat <<'PSTACK_EOF' > ${quote(outputFile)}\n${body}PSTACK_EOF\nprintf '%s' 'last line' >> ${quote(outputFile)}`;
  const rewritten = boundary.rewriteCommand(command);
  assert.ok(rewritten.endsWith(command));
  assert.equal(shell(rewritten).status, 0);
  assert.equal(await readFile(outputFile, 'utf8'), body + 'last line');
});

test('repeated rewriting converges and a magic comment does not skip the guard', async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, 'effect');
  const command = `# PSTACK_REVIEW_REQUIRED\nprintf ran > ${quote(file)}`;
  const once = boundary.rewriteCommand(command);
  assert.equal(boundary.rewriteCommand(once), once);
  assert.equal(shell(once, 'seatbelt').status, 125);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('actual setup ownership includes metadata roles and exact role matching', async (t) => {
  const f = await registeredHome(t);
  assert.equal(f.registration.status, 'ready');
  assert.ok(f.registration.roles.includes('pstack-general-purpose'));
  for (const agentType of [
    'poteto-agent',
    'comment-sicko',
    'pstack-general-purpose',
  ]) {
    assert.equal(
      boundary.classifyScope({
        platform: 'darwin',
        externalWorker: false,
        agentType,
        registration: f.registration,
      }),
      'registered-native-worker',
    );
    const output = boundary.shellBoundaryOutput(
      input('printf ran', agentType),
      {
        platform: 'darwin',
        externalWorker: false,
        registration: f.registration,
      },
    );
    assert.equal(
      shell(output.hookSpecificOutput.updatedInput.command, 'seatbelt').status,
      125,
    );
  }
  for (const agentType of [
    undefined,
    'default',
    'poteto-agent-copy',
    'pstack-general-purpose-extra',
  ]) {
    assert.equal(
      boundary.classifyScope({
        platform: 'darwin',
        externalWorker: false,
        agentType,
        registration: f.registration,
      }),
      'out-of-scope',
    );
    assert.deepEqual(
      boundary.shellBoundaryOutput(input('printf ran', agentType), {
        platform: 'darwin',
        registration: f.registration,
      }),
      {},
    );
  }
  const renamed = structuredClone(f.raw);
  renamed.agents['exact-new-role'] = renamed.agents['poteto-agent'];
  delete renamed.agents['poteto-agent'];
  renamed.config.block = renamed.config.block.replace(
    '[agents.poteto-agent]',
    '[agents.exact-new-role]',
  );
  const normalized = boundary.normalizeRegistration(renamed);
  assert.equal(normalized.status, 'ready');
  assert.equal(
    boundary.classifyScope({
      platform: 'darwin',
      agentType: 'exact-new-role',
      registration: normalized,
    }),
    'registered-native-worker',
  );
  assert.equal(
    boundary.classifyScope({
      platform: 'darwin',
      agentType: 'poteto-agent',
      registration: normalized,
    }),
    'out-of-scope',
  );
});

test('external workers include their root shell without requiring registration', () => {
  assert.equal(
    boundary.classifyScope({ platform: 'darwin', externalWorker: true }),
    'external-worker',
  );
  assert.ok(
    boundary.shellBoundaryOutput(input('printf ran'), {
      platform: 'darwin',
      externalWorker: true,
    }).hookSpecificOutput.updatedInput,
  );
});

test('unrelated roles, root sessions and non-macOS calls are unchanged regardless of browser tokens', () => {
  const command =
    "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --version";
  for (const options of [
    { platform: 'darwin' },
    { platform: 'darwin', registration: { status: 'ready', roles: ['owned'] } },
    { platform: 'linux', externalWorker: true },
    { platform: 'win32', externalWorker: true },
  ])
    assert.deepEqual(boundary.shellBoundaryOutput(input(command), options), {});
});

test('malformed hook fields are rejected before emitting an execution decision', () => {
  for (const raw of [
    null,
    [],
    {},
    input(null),
    input(5),
    input('printf ran', 1),
    { ...input('printf ran'), tool_input: [] },
    { ...input('printf ran'), tool_name: 'Write' },
    { ...input('printf ran'), hook_event_name: 'PermissionRequest' },
  ]) {
    assert.throws(
      () =>
        boundary.shellBoundaryOutput(raw, {
          platform: 'darwin',
          externalWorker: true,
        }),
      /input|command|agent_type|Bash|PreToolUse/i,
    );
  }
});

test('schema mismatch blocks a provably owned role and leaves unrelated roles untouched', async (t) => {
  const f = await registeredHome(t);
  const broken = boundary.normalizeRegistration({
    ...f.raw,
    schemaVersion: 999,
  });
  assert.equal(broken.status, 'unsupported');
  assert.throws(
    () =>
      boundary.shellBoundaryOutput(
        input('printf ran', 'pstack-general-purpose'),
        { platform: 'darwin', registration: broken },
      ),
    /registration|schema/i,
  );
  assert.deepEqual(
    boundary.shellBoundaryOutput(input('printf ran', 'other'), {
      platform: 'darwin',
      registration: broken,
    }),
    {},
  );
  for (const change of [
    {
      ...f.raw,
      config: { ...f.raw.config, block: f.raw.config.block + 'unexpected\n' },
    },
    {
      ...f.raw,
      agents: { ...f.raw.agents, 'poteto-agent': { sha256: 'broken' } },
    },
    {
      ...f.raw,
      config: {
        ...f.raw.config,
        block: f.raw.config.block.replace('description = ', 'unknown = '),
      },
    },
  ])
    assert.equal(boundary.normalizeRegistration(change).status, 'unsupported');
});

test('CLI emits valid empty output for unrelated sessions and rejects malformed JSON', async (t) => {
  const dir = await directory(t);
  const unrelated = hook(JSON.stringify(input('printf ran', 'other')), dir);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), {});
  for (const raw of ['{', JSON.stringify(input(null)), '[]']) {
    const result = hook(raw, dir, true);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /PSTACK_SHELL_BOUNDARY/);
  }
});

test(
  'CLI reads only the exact ownership record and protects actual registered roles on macOS',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await registeredHome(t);
    await writeFile(
      path.join(f.home, 'config.toml'),
      'This unrelated file must not be parsed by the hook.',
    );
    await mkdir(path.join(f.home, 'pstack-codex', 'ignored'));
    for (const agentType of [
      'poteto-agent',
      'comment-sicko',
      'pstack-general-purpose',
    ]) {
      const result = hook(
        JSON.stringify(input('printf ran', agentType)),
        f.home,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        shell(
          JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command,
          'seatbelt',
        ).status,
        125,
      );
    }
    await writeFile(f.file, JSON.stringify({ ...f.raw, schemaVersion: 999 }));
    const broken = hook(
      JSON.stringify(input('printf ran', 'pstack-general-purpose')),
      f.home,
    );
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /registration|schema/i);
    const external = hook(JSON.stringify(input('printf ran')), f.home, true);
    assert.equal(external.status, 0, external.stderr);
    assert.equal(
      shell(
        JSON.parse(external.stdout).hookSpecificOutput.updatedInput.command,
        'seatbelt',
      ).status,
      125,
    );
  },
);

test('plugin hook uses the shared plugin-root variable, Bash matcher and finite command timeout', async () => {
  const config = JSON.parse(
    await readFile(path.join(root, 'plugin/hooks/hooks.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(config.hooks), ['PreToolUse']);
  assert.equal(config.hooks.PreToolUse.length, 1);
  const entry = config.hooks.PreToolUse[0];
  assert.equal(entry.matcher, '^Bash$');
  assert.equal(entry.hooks.length, 1);
  const handler = entry.hooks[0];
  assert.equal(handler.type, 'command');
  assert.equal(
    handler.command,
    'node "${CLAUDE_PLUGIN_ROOT}/skills/poteto-mode/scripts/shell-boundary.mjs"',
  );
  assert.ok(
    Number.isFinite(handler.timeout) &&
      handler.timeout > 0 &&
      handler.timeout <= 10,
  );
});
