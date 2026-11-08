import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function hook(raw: string, codexHome: string, externalWorker = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.PSTACK_CODEX_WORKER;
  if (externalWorker) env.PSTACK_CODEX_WORKER = '1';
  const source = await readFile(script, 'utf8');
  const module =
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const binding = externalWorker
    ? { mode: 'external' }
    : { mode: 'native', nativeRoles: ['owned'] };
  const program = `const boundary = await import(${JSON.stringify(module)}); await boundary.runShellBoundary(${JSON.stringify(binding)});`;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      input: raw,
      env,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
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
  const receipt = JSON.parse(registration.stdout);
  const roles = [...receipt.agents, ...receipt.metadataRoles].map(
    (role: { name: string }) => role.name,
  );
  return { home, file, roles };
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
  assert.ok(f.roles.includes('pstack-general-purpose'));
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
        nativeRoles: f.roles,
      }),
      'registered-native-worker',
    );
    const output = boundary.shellBoundaryOutput(
      input('printf ran', agentType),
      {
        platform: 'darwin',
        externalWorker: false,
        nativeRoles: f.roles,
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
        nativeRoles: f.roles,
      }),
      'out-of-scope',
    );
    assert.deepEqual(
      boundary.shellBoundaryOutput(input('printf ran', agentType), {
        platform: 'darwin',
        nativeRoles: f.roles,
      }),
      {},
    );
  }
  const renamed = f.roles.map((role) =>
    role === 'poteto-agent' ? 'exact-new-role' : role,
  );
  assert.equal(
    boundary.classifyScope({
      platform: 'darwin',
      agentType: 'exact-new-role',
      nativeRoles: renamed,
    }),
    'registered-native-worker',
  );
  assert.equal(
    boundary.classifyScope({
      platform: 'darwin',
      agentType: 'poteto-agent',
      nativeRoles: renamed,
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
    { platform: 'darwin', nativeRoles: ['owned'] },
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

test('frozen program emits empty output for unrelated sessions and blocks malformed JSON', async (t) => {
  const dir = await directory(t);
  const unrelated = await hook(
    JSON.stringify(input('printf ran', 'other')),
    dir,
  );
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), {});
  for (const raw of ['{', JSON.stringify(input(null)), '[]']) {
    const result = await hook(raw, dir, true);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /PSTACK_SHELL_BOUNDARY/);
  }
});

test('streamed UTF-8 hook input preserves the complete original command', async (t) => {
  const dir = await directory(t);
  const command = '# ' + '가🙂'.repeat(20000) + '\nprintf unchanged';
  const result = await hook(JSON.stringify(input(command)), dir, true);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  if (process.platform === 'darwin')
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      boundary.SHELL_BOUNDARY_PREFIX + command,
    );
  else assert.deepEqual(output, {});
});

test('native runtime uses the supplied setup scope and never reads damaged or missing registration files', async (t) => {
  const f = await registeredHome(t);
  const program = `import {runShellBoundary} from ${JSON.stringify(pathToFileURL(script).href)}; await runShellBoundary(${JSON.stringify({ mode: 'native', nativeRoles: f.roles })});`;
  await writeFile(f.file, '{broken');
  const invoke = (agentType: string, externalWorker = false) =>
    spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      env: {
        ...process.env,
        CODEX_HOME: f.home,
        PSTACK_CODEX_WORKER: externalWorker ? '1' : '',
      },
      input: JSON.stringify(input('printf ran', agentType)),
      encoding: 'utf8',
    });
  for (const role of f.roles) {
    const result = invoke(role);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    if (process.platform === 'darwin')
      assert.equal(
        shell(output.hookSpecificOutput.updatedInput.command, 'seatbelt')
          .status,
        125,
      );
    else assert.deepEqual(output, {});
  }
  await rm(f.file);
  assert.deepEqual(JSON.parse(invoke('other').stdout), {});
  const role = f.roles[0];
  assert.ok(role);
  assert.deepEqual(JSON.parse(invoke(role, true).stdout), {});
});

test('native manifest leaves the boundary in immutable user configuration', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'plugin/.codex-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
});
