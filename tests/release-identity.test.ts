import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { distributionTarget } from '../src/distribution/targets.ts';
import type { TargetId } from '../src/distribution/targets.ts';

const script = fileURLToPath(
  new URL('../scripts/check-release-identity.ts', import.meta.url),
);
const targets: TargetId[] = ['codex', 'claude-code'];

function git(project: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
}

function commit(project: string, stage = true) {
  if (stage) git(project, ['add', '--all']);
  git(project, [
    '-c',
    'user.name=Release fixture',
    '-c',
    'user.email=release-fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'Release fixture',
  ]);
  return git(project, ['rev-parse', 'HEAD']);
}

async function manifest(project: string, target: TargetId, version: unknown) {
  const definition = distributionTarget(target);
  const file = path.join(
    project,
    definition.pluginDirectory,
    definition.manifest,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ name: definition.name, version }));
}

async function fixture(t: TestContext, version = '1.0.0-dev.2') {
  const project = await mkdtemp(
    path.join(os.tmpdir(), 'pstack release identity '),
  );
  t.after(() => rm(project, { recursive: true, force: true }));
  git(project, ['init', '--quiet']);
  git(project, ['config', 'core.fileMode', 'true']);
  for (const target of targets) {
    await manifest(project, target, version);
    await writeFile(
      path.join(
        project,
        distributionTarget(target).pluginDirectory,
        'value.txt',
      ),
      'original\n',
    );
  }
  return { project, base: commit(project) };
}

function check(project: string, base: string, head?: string) {
  return spawnSync(
    process.execPath,
    [
      script,
      '--base',
      base,
      '--project',
      project,
      ...(head ? ['--head', head] : []),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
}

function passes(result: ReturnType<typeof check>) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function fails(result: ReturnType<typeof check>, message: RegExp) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}

test('release check compares committed snapshots and can rerun unchanged releases', async (t) => {
  const { project, base } = await fixture(t);
  await writeFile(path.join(project, 'notes.md'), 'Repository-only change.\n');
  const head = commit(project);
  await writeFile(path.join(project, 'plugin/value.txt'), 'uncommitted\n');
  const receipt = passes(check(project, base));
  assert.equal(receipt.baseCommit, base);
  assert.equal(receipt.headCommit, head);
  assert.deepEqual(
    receipt.targets.map((entry: { target: string; changed: boolean }) => [
      entry.target,
      entry.changed,
    ]),
    [
      ['codex', false],
      ['claude-code', false],
    ],
  );
  for (const entry of receipt.targets) {
    assert.equal(entry.before.target, entry.target);
    assert.equal(entry.after.target, entry.target);
    assert.equal(entry.before.version, '1.0.0-dev.2');
    assert.equal(entry.after.version, '1.0.0-dev.2');
    assert.equal(
      entry.before.treeSha,
      git(project, [
        'rev-parse',
        `${base}:${distributionTarget(entry.target).pluginDirectory}`,
      ]),
    );
    assert.equal(entry.after.treeSha, entry.before.treeSha);
  }
  assert.deepEqual(passes(check(project, base, head)), receipt);
});

for (const target of targets) {
  test(`${target} payload change requires its own version increase even when the other target increases`, async (t) => {
    const { project, base } = await fixture(t);
    await writeFile(
      path.join(
        project,
        distributionTarget(target).pluginDirectory,
        'value.txt',
      ),
      'changed\n',
    );
    const other = target === 'codex' ? 'claude-code' : 'codex';
    await manifest(project, other, '1.0.0-dev.3');
    fails(
      check(project, base, commit(project)),
      new RegExp(`${target}.*strictly increas`, 'i'),
    );
  });
}

test('both changed targets pass with independent version increases', async (t) => {
  const { project, base } = await fixture(t);
  await manifest(project, 'codex', '1.0.0-dev.3');
  await manifest(project, 'claude-code', '2.0.0');
  const receipt = passes(check(project, base, commit(project)));
  assert.deepEqual(
    receipt.targets.map((entry: { changed: boolean }) => entry.changed),
    [true, true],
  );
});

test('only the affected target needs a version increase', async (t) => {
  const { project, base } = await fixture(t);
  await manifest(project, 'claude-code', '1.0.0-dev.3');
  const receipt = passes(check(project, base, commit(project)));
  assert.deepEqual(
    receipt.targets.map((entry: { changed: boolean }) => entry.changed),
    [false, true],
  );
});

for (const [before, after, allowed] of [
  ['1.0.0-dev.2', '1.0.0-dev.10', true],
  ['1.0.0-alpha', '1.0.0-alpha.1', true],
  ['1.0.0-alpha.1', '1.0.0-alpha.beta', true],
  ['1.0.0-rc.1', '1.0.0', true],
  ['99999999999999999999.0.0', '100000000000000000000.0.0', true],
  ['1.0.0-dev.10', '1.0.0-dev.2', false],
  ['1.0.0', '1.0.0-rc.1', false],
  ['2.0.0', '1.9.9', false],
  ['1.0.0+first', '1.0.0+second', false],
] as const) {
  test(`SemVer precedence ${before} to ${after} ${allowed ? 'passes' : 'fails'}`, async (t) => {
    const { project, base } = await fixture(t, before);
    await manifest(project, 'codex', after);
    const result = check(project, base, commit(project));
    if (allowed) passes(result);
    else fails(result, /codex.*strictly increas/i);
  });
}

for (const version of [
  'v1.0.0',
  '01.0.0',
  '1.0',
  '1.0.0-dev.01',
  '1.0.0-',
  '1.0.0+',
]) {
  test(`invalid SemVer ${version} fails`, async (t) => {
    const { project, base } = await fixture(t);
    await manifest(project, 'codex', version);
    fails(check(project, base, commit(project)), /codex.*invalid.*SemVer/i);
  });
}

test('invalid baseline version fails instead of accepting a new valid version', async (t) => {
  const { project, base } = await fixture(t, 'not-a-version');
  await manifest(project, 'codex', '1.0.0');
  await manifest(project, 'claude-code', '1.0.0');
  fails(check(project, base, commit(project)), /invalid.*SemVer/i);
});

for (const change of ['mode', 'type'] as const) {
  test(`Git ${change} changes count as payload changes`, async (t) => {
    const { project, base } = await fixture(t);
    const file = path.join(project, 'plugin/value.txt');
    if (change === 'mode')
      git(project, ['update-index', '--chmod=+x', '--', 'plugin/value.txt']);
    else {
      await rm(file);
      await symlink('plugin.json', file);
    }
    const head = commit(project, change !== 'mode');
    fails(check(project, base, head), /codex.*strictly increas/i);
  });
}

for (const target of targets) {
  for (const missing of ['manifest', 'target'] as const) {
    for (const side of ['base', 'head'] as const) {
      test(`${target} missing ${missing} at ${side} fails explicitly`, async (t) => {
        const { project, base } = await fixture(t);
        const definition = distributionTarget(target);
        await rm(
          path.join(
            project,
            definition.pluginDirectory,
            ...(missing === 'manifest' ? [definition.manifest] : []),
          ),
          { recursive: true, force: true },
        );
        const removed = commit(project);
        fails(
          check(
            project,
            side === 'base' ? removed : base,
            side === 'base' ? base : removed,
          ),
          new RegExp(`${target}.*(missing|requires)`, 'i'),
        );
      });
    }
  }
}

test('malformed and mismatched manifest identities fail', async (t) => {
  const { project, base } = await fixture(t);
  await writeFile(path.join(project, 'plugin/plugin.json'), '{');
  fails(check(project, base, commit(project)), /codex.*manifest/i);
  await writeFile(
    path.join(project, 'plugin/plugin.json'),
    JSON.stringify({ name: 'another-plugin', version: '2.0.0' }),
  );
  fails(check(project, base, commit(project)), /codex.*identity/i);
});

test('historical same-version changes do not prevent a valid release above the supplied baseline', async (t) => {
  const { project } = await fixture(t, '0.1.0-dev.10');
  await writeFile(
    path.join(project, 'plugin/value.txt'),
    'historical collision\n',
  );
  const base = commit(project);
  await manifest(project, 'codex', '0.1.0-dev.11');
  passes(check(project, base, commit(project)));
});

test('missing or option-shaped baseline cannot produce a passing receipt', async (t) => {
  const { project } = await fixture(t);
  fails(check(project, 'missing-baseline'), /base.*commit/i);
  fails(check(project, '--all'), /base.*commit/i);
  const result = spawnSync(process.execPath, [script, '--project', project], {
    encoding: 'utf8',
  });
  fails(result, /--base/);
});

test('missing head fails and project paths must be absolute', async (t) => {
  const { project, base } = await fixture(t);
  fails(check(project, base, 'missing-head'), /head.*commit/i);
  fails(check('.', base), /--project.*absolute/i);
});
