import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compactPatchSeries } from '../src/distribution/compact.ts';
import {
  generatePatch,
  generateSharedPatch,
  verifyPatches,
} from '../src/distribution/patches.ts';
import { copyTree, inspectTree } from '../src/distribution/tree.ts';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import type { TargetId } from '../src/distribution/targets.ts';

const targets = ['codex', 'claude-code'] as const;
const outputFor = (project: string, target: TargetId) =>
  path.join(project, target === 'codex' ? 'plugin' : 'plugin-claude');
const how = 'skills/how/SKILL.md';
const runner = 'skills/poteto-mode/scripts/run-pi.mjs';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-compact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const upstream = path.join(project, 'upstream/pstack');
  const runtime = path.join(project, 'upstream/codex-runtime');
  const source: Record<string, string> = {
    '.cursor-plugin/plugin.json': JSON.stringify({
      name: 'pstack',
      version: '1.0.0',
    }),
    LICENSE: 'MIT License\nCopyright Lauren Tan\n',
    'README.md': 'Upstream readme\n',
    [how]: 'Upstream how\n',
    'skills/arena/SKILL.md': 'Upstream arena\nSecond line\n',
    'skills/old/SKILL.md': 'Upstream old\n',
    'skills/poteto-mode/SKILL.md': 'Upstream poteto-mode\n',
    'skills/setup-pstack/SKILL.md': 'Upstream setup\n',
    'docs/guide/README.md': 'Upstream guide\n',
    'skills/poteto-mode/references/execution.md': 'Upstream execution\n',
    'skills/poteto-mode/scripts/tool.sh': '#!/bin/sh\n',
  };
  for (const [file, text] of Object.entries(source)) {
    await mkdir(path.dirname(path.join(upstream, file)), { recursive: true });
    await writeFile(path.join(upstream, file), text);
  }
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
        ].map((file) => ({
          source: file,
          target: `vendor/codex-plugin-cc/${file}`,
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
    await writeFile(
      path.join(
        project,
        target === 'codex' ? 'patches' : 'patches/claude',
        'series',
      ),
      '',
    );
    const output = outputFor(project, target);
    const record = (name: string, paths?: string[]) =>
      generatePatch(project, name, paths, target);
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
    await writeFile(path.join(output, 'README.md'), `${target} readme\n`);
    await record('0001-native.patch');
    await writeFile(
      path.join(output, 'skills/arena/SKILL.md'),
      `${target} arena\nSecond line\n`,
    );
    await writeFile(
      path.join(output, 'skills/poteto-mode/references/execution.md'),
      `${target} execution\n`,
    );
    for (const file of [
      'skills/poteto-mode/SKILL.md',
      'skills/setup-pstack/SKILL.md',
      'docs/guide/README.md',
      'agents/worker.md',
      'skills/arena/agents/openai.yaml',
      'skills/setup-pstack/agents/openai.yaml',
      ...(target === 'claude-code' ? ['vendor/codex-plugin-cc/NOTICE'] : []),
    ]) {
      await mkdir(path.dirname(path.join(output, file)), { recursive: true });
      await writeFile(path.join(output, file), `${target} ${file}\n`);
    }
    await record('0002-workflows.patch');
    await writeFile(
      path.join(output, 'skills/arena/SKILL.md'),
      `${target} arena\nSecond ${target} line\n`,
    );
    await chmod(path.join(output, 'skills/poteto-mode/scripts/tool.sh'), 0o755);
    await mkdir(path.join(output, 'assets'));
    await writeFile(
      path.join(output, 'assets/icon.bin'),
      Buffer.from([0, 255, 1, 254]),
    );
    await rm(path.join(output, 'skills/old'), { recursive: true });
    await record('0003-overlap.patch');
    await rm(path.join(output, how));
    await record('0004-transfer.patch', [how]);
  }
  await writeFile(path.join(outputFor(project, 'codex'), how), 'Shared how\n');
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0001-how.patch',
    paths: [how],
  });
  await writeFile(
    path.join(outputFor(project, 'claude-code'), how),
    'Shared how\nFollow-up\n',
  );
  await generateSharedPatch(project, {
    from: 'claude-code',
    name: '0002-how-followup.patch',
    paths: [how],
  });
  await writeFile(path.join(outputFor(project, 'codex'), runner), 'runner\n');
  await generateSharedPatch(project, {
    from: 'codex',
    name: '0003-runner.patch',
    paths: [runner],
  });
  return { root, project };
}

const digests = async (project: string) =>
  Promise.all(
    targets.map(
      async (target) => (await verifyPatches(project, target)).digest,
    ),
  );

test('compaction gives every changed path one patch and replays to the same trees', async (t) => {
  const { root, project } = await fixture(t);
  const before = await digests(project);
  const original = await inspectTree(path.join(project, 'patches'));
  const output = path.join(root, 'compacted');
  const report = await compactPatchSeries(project, output);

  assert.deepEqual(await inspectTree(path.join(project, 'patches')), original);
  assert.deepEqual(
    report.targets.map((result) => [
      result.target,
      result.originalPatches,
      result.digest,
    ]),
    [
      ['codex', 7, before[0]],
      ['claude-code', 7, before[1]],
    ],
  );
  assert.deepEqual(report.targets[0]!.series, [
    {
      name: '0001-identity-and-distribution.patch',
      paths: ['README.md', 'assets/icon.bin', 'plugin.json'],
    },
    {
      name: '0002-agents-and-invocation.patch',
      paths: [
        'agents/worker.md',
        'skills/arena/agents/openai.yaml',
        'skills/setup-pstack/agents/openai.yaml',
      ],
    },
    {
      name: '0003-setup-and-models.patch',
      paths: ['skills/setup-pstack/SKILL.md'],
    },
    {
      name: '0004-poteto-mode-references-and-scripts.patch',
      paths: [
        'skills/poteto-mode/references/execution.md',
        'skills/poteto-mode/scripts/tool.sh',
      ],
    },
    {
      name: '0005-poteto-mode-playbooks.patch',
      paths: ['skills/poteto-mode/SKILL.md'],
    },
    {
      name: '0006-workflow-skills.patch',
      paths: ['skills/arena/SKILL.md', 'skills/old/SKILL.md'],
    },
    { name: '0007-guides.patch', paths: ['docs/guide/README.md'] },
    { name: 'shared/0001-workflow-bodies.patch', paths: [how] },
    { name: 'shared/0002-worker-execution.patch', paths: [runner] },
  ]);
  assert.deepEqual(
    report.targets[1]!.series.map((patch) => patch.name),
    [
      ...report.targets[0]!.series.slice(0, 7).map((patch) => patch.name),
      '0008-vendored-codex-runtime.patch',
      'shared/0001-workflow-bodies.patch',
      'shared/0002-worker-execution.patch',
    ],
  );
  assert.deepEqual(report.targets[1]!.series[7]!.paths, [
    'vendor/codex-plugin-cc/NOTICE',
  ]);
  for (const result of report.targets) {
    const paths = result.series.flatMap((patch) => patch.paths);
    assert.equal(new Set(paths).size, paths.length);
  }

  await rm(path.join(project, 'patches'), { recursive: true });
  await copyTree(path.join(output, 'patches'), path.join(project, 'patches'));
  assert.deepEqual(await digests(project), before);

  const again = path.join(root, 'again');
  await compactPatchSeries(project, again);
  assert.deepEqual(
    await inspectTree(path.join(again, 'patches')),
    await inspectTree(path.join(output, 'patches')),
  );
});

test('compaction refuses a changed path that no theme owns', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, 'plugin/notes.txt'), 'Unowned\n');
  await generatePatch(project, '0005-notes.patch', ['notes.txt']);
  const output = path.join(root, 'compacted');
  await assert.rejects(
    compactPatchSeries(project, output),
    /No target theme owns notes\.txt/,
  );
  assert.equal(existsSync(output), false);
});

test('compaction refuses a shared path whose bodies differ between targets', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(
    path.join(project, 'plugin-claude', how),
    'Claude-only how\n',
  );
  await generatePatch(project, '0005-diverge.patch', [how], 'claude-code');
  const output = path.join(root, 'compacted');
  await assert.rejects(
    compactPatchSeries(project, output),
    /Shared path differs between targets: skills\/how\/SKILL\.md/,
  );
  assert.equal(existsSync(output), false);
});

test('compaction refuses a shared path that only one target still changes', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, 'plugin', how), 'Upstream how\n');
  await generatePatch(project, '0005-restore.patch', [how]);
  const output = path.join(root, 'compacted');
  await assert.rejects(
    compactPatchSeries(project, output),
    /Shared path is changed in claude-code only: skills\/how\/SKILL\.md/,
  );
  assert.equal(existsSync(output), false);
});

test('compaction refuses a tree the current series does not reproduce', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(project, 'plugin/README.md'), 'Unrecorded\n');
  await assert.rejects(
    compactPatchSeries(project, path.join(root, 'compacted')),
    /Patch replay differs from plugin bytes or modes: README\.md/,
  );
});
