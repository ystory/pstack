import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(projectRoot, 'plugin');
const scriptPath = 'skills/setup-pstack/scripts/register-agents.mjs';
const names = ['poteto-agent', 'comment-sicko'] as const;

interface RegistrationResult {
  codexHome: string;
  pluginVersion: string;
  dryRun: boolean;
  agents: {
    name: string;
    file: string;
    status:
      | 'installed'
      | 'updated'
      | 'unchanged'
      | 'removed'
      | 'absent'
      | 'not-managed';
  }[];
  metadataRoles: {
    name: string;
    status:
      | 'configured'
      | 'unchanged'
      | 'updated'
      | 'removed'
      | 'absent'
      | 'not-managed';
  }[];
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle with spaces');
  const consumer = path.join(root, 'consumer');
  const codexHome = path.join(root, 'isolated-codex');
  await mkdir(path.join(bundle, path.dirname(scriptPath)), { recursive: true });
  await mkdir(path.join(bundle, 'agents'), { recursive: true });
  await mkdir(consumer);
  for (const relative of [
    'plugin.json',
    scriptPath,
    'skills/setup-pstack/scripts/parse-agent-config.py',
    ...names.map((name) => `agents/${name}.toml`),
  ]) {
    await copyFile(
      path.join(pluginRoot, relative),
      path.join(bundle, relative),
    );
  }
  const invoke = (...flags: string[]) =>
    spawnSync(
      process.execPath,
      [
        path.join(bundle, scriptPath),
        '--definitions-only',
        '--codex-home',
        codexHome,
        ...flags,
      ],
      {
        cwd: consumer,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
  const run = (...flags: string[]): RegistrationResult => {
    const result = invoke(...flags);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout) as RegistrationResult;
  };
  return { root, bundle, consumer, codexHome, invoke, run };
}

async function assertMissing(file: string) {
  await assert.rejects(stat(file), { code: 'ENOENT' });
}

function decodePackagedAgent(toml: string) {
  const match =
    /^name = (".*")\ndescription = (".*")\ndeveloper_instructions = '''\n([\s\S]*)'''\n$/.exec(
      toml,
    );
  assert.ok(match, 'Expected the three-field TOML format used by the package');
  assert.ok(match[1] && match[2] && match[3] !== undefined);
  return {
    name: JSON.parse(match[1]) as string,
    description: JSON.parse(match[2]) as string,
    body: match[3],
  };
}

const cursorSkillLookup =
  'search `~/.cursor/plugins/` for a file whose path ends in `skills/poteto-mode/SKILL.md`. If more than one file matches, use the copy whose `.cursor-plugin/plugin.json` has the highest `version`.';
const codexSkillLookup =
  "locate this loaded plugin's root from the host's plugin metadata and read its `skills/poteto-mode/SKILL.md`. If discovery is unavailable, search only `pstack-codex/<version>/` directories under `${CODEX_HOME:-~/.codex}/plugins/cache/` for that file and use the copy whose `plugin.json` has the highest `version`. Do not select a different plugin or guess a workspace-relative path.";

function codexBody(name: (typeof names)[number], upstream: string) {
  if (name !== 'poteto-agent') return upstream;
  assert.ok(upstream.includes(cursorSkillLookup));
  return upstream.replace(cursorSkillLookup, codexSkillLookup);
}

test('packaged agent metadata and original instructions survive the supplied-body adaptation', async () => {
  for (const name of names) {
    const original = await readFile(
      path.join(projectRoot, 'upstream/pstack/agents', `${name}.md`),
      'utf8',
    );
    const header = /^---\n([\s\S]*?)\n---\n/.exec(original);
    assert.ok(header && header[1]);
    const description = /^description: (.*)$/m.exec(header[1])?.[1];
    const parsed = decodePackagedAgent(
      await readFile(path.join(pluginRoot, 'agents', `${name}.toml`), 'utf8'),
    );
    assert.equal(parsed.name, name);
    assert.equal(parsed.description, description);
    const markdown = await readFile(
      path.join(pluginRoot, 'agents', `${name}.md`),
      'utf8',
    );
    assert.ok(markdown.startsWith(header[0]));
    assert.equal(
      parsed.body,
      codexBody(name, markdown.slice(header[0].length)),
    );
    assert.doesNotMatch(parsed.body, /\.cursor/);
    if (name === 'poteto-agent') {
      assert.ok(
        parsed.body.startsWith(
          codexBody(name, original.slice(header[0].length)),
        ),
      );
    } else {
      assert.equal(markdown, original);
    }
  }
});

test('onboarding points to the packaged setup skill', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'),
  );
  const entry = manifest.extensions['com.openai'].onboardingSkill;
  assert.equal(entry, './skills/setup-pstack/SKILL.md');
  const skill = await readFile(path.join(pluginRoot, entry), 'utf8');
  assert.ok(skill.includes('scripts/register-agents.mjs'));
});

test('registration runs from a standalone bundle and preserves unrelated configuration', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.codexHome, 'agents'), { recursive: true });
  const config = path.join(f.codexHome, 'config.toml');
  const otherAgent = path.join(f.codexHome, 'agents', 'other.toml');
  await writeFile(config, 'model = "user-choice"\n');
  await writeFile(otherAgent, 'user-owned agent\n');
  const result = f.run();
  assert.equal(result.codexHome, f.codexHome);
  assert.equal(result.dryRun, false);
  assert.deepEqual(
    result.agents.map(({ name, status }) => ({ name, status })),
    names.map((name) => ({ name, status: 'installed' })),
  );
  for (const name of names) {
    assert.deepEqual(
      await readFile(path.join(f.codexHome, 'agents', `${name}.toml`)),
      await readFile(path.join(f.bundle, 'agents', `${name}.toml`)),
    );
  }
  const configured = await readFile(config, 'utf8');
  assert.ok(configured.startsWith('model = "user-choice"\n'));
  for (const name of names) {
    assert.ok(configured.includes(`[agents.${name}]`));
    assert.ok(
      configured.includes(
        JSON.stringify(path.join(f.codexHome, 'agents', `${name}.toml`)),
      ),
    );
  }
  assert.equal(await readFile(otherAgent, 'utf8'), 'user-owned agent\n');
});

test('rerunning setup leaves identical registered files untouched', async (t) => {
  const f = await fixture(t);
  f.run();
  const files = names.map((name) =>
    path.join(f.codexHome, 'agents', `${name}.toml`),
  );
  const fixed = new Date('2020-01-01T00:00:00Z');
  for (const file of files) await utimes(file, fixed, fixed);
  assert.ok(f.run().agents.every(({ status }) => status === 'unchanged'));
  for (const file of files)
    assert.equal((await stat(file)).mtimeMs, fixed.getTime());
});

test('dry run does not create the destination', async (t) => {
  const f = await fixture(t);
  const result = f.run('--dry-run');
  assert.equal(result.dryRun, true);
  assert.ok(result.agents.every(({ status }) => status === 'installed'));
  await assertMissing(f.codexHome);
});

test('a conflicting second agent prevents registration of either file', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.codexHome, 'agents'), { recursive: true });
  const conflicting = path.join(f.codexHome, 'agents', 'comment-sicko.toml');
  await writeFile(conflicting, 'user-owned content\n');
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed|conflict|overwrite/i);
  assert.equal(await readFile(conflicting, 'utf8'), 'user-owned content\n');
  await assertMissing(path.join(f.codexHome, 'agents', 'poteto-agent.toml'));
  await assertMissing(path.join(f.codexHome, 'pstack-codex'));
});

test('an identical preexisting agent remains user-owned instead of being silently adopted', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.codexHome, 'agents'), { recursive: true });
  const existing = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  await copyFile(path.join(f.bundle, 'agents', 'poteto-agent.toml'), existing);
  const before = await readFile(existing);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed/i);
  assert.deepEqual(await readFile(existing), before);
  await assertMissing(path.join(f.codexHome, 'agents', 'comment-sicko.toml'));
  await assertMissing(path.join(f.codexHome, 'config.toml'));
  assert.equal(
    f.run('--unregister').agents.find(({ name }) => name === 'poteto-agent')
      ?.status,
    'not-managed',
  );
  assert.deepEqual(await readFile(existing), before);
});

test('managed files update and can return to the prior bundle version', async (t) => {
  const f = await fixture(t);
  const originalResult = f.run();
  const source = path.join(f.bundle, 'agents', 'poteto-agent.toml');
  const originalBytes = await readFile(source);
  const manifestPath = path.join(f.bundle, 'plugin.json');
  const originalManifest = await readFile(manifestPath);
  const manifest = JSON.parse(originalManifest.toString('utf8'));
  manifest.version = '0.1.0-dev.1';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    source,
    Buffer.concat([originalBytes, Buffer.from('# Updated test bundle\n')]),
  );
  const updated = f.run();
  assert.equal(updated.pluginVersion, '0.1.0-dev.1');
  assert.equal(
    updated.agents.find(({ name }) => name === 'poteto-agent')?.status,
    'updated',
  );
  assert.equal(
    updated.agents.find(({ name }) => name === 'comment-sicko')?.status,
    'unchanged',
  );
  assert.deepEqual(
    await readFile(path.join(f.codexHome, 'agents', 'poteto-agent.toml')),
    await readFile(source),
  );
  await writeFile(manifestPath, originalManifest);
  await writeFile(source, originalBytes);
  assert.equal(f.run().pluginVersion, originalResult.pluginVersion);
  assert.deepEqual(
    await readFile(path.join(f.codexHome, 'agents', 'poteto-agent.toml')),
    originalBytes,
  );
});

test('a user edit in a registered file prevents an update without partial writes', async (t) => {
  const f = await fixture(t);
  f.run();
  const first = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const firstBefore = await readFile(first);
  const second = path.join(f.codexHome, 'agents', 'comment-sicko.toml');
  await writeFile(second, 'edited by user\n');
  await writeFile(
    path.join(f.bundle, 'agents', 'poteto-agent.toml'),
    Buffer.concat([firstBefore, Buffer.from('# New bundle\n')]),
  );
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /modified|overwrite/i);
  assert.deepEqual(await readFile(first), firstBefore);
  assert.equal(await readFile(second, 'utf8'), 'edited by user\n');
});

test('registration refuses a target symlink and preserves its destination', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.codexHome, 'agents'), { recursive: true });
  const outside = path.join(f.root, 'outside.toml');
  await writeFile(outside, 'outside content\n');
  await symlink(
    outside,
    path.join(f.codexHome, 'agents', 'comment-sicko.toml'),
  );
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(await readFile(outside, 'utf8'), 'outside content\n');
  await assertMissing(path.join(f.codexHome, 'agents', 'poteto-agent.toml'));
});

test('a missing bundled agent fails before writing the destination', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.bundle, 'agents', 'comment-sicko.toml'));
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing|empty/i);
  await assertMissing(f.codexHome);
});

test('an invalid ownership record is preserved and fails before modifying agents', async (t) => {
  const f = await fixture(t);
  f.run();
  const record = path.join(
    f.codexHome,
    'pstack-codex',
    'agent-registration.json',
  );
  await writeFile(record, 'invalid record\n');
  const first = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const before = await readFile(first);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /record|JSON/i);
  assert.deepEqual(await readFile(first), before);
  assert.equal(await readFile(record, 'utf8'), 'invalid record\n');
});

test('unregister removes only owned agents and retains user preferences and unrelated files', async (t) => {
  const f = await fixture(t);
  f.run();
  const preferences = path.join(f.codexHome, 'pstack-codex', 'models.json');
  const unrelated = path.join(f.codexHome, 'agents', 'user-agent.toml');
  await writeFile(preferences, 'user model choices\n');
  await writeFile(unrelated, 'user agent\n');
  const result = f.run('--unregister');
  assert.ok(result.agents.every(({ status }) => status === 'removed'));
  for (const name of names)
    await assertMissing(path.join(f.codexHome, 'agents', `${name}.toml`));
  await assertMissing(
    path.join(f.codexHome, 'pstack-codex', 'agent-registration.json'),
  );
  assert.equal(await readFile(preferences, 'utf8'), 'user model choices\n');
  assert.equal(await readFile(unrelated, 'utf8'), 'user agent\n');
  assert.ok(
    f.run('--unregister').agents.every(({ status }) => status === 'absent'),
  );
});

test('unregister preflights every agent and preserves both when one was edited', async (t) => {
  const f = await fixture(t);
  f.run();
  const first = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const before = await readFile(first);
  const edited = path.join(f.codexHome, 'agents', 'comment-sicko.toml');
  await writeFile(edited, 'user edit\n');
  const result = f.invoke('--unregister');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /modified|refusing to remove/i);
  assert.deepEqual(await readFile(first), before);
  assert.equal(await readFile(edited, 'utf8'), 'user edit\n');
});

test('dry-run unregister changes no bytes and unregister requires ownership', async (t) => {
  const f = await fixture(t);
  f.run();
  const registered = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const before = await readFile(registered);
  assert.ok(
    f
      .run('--unregister', '--dry-run')
      .agents.every(({ status }) => status === 'removed'),
  );
  assert.deepEqual(await readFile(registered), before);
  await rm(path.join(f.codexHome, 'pstack-codex', 'agent-registration.json'));
  assert.ok(
    f
      .run('--unregister')
      .agents.every(({ status }) => status === 'not-managed'),
  );
  assert.deepEqual(await readFile(registered), before);
});

test('agent permission edits block upgrades and removal without touching content', async (t) => {
  const f = await fixture(t);
  f.run();
  const agent = path.join(f.codexHome, 'agents', 'comment-sicko.toml');
  const before = await readFile(agent);
  await chmod(agent, 0o600);
  for (const flags of [[], ['--unregister']]) {
    const result = f.invoke(...flags);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /modified/i);
    assert.deepEqual(await readFile(agent), before);
    assert.equal((await stat(agent)).mode & 0o777, 0o600);
  }
});

test('a legacy hash-only registry upgrades ownership metadata without rewriting agents', async (t) => {
  const f = await fixture(t);
  f.run();
  const record = path.join(
    f.codexHome,
    'pstack-codex',
    'agent-registration.json',
  );
  const registry = JSON.parse(await readFile(record, 'utf8'));
  registry.schemaVersion = 1;
  delete registry.config;
  await rm(path.join(f.codexHome, 'config.toml'));
  for (const entry of Object.values(registry.agents) as { mode?: number }[])
    delete entry.mode;
  await writeFile(record, JSON.stringify(registry));
  const agent = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const fixed = new Date('2020-01-01T00:00:00Z');
  await utimes(agent, fixed, fixed);
  assert.ok(f.run().agents.every(({ status }) => status === 'unchanged'));
  assert.equal((await stat(agent)).mtimeMs, fixed.getTime());
  const updated = JSON.parse(await readFile(record, 'utf8'));
  for (const entry of Object.values(updated.agents) as { mode: number }[])
    assert.equal(entry.mode, 0o644);
});

test('unregister restores preexisting config bytes and permissions including a missing final newline', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const file = path.join(f.codexHome, 'config.toml');
  const original = '# keep comment and spacing\nmodel = "user-choice"';
  await writeFile(file, original, { mode: 0o640 });
  f.run();
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  f.run('--unregister');
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
});

test('registration and removal preserve independent later config edits and unrelated agent settings', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const file = path.join(f.codexHome, 'config.toml');
  const original =
    '# original config\nmodel = "user-choice"\n[agents]\nmax_threads = 7\n[agents.other]\ndescription = "user-owned"\n';
  await writeFile(file, original);
  f.run();
  const added =
    '\n# later user edit\n[projects."/tmp/user-project"]\ntrust_level = "trusted"\n';
  await writeFile(file, (await readFile(file, 'utf8')) + added);
  f.run();
  f.run('--unregister');
  assert.equal(await readFile(file, 'utf8'), original + added);
});

test('role declarations collide safely across native TOML table, dotted, inline and quoted forms', async (t) => {
  const cases = [
    '[agents.poteto-agent]\ndescription = "user"\n',
    '["agents"."poteto-agent"]\ndescription = "user"\n',
    'agents.poteto-agent.description = "user"\n',
    '"agents"."poteto-agent".description = "user"\n',
    'agents = { "poteto-agent" = { description = "user" } }\n',
    '[agents]\n"poteto-agent" = { description = "user" }\n',
    '[[agents.poteto-agent]]\ndescription = "user"\n',
  ];
  for (const content of cases) {
    const f = await fixture(t);
    await mkdir(f.codexHome);
    const file = path.join(f.codexHome, 'config.toml');
    await writeFile(file, content);
    const result = f.invoke();
    assert.notEqual(result.status, 0, content);
    assert.match(result.stderr, /not managed/i);
    assert.equal(await readFile(file, 'utf8'), content);
    await assertMissing(path.join(f.codexHome, 'agents'));
    await assertMissing(path.join(f.codexHome, 'pstack-codex'));
  }
});

test('an inline unrelated agents table is preserved with an actionable conservative conflict', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const file = path.join(f.codexHome, 'config.toml');
  const original = 'agents = { other = { description = "user" } }\n';
  await writeFile(file, original);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /convert an inline agents table/i);
  assert.equal(await readFile(file, 'utf8'), original);
  await assertMissing(path.join(f.codexHome, 'agents'));
});

test('malformed native config and unavailable Python fail before any registration writes', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const file = path.join(f.codexHome, 'config.toml');
  await writeFile(file, 'model = [\n');
  const malformed = f.invoke();
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /TOML/i);
  assert.equal(await readFile(file, 'utf8'), 'model = [\n');
  await assertMissing(path.join(f.codexHome, 'agents'));
  await rm(file);
  const unavailable = f.invoke('--python', path.join(f.root, 'missing-python'));
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /Python 3.11/i);
  await assertMissing(path.join(f.codexHome, 'agents'));
  await assertMissing(file);
});

test('a user change inside managed native declarations blocks update and removal of every file', async (t) => {
  const f = await fixture(t);
  f.run();
  const file = path.join(f.codexHome, 'config.toml');
  const original = await readFile(file, 'utf8');
  const edited = original.replace(
    'description = ',
    '# user-owned change\ndescription = ',
  );
  await writeFile(file, edited);
  const first = path.join(f.codexHome, 'agents', 'poteto-agent.toml');
  const before = await readFile(first);
  for (const flags of [[], ['--unregister']]) {
    const result = f.invoke(...flags);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /modified|duplicated/i);
    assert.equal(await readFile(file, 'utf8'), edited);
    assert.deepEqual(await readFile(first), before);
  }
});

test('config symlinks are refused before touching either agents or the symlink destination', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const outside = path.join(f.root, 'outside-config.toml');
  await writeFile(outside, 'model = "user-choice"\n');
  await symlink(outside, path.join(f.codexHome, 'config.toml'));
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(await readFile(outside, 'utf8'), 'model = "user-choice"\n');
  await assertMissing(path.join(f.codexHome, 'agents'));
});

test('a transaction failure restores all agent and config bytes and leaves the prior ledger intact', async (t) => {
  const f = await fixture(t);
  f.run();
  const config = path.join(f.codexHome, 'config.toml');
  const record = path.join(
    f.codexHome,
    'pstack-codex',
    'agent-registration.json',
  );
  const destinations = [
    config,
    record,
    ...names.map((name) => path.join(f.codexHome, 'agents', `${name}.toml`)),
  ];
  const before = await Promise.all(destinations.map((file) => readFile(file)));
  const source = path.join(f.bundle, 'agents', 'poteto-agent.toml');
  await writeFile(
    source,
    (await readFile(source, 'utf8')).replace(
      /^description = .*$/m,
      'description = "Changed source description"',
    ),
  );
  const failure = path.join(f.root, 'inject-failure.mjs');
  await writeFile(
    failure,
    'import fs from "node:fs/promises";\nimport { syncBuiltinESMExports } from "node:module";\nconst rename = fs.rename;\nfs.rename = async (source, destination) => { if (destination.endsWith("agent-registration.json")) throw new Error("Injected transaction failure"); return rename(source, destination); };\nsyncBuiltinESMExports();\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      failure,
      path.join(f.bundle, scriptPath),
      '--definitions-only',
      '--codex-home',
      f.codexHome,
    ],
    { cwd: f.consumer, encoding: 'utf8', timeout: 10_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected transaction failure/i);
  for (const [index, file] of destinations.entries())
    assert.deepEqual(await readFile(file), before[index]);
});

test('the generic pstack delegate is metadata-only and preserves user default agent settings', async (t) => {
  const f = await fixture(t);
  await mkdir(f.codexHome);
  const config = path.join(f.codexHome, 'config.toml');
  const original =
    '# existing defaults\nmodel = "parent-choice"\n[agents.default]\nmodel = "user-fixed-default"\nmodel_reasoning_effort = "max"\n';
  await writeFile(config, original);
  const result = f.run();
  assert.deepEqual(result.metadataRoles, [
    { name: 'pstack-general-purpose', status: 'configured' },
  ]);
  assert.equal(result.agents.length, 2);
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))["agents"]["pstack-general-purpose"]))',
      config,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), {
    description:
      'General-purpose delegate for pstack workflows; follow the supplied task and model settings.',
  });
  assert.ok((await readFile(config, 'utf8')).startsWith(original));
  await assertMissing(
    path.join(f.codexHome, 'agents', 'pstack-general-purpose.toml'),
  );
  assert.deepEqual(f.run().metadataRoles, [
    { name: 'pstack-general-purpose', status: 'unchanged' },
  ]);
  assert.deepEqual(f.run('--unregister').metadataRoles, [
    { name: 'pstack-general-purpose', status: 'removed' },
  ]);
  assert.equal(await readFile(config, 'utf8'), original);
});

async function makeTwoRoleRecord(f: Awaited<ReturnType<typeof fixture>>) {
  const record = path.join(
    f.codexHome,
    'pstack-codex',
    'agent-registration.json',
  );
  const config = path.join(f.codexHome, 'config.toml');
  const registry = JSON.parse(await readFile(record, 'utf8'));
  const currentBlock = registry.config.block as string;
  const originalBlock =
    '# >>> pstack-codex managed agents v1\n' +
    currentBlock.slice(
      currentBlock.indexOf('[agents.poteto-agent]'),
      currentBlock.indexOf('\n[agents.pstack-general-purpose]'),
    ) +
    '# <<< pstack-codex managed agents v1\n';
  assert.notEqual(originalBlock, currentBlock);
  registry.config.block = originalBlock;
  await writeFile(
    config,
    (await readFile(config, 'utf8')).replace(currentBlock, originalBlock),
  );
  await writeFile(record, `${JSON.stringify(registry, null, 2)}\n`);
  return { config, record, originalBlock };
}

test('a valid prior two-role managed block migrates to three declarations without rewriting original agent files', async (t) => {
  const f = await fixture(t);
  f.run();
  const before = await Promise.all(
    names.map((name) =>
      readFile(path.join(f.codexHome, 'agents', `${name}.toml`)),
    ),
  );
  const old = await makeTwoRoleRecord(f);
  const result = f.run();
  assert.ok(result.agents.every(({ status }) => status === 'unchanged'));
  assert.deepEqual(result.metadataRoles, [
    { name: 'pstack-general-purpose', status: 'configured' },
  ]);
  assert.ok(
    (await readFile(old.config, 'utf8')).includes(
      '[agents.pstack-general-purpose]',
    ),
  );
  for (const [index, name] of names.entries())
    assert.deepEqual(
      await readFile(path.join(f.codexHome, 'agents', `${name}.toml`)),
      before[index],
    );
  const manifest = path.join(f.bundle, 'plugin.json');
  const originalManifest = await readFile(manifest);
  const updated = JSON.parse(originalManifest.toString('utf8'));
  updated.version = '0.1.0-dev.2';
  await writeFile(manifest, JSON.stringify(updated));
  assert.equal(f.run().pluginVersion, '0.1.0-dev.2');
  await writeFile(manifest, originalManifest);
  assert.deepEqual(f.run().metadataRoles, [
    { name: 'pstack-general-purpose', status: 'unchanged' },
  ]);
  assert.deepEqual(f.run('--unregister').metadataRoles, [
    { name: 'pstack-general-purpose', status: 'removed' },
  ]);
  await assertMissing(old.config);
});

test('an unowned generic role prevents registration regardless of TOML declaration style', async (t) => {
  for (const content of [
    '[agents.pstack-general-purpose]\ndescription = "user"\n',
    '["agents"."pstack-general-purpose"]\ndescription = "user"\n',
    'agents.pstack-general-purpose.description = "user"\n',
    'agents = { "pstack-general-purpose" = { description = "user" } }\n',
  ]) {
    const f = await fixture(t);
    await mkdir(f.codexHome);
    const config = path.join(f.codexHome, 'config.toml');
    await writeFile(config, content);
    const result = f.invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not managed/i);
    assert.equal(await readFile(config, 'utf8'), content);
    await assertMissing(path.join(f.codexHome, 'agents'));
  }
});

test('a user-owned generic role blocks a two-to-three upgrade while remaining intact on removal of the old owned roles', async (t) => {
  const f = await fixture(t);
  f.run();
  const old = await makeTwoRoleRecord(f);
  const userRole =
    '\n[agents.pstack-general-purpose]\ndescription = "user role"\n';
  await writeFile(old.config, (await readFile(old.config, 'utf8')) + userRole);
  const before = await readFile(old.config);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not managed/i);
  assert.deepEqual(await readFile(old.config), before);
  assert.deepEqual(f.run('--unregister').metadataRoles, [
    { name: 'pstack-general-purpose', status: 'not-managed' },
  ]);
  assert.equal(await readFile(old.config, 'utf8'), userRole);
});

test('old-name registrations require clean unregister before the new identity can register', async (t) => {
  const f = await fixture(t);
  const registrarFile = path.join(f.bundle, scriptPath);
  const manifestFile = path.join(f.bundle, 'plugin.json');
  const registrar = await readFile(registrarFile, 'utf8');
  const manifest = await readFile(manifestFile, 'utf8');
  const oldRegistrar = registrar.replaceAll('pstack-codex', 'pstack-for-codex');
  const oldManifest = manifest.replaceAll('pstack-codex', 'pstack-for-codex');
  await writeFile(registrarFile, oldRegistrar);
  await writeFile(manifestFile, oldManifest);
  f.run();
  const configFile = path.join(f.codexHome, 'config.toml');
  const previous = await readFile(configFile);
  await writeFile(registrarFile, registrar);
  await writeFile(manifestFile, manifest);
  assert.notEqual(f.invoke().status, 0);
  assert.deepEqual(await readFile(configFile), previous);
  await assertMissing(path.join(f.codexHome, 'pstack-codex'));
  await writeFile(registrarFile, oldRegistrar);
  await writeFile(manifestFile, oldManifest);
  f.run('--unregister');
  await writeFile(registrarFile, registrar);
  await writeFile(manifestFile, manifest);
  const registered = f.run();
  assert.ok(registered.agents.every((entry) => entry.status === 'installed'));
  const ownership = JSON.parse(
    await readFile(
      path.join(f.codexHome, 'pstack-codex/agent-registration.json'),
      'utf8',
    ),
  );
  assert.equal(ownership.pluginName, 'pstack-codex');
  assert.ok(
    (await readFile(configFile, 'utf8')).includes(
      '# >>> pstack-codex managed agents',
    ),
  );
  f.run('--unregister');
  await assertMissing(configFile);
});

test('normal macOS registration rejects an unavailable command boundary before writing agents', async (t) => {
  const f = await fixture(t);
  const helper = path.join(
    f.bundle,
    'skills/poteto-mode/scripts/codex-boundary.mjs',
  );
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(
    helper,
    'export async function trustNativeBoundary() { throw new Error("Required pstack hook is unavailable"); }\n',
  );
  const platform = path.join(f.root, 'macos-fixture.mjs');
  await writeFile(
    platform,
    'Object.defineProperty(process, "platform", {value:"darwin"});\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      platform,
      path.join(f.bundle, scriptPath),
      '--codex-home',
      f.codexHome,
    ],
    { cwd: f.consumer, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required pstack hook is unavailable/);
  await assertMissing(path.join(f.codexHome, 'agents/poteto-agent.toml'));
  await assertMissing(
    path.join(f.codexHome, 'pstack-codex/agent-registration.json'),
  );
});

test('normal macOS registration activates its owned boundary using the selected home', async (t) => {
  const f = await fixture(t);
  const helper = path.join(
    f.bundle,
    'skills/poteto-mode/scripts/codex-boundary.mjs',
  );
  const evidence = path.join(f.root, 'boundary-input.json');
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(
    helper,
    `import fs from 'node:fs';\nexport async function trustNativeBoundary(options) { fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({cwd:options.cwd,nativeRoles:options.nativeRoles,guardPath:options.guardPath,codexHome:options.codexHome,envHome:options.env.CODEX_HOME})); fs.mkdirSync(options.env.CODEX_HOME,{recursive:true}); fs.appendFileSync(options.env.CODEX_HOME+'/config.toml','[hooks.state.fixture]\\ntrusted_hash = \"owned\"\\n'); return {status:'active',hook:{key:'owned-fixture-hook'}}; }\n`,
  );
  const platform = path.join(f.root, 'macos-fixture.mjs');
  await writeFile(
    platform,
    'Object.defineProperty(process, "platform", {value:"darwin"});\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      platform,
      path.join(f.bundle, scriptPath),
      '--codex-home',
      f.codexHome,
    ],
    { cwd: f.consumer, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.commandBoundary.status, 'active');
  assert.match(
    await readFile(path.join(f.codexHome, 'config.toml'), 'utf8'),
    /\[hooks\.state\.fixture\]/,
  );
  assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')), {
    cwd: await realpath(f.consumer),
    nativeRoles: ['poteto-agent', 'comment-sicko', 'pstack-general-purpose'],
    guardPath: path.join(
      await realpath(f.bundle),
      'skills/poteto-mode/scripts/shell-boundary.mjs',
    ),
    codexHome: f.codexHome,
    envHome: f.codexHome,
  });
  assert.match(
    await readFile(path.join(f.codexHome, 'agents/poteto-agent.toml'), 'utf8'),
    /name = "poteto-agent"/,
  );
});

async function nativeRegistrationFixture(t: TestContext) {
  const f = await fixture(t);
  const helper = path.join(
    f.bundle,
    'skills/poteto-mode/scripts/codex-boundary.mjs',
  );
  const platform = path.join(f.root, 'macos-fixture.mjs');
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(
    platform,
    'Object.defineProperty(process, "platform", {value:"darwin"});\n',
  );
  const invoke = (...flags: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        platform,
        path.join(f.bundle, scriptPath),
        '--codex-home',
        f.codexHome,
        ...flags,
      ],
      { cwd: f.consumer, encoding: 'utf8', timeout: 10_000 },
    );
  return { ...f, helper, nativeInvoke: invoke };
}

const foreignHook =
  '{ matcher = "^Read$", hooks = [{ type = "command", command = "foreign-hook", timeout = 13 }] }';
const retiredHook =
  '{ matcher = "^Bash$", hooks = [{ type = "command", command = "retired-pstack-hook", timeout = 5 }] }';
const foreignTrust =
  '# foreign hook trust\n[hooks.state."foreign-hook-key"]\ntrusted_hash = "sha256:foreign"\n';
const retiredTrust =
  '# retained user tombstone\n[hooks.state."retired-pstack-key"]\nenabled = false\ntrusted_hash = "sha256:retired"\n';

async function historicalNativeRegistrationFixture(t: TestContext) {
  const f = await nativeRegistrationFixture(t);
  const config = path.join(f.codexHome, 'config.toml');
  const record = path.join(f.codexHome, 'pstack-codex/agent-registration.json');
  const control = path.join(f.root, 'boundary-control.json');
  const calls = path.join(f.root, 'boundary-calls.txt');
  const settings = '# user settings and spacing\nmodel = "user-choice"\n';
  const foreignConfig =
    settings +
    `[hooks]\nPreToolUse = [${foreignHook}, ${retiredHook}]\n\n` +
    foreignTrust +
    '\n' +
    retiredTrust;
  await mkdir(f.codexHome);
  await writeFile(config, foreignConfig);
  f.run();
  const installed = JSON.parse(await readFile(record, 'utf8'));
  const descriptions = await Promise.all(
    names.map(
      async (name) =>
        decodePackagedAgent(
          await readFile(path.join(f.bundle, 'agents', `${name}.toml`), 'utf8'),
        ).description,
    ),
  );
  const legacyBlock =
    '# >>> pstack-codex managed agents v1\n' +
    `[agents.poteto-agent]\nconfig_file = ${JSON.stringify(path.join(f.codexHome, 'agents/poteto-agent.toml'))}\ndescription = ${JSON.stringify(descriptions[0])}\n\n` +
    `[agents.comment-sicko]\nconfig_file = ${JSON.stringify(path.join(f.codexHome, 'agents/comment-sicko.toml'))}\ndescription = ${JSON.stringify(descriptions[1])}\n\n` +
    '[agents.pstack-general-purpose]\ndescription = "General-purpose delegate for pstack workflows; follow the supplied task and model settings."\n' +
    '# <<< pstack-codex managed agents v1\n';
  await writeFile(config, foreignConfig + legacyBlock);
  await writeFile(
    record,
    `${JSON.stringify({ schemaVersion: 2, pluginName: 'pstack-codex', pluginVersion: '0.1.0-dev.10', agents: installed.agents, config: { block: legacyBlock, prefix: '', created: false } }, null, 2)}\n`,
  );
  const manifest = path.join(f.bundle, 'plugin.json');
  const nextManifest = JSON.parse(await readFile(manifest, 'utf8'));
  nextManifest.version = '0.1.0-dev.11';
  await writeFile(manifest, JSON.stringify(nextManifest));
  const candidate = path.join(f.bundle, 'agents/poteto-agent.toml');
  await writeFile(
    candidate,
    (await readFile(candidate, 'utf8')).replace(
      /^description = .*$/m,
      'description = "Updated bundle delegate"',
    ),
  );
  const boundaryControl = async (
    generation = 1,
    failAfterPersist = false,
    mode?: number,
  ) =>
    writeFile(control, JSON.stringify({ generation, failAfterPersist, mode }));
  await boundaryControl();
  await writeFile(
    f.helper,
    `import fs from 'node:fs';
const config = ${JSON.stringify(config)};
const control = ${JSON.stringify(control)};
const calls = ${JSON.stringify(calls)};
function appendRootTable(text, table) {
  const trailingComments = /(?:^|\\n)(#[^\\n]*(?:\\n#[^\\n]*)*\\n?)$/.exec(text);
  const index = trailingComments ? text.length - trailingComments[1].length : text.length;
  return text.slice(0, index) + '\\n' + table + text.slice(index);
}
function reconcile(operation) {
  fs.appendFileSync(calls, operation + '\\n');
  const { generation, failAfterPersist, mode } = JSON.parse(fs.readFileSync(control, 'utf8'));
  const before = fs.readFileSync(config, 'utf8');
  let text = before;
  const command = 'owned-boundary-generation-' + generation;
  const key = config + ':pre_tool_use:' + (generation + 1) + ':0';
  const header = '[hooks.state.' + JSON.stringify(key) + ']\\n';
  if (operation === 'trust' && !text.includes('command = ' + JSON.stringify(command))) {
    text = text.replace(/^PreToolUse = \\[(.*)\\]$/m, (_, hooks) => 'PreToolUse = [' + hooks + ', { matcher = "^Bash$", hooks = [{ type = "command", command = ' + JSON.stringify(command) + ', timeout = 5 }] }]');
  }
  if (operation === 'trust' && !text.includes(header)) {
    text = appendRootTable(text, header + 'trusted_hash = "sha256:generation-' + generation + '"\\n');
  }
  if (operation === 'retire') {
    for (let number = 1; number <= generation; number += 1) {
      const ownedHeader = '[hooks.state.' + JSON.stringify(config + ':pre_tool_use:' + (number + 1) + ':0') + ']\\n';
      if (text.includes(ownedHeader + 'enabled = false\\n')) continue;
      if (text.includes(ownedHeader)) {
        text = text.replace(ownedHeader, ownedHeader + 'enabled = false\\n');
      } else {
        text = appendRootTable(text, ownedHeader + 'enabled = false\\ntrusted_hash = "sha256:generation-' + number + '"\\n');
      }
    }
  }
  if (text !== before) fs.writeFileSync(config, text);
  if (mode !== undefined) fs.chmodSync(config, mode);
  if (failAfterPersist) throw new Error('Injected native failure after config persistence');
  return { status: operation === 'trust' ? 'active' : 'retired', hook: { key } };
}
export async function trustNativeBoundary() { return reconcile('trust'); }
export async function retireNativeBoundary() { return reconcile('retire'); }
`,
  );
  return {
    ...f,
    config,
    record,
    calls,
    settings,
    legacyBlock,
    boundaryControl,
  };
}

async function registrationSnapshot(
  f: Awaited<ReturnType<typeof historicalNativeRegistrationFixture>>,
) {
  return Promise.all(
    [
      f.record,
      ...names.map((name) => path.join(f.codexHome, 'agents', `${name}.toml`)),
    ].map(async (file) => ({
      file,
      bytes: await readFile(file),
      mode: (await stat(file)).mode & 0o777,
    })),
  );
}

function assertForeignHookBytes(config: string) {
  for (const bytes of [foreignHook, retiredHook, foreignTrust, retiredTrust])
    assert.ok(config.includes(bytes), `Preserve foreign config bytes ${bytes}`);
}

test('normal macOS upgrade accepts historical standalone markers after native root table insertion', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  assert.ok((await readFile(f.config, 'utf8')).endsWith(f.legacyBlock));
  const result = f.nativeInvoke();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.pluginVersion, '0.1.0-dev.11');
  assert.equal(receipt.commandBoundary.status, 'active');
  assert.equal(receipt.agents[0].status, 'updated');
  const config = await readFile(f.config, 'utf8');
  assert.ok(config.startsWith(f.settings));
  assertForeignHookBytes(config);
  assert.match(config, /trusted_hash = "sha256:generation-1"/);
  assert.match(config, /description = "Updated bundle delegate"/);
  for (const name of names)
    assert.deepEqual(
      await readFile(path.join(f.codexHome, 'agents', `${name}.toml`)),
      await readFile(path.join(f.bundle, 'agents', `${name}.toml`)),
    );
});

test('normal macOS registration and unregister preserve project trust already displaced inside historical markers', async (t) => {
  const projectTrust =
    '\n# native project trust\n[projects."/tmp/user-project"]\ntrust_level = "trusted"\n';
  for (const flags of [[], ['--unregister']]) {
    await t.test(flags.length ? 'unregister' : 'register', async (t) => {
      const f = await historicalNativeRegistrationFixture(t);
      const original = await readFile(f.config, 'utf8');
      await writeFile(
        f.config,
        original.replace(
          '# <<< pstack-codex managed agents v1\n',
          projectTrust + '# <<< pstack-codex managed agents v1\n',
        ),
      );
      const result = f.nativeInvoke(...flags);
      assert.equal(result.status, 0, result.stderr);
      const config = await readFile(f.config, 'utf8');
      assert.ok(config.startsWith(f.settings));
      assert.ok(config.includes(projectTrust));
      assertForeignHookBytes(config);
      assert.doesNotMatch(config, /pstack-codex managed agents v1/);
      if (flags.length) {
        await assertMissing(f.record);
        for (const name of names)
          await assertMissing(path.join(f.codexHome, 'agents', `${name}.toml`));
      } else {
        assert.equal(JSON.parse(result.stdout).agents[0].status, 'updated');
      }
    });
  }
});

test('normal macOS registration retains the post-boundary config mode', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  await chmod(f.config, 0o640);
  await f.boundaryControl(1, false, 0o600);
  const result = f.nativeInvoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(f.config)).mode & 0o777, 0o600);
});

test('normal macOS generations repeat and change before unregister preserves foreign hook trust and tombstones', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  const first = f.nativeInvoke();
  assert.equal(first.status, 0, first.stderr);
  const beforeRepeat = await readFile(f.config);
  const priorRegistration = await registrationSnapshot(f);
  const repeated = f.nativeInvoke();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(await readFile(f.config), beforeRepeat);
  assert.deepEqual(await registrationSnapshot(f), priorRegistration);
  await f.boundaryControl(2);
  const changed = f.nativeInvoke();
  assert.equal(changed.status, 0, changed.stderr);
  const config = await readFile(f.config, 'utf8');
  const repeatedChange = f.nativeInvoke();
  assert.equal(repeatedChange.status, 0, repeatedChange.stderr);
  assert.equal(await readFile(f.config, 'utf8'), config);
  assertForeignHookBytes(config);
  for (const generation of [1, 2]) {
    assert.equal(
      config.match(
        new RegExp(`command = "owned-boundary-generation-${generation}"`, 'g'),
      )?.length,
      1,
    );
    assert.equal(
      config.match(
        new RegExp(`trusted_hash = "sha256:generation-${generation}"`, 'g'),
      )?.length,
      1,
    );
  }
  const removed = f.nativeInvoke('--unregister');
  assert.equal(removed.status, 0, removed.stderr);
  const retired = await readFile(f.config, 'utf8');
  assertForeignHookBytes(retired);
  assert.ok(retired.startsWith(f.settings));
  for (const generation of [1, 2])
    assert.ok(
      retired.includes(
        `enabled = false\ntrusted_hash = "sha256:generation-${generation}"\n`,
      ),
    );
  assert.doesNotMatch(
    retired,
    /\[agents\.(?:poteto-agent|comment-sicko|pstack-general-purpose)\]/,
  );
  await assertMissing(f.record);
  for (const name of names)
    await assertMissing(path.join(f.codexHome, 'agents', `${name}.toml`));
});

test('normal macOS historical upgrade retries after native persistence without adopting or changing old registrations on failure', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  const before = await registrationSnapshot(f);
  await f.boundaryControl(1, true);
  const failed = f.nativeInvoke();
  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /Injected native failure after config persistence/,
  );
  assert.deepEqual(await registrationSnapshot(f), before);
  const persisted = await readFile(f.config, 'utf8');
  assertForeignHookBytes(persisted);
  assert.match(persisted, /trusted_hash = "sha256:generation-1"/);
  await f.boundaryControl();
  const retried = f.nativeInvoke();
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(
    await readFile(f.config, 'utf8'),
    /description = "Updated bundle delegate"/,
  );
});

test('normal macOS historical unregister retries after native tombstone persistence without unpublishing on failure', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  const before = await registrationSnapshot(f);
  await f.boundaryControl(1, true);
  const failed = f.nativeInvoke('--unregister');
  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /Injected native failure after config persistence/,
  );
  assert.deepEqual(await registrationSnapshot(f), before);
  const persisted = await readFile(f.config, 'utf8');
  assertForeignHookBytes(persisted);
  assert.match(
    persisted,
    /enabled = false\ntrusted_hash = "sha256:generation-1"/,
  );
  await f.boundaryControl();
  const retried = f.nativeInvoke('--unregister');
  assert.equal(retried.status, 0, retried.stderr);
  assertForeignHookBytes(await readFile(f.config, 'utf8'));
  await assertMissing(f.record);
  for (const name of names)
    await assertMissing(path.join(f.codexHome, 'agents', `${name}.toml`));
});

test('normal macOS failed historical upgrade rejects owned role edits comments and duplicate markers without writes', async (t) => {
  for (const { name, edit } of [
    {
      name: 'owned role value',
      edit: (text: string) =>
        text.replace('description = ', 'description = "user edit" # '),
    },
    {
      name: 'owned comment',
      edit: (text: string) =>
        text.replace(
          '[agents.poteto-agent]',
          '# owned comment edit\n[agents.poteto-agent]',
        ),
    },
    {
      name: 'duplicate opening marker',
      edit: (text: string) => text + '# >>> pstack-codex managed agents v1\n',
    },
    {
      name: 'duplicate closing marker',
      edit: (text: string) => text + '# <<< pstack-codex managed agents v1\n',
    },
    {
      name: 'extra owned key',
      edit: (text: string) =>
        text.replace(
          /(\[agents\.pstack-general-purpose\]\ndescription = [^\n]*\n)/,
          '$1model = "user-pinned"\n',
        ),
    },
    {
      name: 'owned subtable',
      edit: (text: string) =>
        text.replace(
          /(\[agents\.pstack-general-purpose\]\ndescription = [^\n]*\n)/,
          '$1[agents.pstack-general-purpose.user]\nvalue = true\n',
        ),
    },
    {
      name: 'close marker in a foreign multiline string',
      edit: (text: string) =>
        text.replace(
          '# <<< pstack-codex managed agents v1\n',
          "[user]\nnote = '''\n# <<< pstack-codex managed agents v1\n'''\n# <<< pstack-codex managed agents v1\n",
        ),
    },
    {
      name: 'unknown marker version',
      edit: (text: string) => text + '# <<< pstack-codex managed agents v42\n',
    },
  ]) {
    await t.test(name, async (t) => {
      const f = await historicalNativeRegistrationFixture(t);
      await f.boundaryControl(1, true);
      const failed = f.nativeInvoke();
      assert.match(
        failed.stderr,
        /Injected native failure after config persistence/,
      );
      const edited = edit(await readFile(f.config, 'utf8'));
      await writeFile(f.config, edited);
      const before = await registrationSnapshot(f);
      const mode = (await stat(f.config)).mode & 0o777;
      const calls = await readFile(f.calls);
      await f.boundaryControl();
      for (const flags of [[], ['--unregister']]) {
        const rejected = f.nativeInvoke(...flags);
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /modified|duplicated|ownership|marker/i);
        assert.equal(await readFile(f.config, 'utf8'), edited);
        assert.equal((await stat(f.config)).mode & 0o777, mode);
        assert.deepEqual(await registrationSnapshot(f), before);
        assert.deepEqual(await readFile(f.calls), calls);
      }
    });
  }
});

test('a missing v2 inline close rejects registration and removal without writes', async (t) => {
  const f = await historicalNativeRegistrationFixture(t);
  const installed = f.nativeInvoke();
  assert.equal(installed.status, 0, installed.stderr);
  const config = await readFile(f.config, 'utf8');
  const edited = config.replace(
    ' # <<< pstack-codex managed agents v2\n',
    '\n',
  );
  assert.notEqual(edited, config);
  await writeFile(f.config, edited);
  const before = await registrationSnapshot(f);
  const mode = (await stat(f.config)).mode & 0o777;
  const calls = await readFile(f.calls);
  for (const flags of [[], ['--unregister']]) {
    const rejected = f.nativeInvoke(...flags);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /modified|ownership|marker/i);
    assert.equal(await readFile(f.config, 'utf8'), edited);
    assert.equal((await stat(f.config)).mode & 0o777, mode);
    assert.deepEqual(await registrationSnapshot(f), before);
    assert.deepEqual(await readFile(f.calls), calls);
  }
});

test('normal macOS unregister retires the boundary and preserves its config tombstones', async (t) => {
  const f = await nativeRegistrationFixture(t);
  f.run();
  const evidence = path.join(f.root, 'retirement.json');
  await writeFile(
    f.helper,
    `import fs from 'node:fs';
export async function retireNativeBoundary(options) {
  fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({codexHome:options.codexHome,nativeRoles:options.nativeRoles}));
  fs.appendFileSync(options.codexHome+'/config.toml', '\\n[hooks.state.owned]\\nenabled = false\\n');
  return {status:'retired'};
}
`,
  );
  const result = f.nativeInvoke('--unregister');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).commandBoundary.status, 'retired');
  assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')), {
    codexHome: f.codexHome,
    nativeRoles: ['poteto-agent', 'comment-sicko', 'pstack-general-purpose'],
  });
  const config = await readFile(path.join(f.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[hooks\.state\.owned\]\nenabled = false/);
  assert.doesNotMatch(
    config,
    /\[agents\.(?:poteto-agent|comment-sicko|pstack-general-purpose)\]/,
  );
  await assertMissing(path.join(f.codexHome, 'agents/poteto-agent.toml'));
  await assertMissing(
    path.join(f.codexHome, 'pstack-codex/agent-registration.json'),
  );
});

test('normal macOS unregister checks all ownership before boundary retirement', async (t) => {
  for (const changed of ['config', 'agent']) {
    const f = await nativeRegistrationFixture(t);
    f.run();
    const marker = path.join(f.root, 'retired');
    await writeFile(
      f.helper,
      `import fs from 'node:fs'; export async function retireNativeBoundary() { fs.writeFileSync(${JSON.stringify(marker)}, 'retired'); return {status:'retired'}; }`,
    );
    const file = path.join(
      f.codexHome,
      changed === 'config' ? 'config.toml' : 'agents/comment-sicko.toml',
    );
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      changed === 'config'
        ? text.replace('description = ', '# changed\ndescription = ')
        : `${text}\n# changed\n`,
    );
    const result = f.nativeInvoke('--unregister');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /modified/);
    await assertMissing(marker);
    assert.equal(
      await readFile(file, 'utf8'),
      changed === 'config'
        ? text.replace('description = ', '# changed\ndescription = ')
        : `${text}\n# changed\n`,
    );
  }
});

test('an unsuccessful native retirement preserves every existing registration', async (t) => {
  const f = await nativeRegistrationFixture(t);
  f.run();
  const files = [
    'config.toml',
    'pstack-codex/agent-registration.json',
    ...names.map((name) => `agents/${name}.toml`),
  ];
  const before = await Promise.all(
    files.map((file) => readFile(path.join(f.codexHome, file))),
  );
  await writeFile(
    f.helper,
    "export async function retireNativeBoundary() { return {status:'boundary-unavailable'}; }\n",
  );
  const result = f.nativeInvoke('--unregister');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /boundary-unavailable/);
  for (const [index, file] of files.entries())
    assert.deepEqual(
      await readFile(path.join(f.codexHome, file)),
      before[index],
    );
});

test('a disabled or failed native boundary never updates or unpublishes existing registrations', async (t) => {
  for (const response of [
    "return {status:'boundary-user-disabled'}",
    "throw new Error('Native boundary unavailable')",
  ]) {
    const f = await nativeRegistrationFixture(t);
    f.run();
    const files = [
      'config.toml',
      'pstack-codex/agent-registration.json',
      ...names.map((name) => `agents/${name}.toml`),
    ];
    const before = await Promise.all(
      files.map((file) => readFile(path.join(f.codexHome, file))),
    );
    const source = path.join(f.bundle, 'agents/poteto-agent.toml');
    await writeFile(
      source,
      (await readFile(source, 'utf8')).replace(
        /^description = .*$/m,
        'description = "Candidate definition"',
      ),
    );
    await writeFile(
      f.helper,
      `export async function trustNativeBoundary() { ${response}; }\n`,
    );
    const result = f.nativeInvoke();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /boundary-user-disabled|Native boundary unavailable/,
    );
    for (const [index, file] of files.entries())
      assert.deepEqual(
        await readFile(path.join(f.codexHome, file)),
        before[index],
      );
  }
});

test('definition-only and dry-run operations never activate or retire native hooks', async (t) => {
  const f = await nativeRegistrationFixture(t);
  await writeFile(
    f.helper,
    "throw new Error('Fixture must not activate a runtime hook');\n",
  );
  for (const flags of [
    ['--dry-run'],
    ['--definitions-only'],
    ['--dry-run', '--unregister'],
    ['--definitions-only', '--unregister'],
  ]) {
    const result = f.nativeInvoke(...flags);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).commandBoundary.status,
      'notChecked',
    );
  }
});
