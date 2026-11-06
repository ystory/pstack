import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  generatePatch,
  generateSharedPatch,
  readPatchSeries,
  runGit,
  verifyPatches,
} from '../src/distribution/patches.ts';
import { regenerateCandidatePatches } from '../src/distribution/regenerate.ts';
import {
  buildDistributionArtifact,
  verifyDistributionArtifact,
} from '../src/distribution/products.ts';
import { copyTree, inspectTree } from '../src/distribution/tree.ts';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import { createUpstreamCandidate } from '../src/upstream/candidate.ts';
import type { TargetId } from '../src/distribution/targets.ts';

const targets = ['codex', 'claude-code'] as const;
const outputFor = (project: string, target: TargetId) =>
  path.join(project, target === 'codex' ? 'plugin' : 'plugin-claude');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const upstream = path.join(project, 'upstream/pstack');
  const runtime = path.join(project, 'upstream/codex-runtime');
  await mkdir(path.join(upstream, '.cursor-plugin'), { recursive: true });
  await writeFile(
    path.join(upstream, '.cursor-plugin/plugin.json'),
    JSON.stringify({ name: 'pstack', version: '1.0.0' }),
  );
  await writeFile(
    path.join(upstream, 'LICENSE'),
    'MIT License\nCopyright Lauren Tan\n',
  );
  await writeFile(path.join(upstream, 'procedure.md'), 'Original procedure\n');
  await writeFile(
    path.join(upstream, 'portable.md'),
    'Original portable steps\n',
  );
  await mkdir(path.join(runtime, 'plugins/codex/.claude-plugin'), {
    recursive: true,
  });
  await writeFile(
    path.join(runtime, 'plugins/codex/.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'codex', version: '1.0.6' }),
  );
  await writeFile(path.join(runtime, 'LICENSE'), 'Apache License\n');
  await writeFile(path.join(runtime, 'NOTICE'), 'Runtime notice\n');
  await writeFile(
    path.join(project, 'codex-runtime.lock.json'),
    JSON.stringify({
      schemaVersion: 1,
      codexRuntime: {
        repository: 'https://github.com/openai/codex-plugin-cc',
        revision: '3'.repeat(40),
        version: '1.0.6',
        snapshotSha256: await computeSnapshotDigest(runtime),
        files: [
          'LICENSE',
          'NOTICE',
          'plugins/codex/.claude-plugin/plugin.json',
        ].map((source) => ({
          source,
          target: `vendor/codex-plugin-cc/${source}`,
        })),
      },
    }),
  );
  await writeFile(
    path.join(project, 'upstream.lock.json'),
    JSON.stringify({
      schemaVersion: 1,
      pstack: {
        repository: 'https://github.com/cursor/plugins',
        ref: 'main',
        path: 'pstack',
        revision: '1'.repeat(40),
        pathRevision: '1'.repeat(40),
        version: '1.0.0',
        snapshotSha256: await computeSnapshotDigest(upstream),
      },
      codex: {
        repository: 'https://github.com/openai/codex',
        ref: 'main',
        sourceRevision: '2'.repeat(40),
        testedVersions: [],
      },
    }),
  );
  await mkdir(path.join(project, 'patches/claude'), { recursive: true });
  for (const target of targets) {
    const patchDirectory = target === 'codex' ? 'patches' : 'patches/claude';
    await writeFile(path.join(project, patchDirectory, 'series'), '');
    const output = outputFor(project, target);
    await copyPristinePlugin(project, output, target);
    const manifest =
      target === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json';
    await mkdir(path.dirname(path.join(output, manifest)), { recursive: true });
    await writeFile(
      path.join(output, manifest),
      JSON.stringify({
        name: target === 'codex' ? 'pstack-codex' : 'pstack-cc',
        version: '1.0.0',
        license: 'MIT',
      }),
    );
    await writeFile(path.join(output, 'procedure.md'), `${target} dispatch\n`);
    await generatePatch(project, '0001-native.patch', undefined, target);
  }
  return { root, project, upstream };
}

async function shareProcedure(project: string) {
  for (const target of targets) {
    await rm(path.join(outputFor(project, target), 'procedure.md'));
    await generatePatch(
      project,
      '0002-transfer.patch',
      ['procedure.md'],
      target,
    );
  }
  await writeFile(
    path.join(outputFor(project, 'codex'), 'procedure.md'),
    'Shared procedure\nKeep original review\n',
  );
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0001-procedure.patch',
    paths: ['procedure.md'],
  });
}

async function candidateFixture(project: string, root: string) {
  const candidate = path.join(root, 'candidate');
  await copyTree(project, candidate);
  await writeFile(
    path.join(candidate, 'candidate-report.json'),
    JSON.stringify({
      status: 'patch-conflict',
      conflict: 'reviewed source',
      unappliedPatches: ['shared/0001-procedure.patch'],
    }),
  );
  return candidate;
}

async function installRegenerated(candidate: string, root: string) {
  const output = path.join(root, 'regenerated');
  await regenerateCandidatePatches(candidate, output);
  await rm(path.join(candidate, 'patches'), { recursive: true });
  await copyTree(path.join(output, 'patches'), path.join(candidate, 'patches'));
  for (const target of targets) await verifyPatches(candidate, target);
  return output;
}

test('one common edit materializes both outputs without changing historical patches or unrelated work', async (t) => {
  const { project } = await fixture(t);
  const before = await readFile(
    path.join(project, 'patches/0001-native.patch'),
  );
  const other = outputFor(project, 'claude-code');
  await writeFile(path.join(other, 'unrelated.txt'), 'Keep personal work\n');
  await shareProcedure(project);
  assert.equal(
    await readFile(path.join(other, 'procedure.md'), 'utf8'),
    'Shared procedure\nKeep original review\n',
  );
  assert.equal(
    await readFile(path.join(other, 'unrelated.txt'), 'utf8'),
    'Keep personal work\n',
  );
  assert.deepEqual(
    await readFile(path.join(project, 'patches/0001-native.patch')),
    before,
  );
  for (const target of targets)
    assert.equal(
      (await readPatchSeries(project, target)).at(-1)?.name,
      'shared/0001-procedure.patch',
    );
  await generatePatch(
    project,
    '0003-unrelated.patch',
    ['unrelated.txt'],
    'claude-code',
  );
  for (const target of targets) await verifyPatches(project, target);
});

test('shared followups preserve binary bytes executable mode and deletion with native patches interleaved', async (t) => {
  const { project, root } = await fixture(t);
  await shareProcedure(project);
  const source = outputFor(project, 'claude-code');
  await writeFile(
    path.join(source, 'worker.bin'),
    Buffer.from([0, 255, 1, 23]),
  );
  await chmod(path.join(source, 'worker.bin'), 0o755);
  await generateSharedPatch(project, {
    from: 'claude-code',
    name: '0002-worker.patch',
    paths: ['worker.bin'],
  });
  await writeFile(path.join(source, 'native.txt'), 'Only Claude\n');
  await generatePatch(
    project,
    '0003-native.patch',
    ['native.txt'],
    'claude-code',
  );
  await rm(path.join(outputFor(project, 'codex'), 'worker.bin'));
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0003-remove-worker.patch',
    paths: ['worker.bin'],
  });
  for (const target of targets) {
    const artifact = path.join(root, target);
    const metadata = await buildDistributionArtifact(project, artifact, target);
    assert.ok(
      metadata.patches.some((p) => p.name === 'shared/0002-worker.patch'),
    );
    await verifyDistributionArtifact(artifact);
    await verifyPatches(project, target);
  }
  await installRegenerated(await candidateFixture(project, root), root);
});

test('a conflicting shared edit writes no patch or series and preserves the other dirty file', async (t) => {
  const { project } = await fixture(t);
  await shareProcedure(project);
  const series = await readFile(path.join(project, 'patches/series'));
  await writeFile(
    path.join(outputFor(project, 'codex'), 'procedure.md'),
    'New shared procedure\n',
  );
  await writeFile(
    path.join(outputFor(project, 'claude-code'), 'procedure.md'),
    'Unrecorded other edit\n',
  );
  await assert.rejects(
    generateSharedPatch(project, {
      from: 'codex',
      name: '0002-conflict.patch',
      paths: ['procedure.md'],
    }),
    /unrecorded|differs|conflict/i,
  );
  assert.deepEqual(
    await readFile(path.join(project, 'patches/series')),
    series,
  );
  await assert.rejects(
    readFile(path.join(project, 'patches/shared/0002-conflict.patch')),
    /ENOENT/,
  );
  assert.equal(
    await readFile(
      path.join(outputFor(project, 'claude-code'), 'procedure.md'),
      'utf8',
    ),
    'Unrecorded other edit\n',
  );
});

test('candidate regeneration keeps edited whole workflow content in a single shared patch', async (t) => {
  const { project, root } = await fixture(t);
  const localFile = path.join(project, 'patches/0001-native.patch');
  await writeFile(
    localFile,
    (await readFile(localFile, 'utf8')).replace(
      /^index [a-f0-9]+\.\.[a-f0-9]+/gm,
      'index 1111111..2222222',
    ),
  );
  await shareProcedure(project);
  const candidate = await candidateFixture(project, root);
  for (const target of targets)
    await writeFile(
      path.join(outputFor(candidate, target), 'procedure.md'),
      'Reviewed shared procedure\nKeep original review\n',
    );
  const before = await readFile(
    path.join(candidate, 'patches/0001-native.patch'),
  );
  const output = await installRegenerated(candidate, root);
  assert.deepEqual(
    await readFile(path.join(output, 'patches/0001-native.patch')),
    before,
  );
  const common = await readFile(
    path.join(output, 'patches/shared/0001-procedure.patch'),
    'utf8',
  );
  assert.match(common, /Reviewed shared procedure/);
  assert.doesNotMatch(
    await readFile(path.join(output, 'patches/0001-native.patch'), 'utf8'),
    /Reviewed shared procedure/,
  );
});

test('regeneration preserves shared followup ownership modes and mixed local order', async (t) => {
  const { project, root } = await fixture(t);
  await shareProcedure(project);
  const source = outputFor(project, 'codex');
  await writeFile(
    path.join(source, 'procedure.md'),
    'Shared procedure\nKeep original review\nReport outcome\n',
  );
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0002-outcome.patch',
    paths: ['procedure.md'],
  });
  await chmod(path.join(source, 'procedure.md'), 0o755);
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0003-mode.patch',
    paths: ['procedure.md'],
  });
  const candidate = await candidateFixture(project, root);
  for (const target of targets)
    await writeFile(
      path.join(outputFor(candidate, target), 'procedure.md'),
      'Shared procedure\nKeep original review\nReport measured outcome\n',
    );
  const output = await installRegenerated(candidate, root);
  const records = await readPatchSeries(candidate);
  assert.deepEqual(
    records.filter((p) => p.name.startsWith('shared/')).map((p) => p.name),
    [
      'shared/0001-procedure.patch',
      'shared/0002-outcome.patch',
      'shared/0003-mode.patch',
    ],
  );
  assert.match(
    await readFile(
      path.join(output, 'patches/shared/0002-outcome.patch'),
      'utf8',
    ),
    /Report measured outcome/,
  );
});

test('upstream candidates carry one shared source and identify a bridge conflict instead of overwriting upstream', async (t) => {
  const { project, root, upstream } = await fixture(t);
  for (const target of targets) {
    await rm(path.join(outputFor(project, target), 'portable.md'));
    await generatePatch(
      project,
      '0002-transfer.patch',
      ['portable.md'],
      target,
    );
  }
  await writeFile(
    path.join(outputFor(project, 'codex'), 'portable.md'),
    'Portable original steps\n',
  );
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0001-portable.patch',
    paths: ['portable.md'],
  });
  const source = path.join(root, 'source');
  await copyTree(upstream, path.join(source, 'pstack'));
  await writeFile(path.join(source, 'pstack/extra.txt'), 'Next source\n');
  runGit(source, ['init', '--quiet']);
  runGit(source, [
    'remote',
    'add',
    'origin',
    'https://github.com/cursor/plugins.git',
  ]);
  runGit(source, ['add', '--all']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'source',
  ]);
  const output = path.join(root, 'next');
  await createUpstreamCandidate(
    project,
    source,
    runGit(source, ['rev-parse', 'HEAD']).trim(),
    output,
  );
  assert.deepEqual(
    await readFile(path.join(output, 'patches/shared/0001-portable.patch')),
    await readFile(path.join(project, 'patches/shared/0001-portable.patch')),
  );
  for (const target of targets) await verifyPatches(output, target);
  await writeFile(
    path.join(source, 'pstack/portable.md'),
    'Original portable steps\nNew upstream step\n',
  );
  runGit(source, ['add', '--all']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'changed procedure',
  ]);
  const conflict = path.join(root, 'conflict');
  assert.equal(
    (
      await createUpstreamCandidate(
        project,
        source,
        runGit(source, ['rev-parse', 'HEAD']).trim(),
        conflict,
      )
    ).status,
    'patch-conflict',
  );
  const report = JSON.parse(
    await readFile(path.join(conflict, 'candidate-report.json'), 'utf8'),
  );
  assert.equal(report.targets[0].failedPatch, '0002-transfer.patch');
  assert.ok((await inspectTree(path.join(conflict, 'plugin'))).length > 0);
});

test('unresolvable intermediate intent names the shared node and leaves candidate evidence untouched', async (t) => {
  const { project, root } = await fixture(t);
  await shareProcedure(project);
  await writeFile(
    path.join(outputFor(project, 'codex'), 'procedure.md'),
    'Shared procedure\nKeep original review\nReport outcome\n',
  );
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0002-outcome.patch',
    paths: ['procedure.md'],
  });
  const candidate = await candidateFixture(project, root);
  await writeFile(
    path.join(candidate, 'upstream/pstack/procedure.md'),
    'Changed source context\n',
  );
  const lockFile = path.join(candidate, 'upstream.lock.json');
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  lock.pstack.snapshotSha256 = await computeSnapshotDigest(
    path.join(candidate, 'upstream/pstack'),
  );
  await writeFile(lockFile, JSON.stringify(lock));
  for (const target of targets)
    await writeFile(
      path.join(outputFor(candidate, target), 'procedure.md'),
      'Shared procedure\nKeep original review\nNew reviewed outcome\n',
    );
  const before = await inspectTree(candidate);
  const output = path.join(root, 'unresolved');
  await assert.rejects(
    regenerateCandidatePatches(candidate, output),
    /Cannot reconstruct candidate intermediate before shared\/0002-outcome.patch.*procedure.md/,
  );
  assert.deepEqual(await inspectTree(candidate), before);
  await assert.rejects(
    readFile(path.join(output, 'regeneration-report.json')),
    /ENOENT/,
  );
});

for (const removeDirectory of [true, false]) {
  test(`shared deletion prunes empty ancestors in both outputs after source ${removeDirectory ? 'directory removal' : 'file removal'}`, async (t) => {
    const { project } = await fixture(t);
    const source = outputFor(project, 'codex');
    const file = 'skills/review-fixture/deep/only.md';
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), 'Shared nested file\n');
    if (!removeDirectory)
      await writeFile(
        path.join(source, 'skills/retained.md'),
        'Keep sibling\n',
      );
    await generateSharedPatch(project, {
      from: 'codex',
      name: '0001-nested.patch',
      paths: ['skills'],
    });
    if (removeDirectory)
      await rm(path.join(source, 'skills/review-fixture'), { recursive: true });
    else await rm(path.join(source, file));
    await generateSharedPatch(project, {
      from: 'codex',
      name: '0002-remove-nested.patch',
      paths: ['skills/review-fixture'],
    });
    for (const target of targets) {
      const output = outputFor(project, target);
      await assert.rejects(
        readdir(path.join(output, 'skills/review-fixture')),
        {
          code: 'ENOENT',
        },
      );
      if (removeDirectory)
        await assert.rejects(readdir(path.join(output, 'skills')), {
          code: 'ENOENT',
        });
      else
        assert.equal(
          await readFile(path.join(output, 'skills/retained.md'), 'utf8'),
          'Keep sibling\n',
        );
      await verifyPatches(project, target);
    }
  });
}

test('shared CLI generation and regeneration work with a temporary directory inside a Git repository', async (t) => {
  const { project, root } = await fixture(t);
  const repository = path.join(root, 'temporary-repository');
  const temporary = path.join(repository, '.local/tmp');
  await mkdir(temporary, { recursive: true });
  runGit(repository, ['init', '--quiet']);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const invoke = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: repository,
      env: { ...process.env, TMPDIR: temporary },
      encoding: 'utf8',
    });
  await writeFile(
    path.join(outputFor(project, 'codex'), 'portable.md'),
    'Shared portable steps\n',
  );
  const generated = invoke([
    'generate-shared-patch',
    '--project',
    project,
    '--from',
    'codex',
    '--name',
    '0001-portable.patch',
    '--paths',
    'portable.md',
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  for (const target of targets) await verifyPatches(project, target);
  const candidate = await candidateFixture(project, root);
  const regenerated = path.join(root, 'regenerated-in-repository');
  const result = invoke([
    'regenerate-patches',
    '--candidate',
    candidate,
    '--output',
    regenerated,
  ]);
  assert.equal(result.status, 0, result.stderr);
  await rm(path.join(candidate, 'patches'), { recursive: true });
  await copyTree(
    path.join(regenerated, 'patches'),
    path.join(candidate, 'patches'),
  );
  for (const target of targets) await verifyPatches(candidate, target);
});

test('candidate conflict attribution keeps distinct local and shared patch identities with the same basename', async (t) => {
  const { project, root, upstream } = await fixture(t);
  await writeFile(
    path.join(outputFor(project, 'codex'), 'portable.md'),
    'Shared portable steps\n',
  );
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0001-native.patch',
    paths: ['portable.md'],
  });
  const source = path.join(root, 'same-name-source');
  await copyTree(upstream, path.join(source, 'pstack'));
  await writeFile(
    path.join(source, 'pstack/portable.md'),
    'Changed upstream portable steps\n',
  );
  runGit(source, ['init', '--quiet']);
  runGit(source, [
    'remote',
    'add',
    'origin',
    'https://github.com/cursor/plugins.git',
  ]);
  runGit(source, ['add', '--all']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'changed portable source',
  ]);
  const output = path.join(root, 'same-name-candidate');
  await createUpstreamCandidate(
    project,
    source,
    runGit(source, ['rev-parse', 'HEAD']).trim(),
    output,
  );
  const report = JSON.parse(
    await readFile(path.join(output, 'candidate-report.json'), 'utf8'),
  );
  for (const target of report.targets) {
    assert.equal(target.failedPatch, 'shared/0001-native.patch');
    assert.deepEqual(target.appliedPatches, ['0001-native.patch']);
    assert.deepEqual(target.unappliedPatches, ['shared/0001-native.patch']);
  }
});

for (const from of targets) {
  test(`local CLI preserves non-UTF-8 text and changed context for ${from}`, async (t) => {
    const { project } = await fixture(t);
    const file = path.join(outputFor(project, from), 'latin.txt');
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    for (const [name, bytes] of [
      ['0002-latin.patch', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
      ['0003-latin-edit.patch', Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a])],
    ] as const) {
      await writeFile(file, bytes);
      await chmod(file, 0o755);
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'generate-patch',
          '--project',
          project,
          '--target',
          from,
          '--name',
          name,
          '--paths',
          'latin.txt',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      await verifyPatches(project, from);
      assert.deepEqual(await readFile(file), bytes);
    }
  });

  test(`shared CLI and reviewed regeneration preserve non-UTF-8 text from ${from}`, async (t) => {
    const { project, root } = await fixture(t);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(path.join(outputFor(project, from), 'latin.txt'), bytes);
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'generate-shared-patch',
        '--project',
        project,
        '--from',
        from,
        '--name',
        '0001-latin.patch',
        '--paths',
        'latin.txt',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const target of targets) {
      assert.deepEqual(
        await readFile(path.join(outputFor(project, target), 'latin.txt')),
        bytes,
      );
      await verifyPatches(project, target);
    }
    const candidate = await candidateFixture(project, root);
    const reviewed = Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]);
    for (const target of targets)
      await writeFile(
        path.join(outputFor(candidate, target), 'latin.txt'),
        reviewed,
      );
    const remainder = Buffer.from([0x72, 0xe7, 0x0a]);
    await writeFile(
      path.join(outputFor(candidate, from), 'remainder.txt'),
      remainder,
    );
    const output = await installRegenerated(candidate, root);
    for (const target of targets)
      assert.deepEqual(
        await readFile(path.join(outputFor(candidate, target), 'latin.txt')),
        reviewed,
      );
    assert.deepEqual(
      await readFile(path.join(outputFor(candidate, from), 'remainder.txt')),
      remainder,
    );
    assert.ok(
      (
        await readFile(path.join(output, 'patches/shared/0001-latin.patch'))
      ).includes(reviewed),
    );
  });

  test(`shared CLI records file-directory transitions from ${from} and regenerates each intermediate patch`, async (t) => {
    const { project, root } = await fixture(t);
    const source = outputFor(project, from);
    const other = outputFor(
      project,
      from === 'codex' ? 'claude-code' : 'codex',
    );
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const record = (name: string, paths = 'transition') => {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'generate-shared-patch',
          '--project',
          project,
          '--from',
          from,
          '--name',
          name,
          '--paths',
          paths,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
    };
    const transition = path.join(source, 'transition');
    await writeFile(transition, Buffer.from([0, 1, 255]));
    await chmod(transition, 0o755);
    record('0001-file.patch');
    await rm(transition);
    await mkdir(path.join(transition, 'nested'), { recursive: true });
    const binary = Buffer.from([0, 2, 254, 10]);
    await writeFile(path.join(transition, 'nested/child.bin'), binary);
    await chmod(path.join(transition, 'nested/child.bin'), 0o755);
    await writeFile(path.join(transition, 'second.md'), 'Second leaf\n');
    if (from === 'claude-code') {
      await rm(path.join(other, 'transition'));
      await mkdir(path.join(other, 'transition/nested'), { recursive: true });
      await writeFile(path.join(other, 'transition/nested/child.bin'), binary);
      await chmod(path.join(other, 'transition/nested/child.bin'), 0o755);
    }
    record('0002-directory.patch');
    for (const target of targets) {
      assert.deepEqual(
        await readFile(
          path.join(outputFor(project, target), 'transition/nested/child.bin'),
        ),
        binary,
      );
      await verifyPatches(project, target);
    }
    await writeFile(
      path.join(transition, 'nested/child.bin'),
      Buffer.from([0, 3, 253, 10]),
    );
    await chmod(path.join(transition, 'nested/child.bin'), 0o644);
    record('0003-child-edit.patch');
    await rm(transition, { recursive: true });
    await writeFile(transition, 'Returned file\n');
    await chmod(transition, 0o755);
    record('0004-file.patch', 'transition/nested/child.bin,transition');
    await writeFile(transition, 'Final file\n');
    record('0005-followup.patch');
    for (const target of targets) {
      assert.equal(
        await readFile(
          path.join(outputFor(project, target), 'transition'),
          'utf8',
        ),
        'Final file\n',
      );
      await verifyPatches(project, target);
    }
    const before = await inspectTree(path.join(project, 'patches'));
    const output = await installRegenerated(
      await candidateFixture(project, root),
      root,
    );
    assert.deepEqual(await inspectTree(path.join(output, 'patches')), before);
  });

  test(`shared directory-to-file transition from ${from} preserves a blocking unrecorded descendant before publication`, async (t) => {
    const { project } = await fixture(t);
    const source = outputFor(project, from);
    const other = outputFor(
      project,
      from === 'codex' ? 'claude-code' : 'codex',
    );
    await mkdir(path.join(source, 'transition'));
    await writeFile(path.join(source, 'transition/owned.md'), 'Recorded\n');
    await generateSharedPatch(project, {
      from,
      name: '0001-directory.patch',
      paths: ['transition'],
    });
    await writeFile(path.join(other, 'transition/personal.md'), 'Keep work\n');
    await rm(path.join(source, 'transition'), { recursive: true });
    await writeFile(path.join(source, 'transition'), 'Intended file\n');
    const before = await inspectTree(project);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'generate-shared-patch',
        '--project',
        project,
        '--from',
        from,
        '--name',
        '0002-file.patch',
        '--paths',
        'transition',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ENOTEMPTY|not empty|conflict/i);
    assert.deepEqual(await inspectTree(project), before);
  });
}

test('parallel CLI replay consumes each complete large patch input', async (t) => {
  const { project, root } = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const copy = path.join(root, `parallel-${index}`);
      await copyTree(project, copy);
      const bytes = Buffer.from(
        `Worker ${index}\n${'Large finite patch input\n'.repeat(6000)}`,
      );
      await writeFile(path.join(copy, 'plugin/large.txt'), bytes);
      for (const args of [
        [
          'generate-patch',
          '--name',
          '0002-large.patch',
          '--paths',
          'large.txt',
        ],
        ['verify-patches'],
      ]) {
        const child = spawn(
          process.execPath,
          [cli, ...args, '--project', copy],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const stderr: Buffer[] = [];
        child.stdout.resume();
        child.stderr.on('data', (data) => stderr.push(data));
        const status = await new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        assert.equal(status, 0, Buffer.concat(stderr).toString());
      }
      assert.deepEqual(
        await readFile(path.join(copy, 'plugin/large.txt')),
        bytes,
      );
    }),
  );
});
