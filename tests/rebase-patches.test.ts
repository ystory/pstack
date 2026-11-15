import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  applyPatchBytes,
  generatePatch,
  generateSharedPatch,
  verifyPatches,
} from '../src/distribution/patches.ts';
import {
  rebaseCandidatePatches,
  unexplainedAdditions,
} from '../src/distribution/rebase.ts';
import { regenerateCandidatePatches } from '../src/distribution/regenerate.ts';
import { moveOntoSource } from '../src/distribution/transport.ts';
import { copyTree, inspectTree } from '../src/distribution/tree.ts';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import type { TargetId } from '../src/distribution/targets.ts';

const targets = ['codex', 'claude-code'] as const;
const treeFor = (project: string, target: TargetId) =>
  path.join(project, target === 'codex' ? 'plugin' : 'plugin-claude');
const patchesFor = (project: string, target: TargetId) =>
  path.join(project, target === 'codex' ? 'patches' : 'patches/claude');
const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');
const numbered = (
  line: (index: number) => string,
  changed: Record<number, string> = {},
) =>
  text(
    ...Array.from(
      { length: 24 },
      (_, index) => changed[index + 1] ?? line(index + 1),
    ),
  );

const guide = (lines: string[]) =>
  text('# Guide', '', 'Intro line stays.', '', ...lines, '', 'Closing.');
const oldSource = {
  'guide.md': guide([
    'Use the cursor agent for review.',
    'Run the cursor explorer first.',
    'Report the outcome in chat.',
    'Keep notes in the cursor folder.',
  ]),
  'procedure.md': numbered((index) => `Step ${index}: cursor work ${index}.`),
  'playbook.md': numbered((index) => `Rule ${index}: cursor habit ${index}.`),
  'reference.md': numbered((index) => `Entry ${index}: cursor fact ${index}.`),
  'retired.md': text('Retired cursor note.'),
  'legacy/old-name.md': text('Renamed body.'),
};
const newSource = {
  // Upstream edits the review line, deletes the explorer line, and edits the report line.
  'guide.md': guide([
    'Use the cursor agent for careful review.',
    'Report the outcome in the thread.',
    'Keep notes in the cursor folder.',
  ]),
  'procedure.md': numbered((index) => `Step ${index}: cursor work ${index}.`, {
    3: 'Step 3: upstream reworked this step.',
  }),
  'playbook.md': numbered((index) => `Rule ${index}: cursor habit ${index}.`, {
    5: 'Rule 5: upstream reworked this rule.',
  }),
  'reference.md': numbered((index) => `Topic ${index}: rewritten ${index}.`),
  'notes.md': text('Upstream notes.'),
};
// Both adaptation-owned bodies keep a line verbatim that upstream later edits.
const sharedPlaybook = numbered((index) =>
  index <= 6
    ? `Rule ${index}: cursor habit ${index}.`
    : `Portable rule ${index}.`,
);
const sharedProcedure = text(
  'Shared procedure',
  'Step 3: cursor work 3.',
  'Step one.',
  'Step two.',
);
const movedGuide = (host: string, followup: string[] = []) =>
  host === 'codex'
    ? guide([
        'Use the codex agent for review.',
        'Report the outcome in the thread.',
        'Keep notes in the codex folder.',
        ...followup,
      ])
    : guide([
        'Use the claude agent for review.',
        'Report the outcome in the thread.',
        'Keep notes in the cursor folder.',
      ]);

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

async function pinSource(project: string) {
  const file = path.join(project, 'upstream.lock.json');
  const lock = JSON.parse(await readFile(file, 'utf8'));
  lock.pstack.snapshotSha256 = await computeSnapshotDigest(
    path.join(project, 'upstream/pstack'),
  );
  await writeFile(file, JSON.stringify(lock));
}

async function pinnedProject(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-rebase-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const upstream = path.join(project, 'upstream/pstack');
  const runtime = path.join(project, 'upstream/codex-runtime');
  await writeFiles(upstream, {
    ...oldSource,
    '.cursor-plugin/plugin.json': JSON.stringify({
      name: 'pstack',
      version: '1.0.0',
    }),
    LICENSE: 'MIT License\nCopyright Lauren Tan\n',
  });
  const runtimeFiles = [
    'LICENSE',
    'NOTICE',
    'plugins/codex/.claude-plugin/plugin.json',
  ];
  await writeFiles(runtime, {
    LICENSE: 'Apache License\n',
    NOTICE: 'Runtime notice\n',
    'plugins/codex/.claude-plugin/plugin.json': JSON.stringify({
      name: 'codex',
      version: '1.0.6',
    }),
  });
  await writeFiles(project, {
    'codex-runtime.lock.json': JSON.stringify({
      schemaVersion: 1,
      codexRuntime: {
        repository: 'https://github.com/openai/codex-plugin-cc',
        revision: '3'.repeat(40),
        version: '1.0.6',
        snapshotSha256: await computeSnapshotDigest(runtime),
        files: runtimeFiles.map((source) => ({
          source,
          target: `vendor/codex-plugin-cc/${source}`,
        })),
      },
    }),
    'upstream.lock.json': JSON.stringify({
      schemaVersion: 1,
      pstack: {
        repository: 'https://github.com/cursor/plugins',
        ref: 'main',
        path: 'pstack',
        revision: '1'.repeat(40),
        pathRevision: '1'.repeat(40),
        version: '1.0.0',
        snapshotSha256: '0'.repeat(64),
      },
      codex: {
        repository: 'https://github.com/openai/codex',
        ref: 'main',
        sourceRevision: '2'.repeat(40),
        testedVersions: [],
      },
    }),
    'patches/series': '',
    'patches/claude/series': '',
  });
  await pinSource(project);

  for (const target of targets) {
    const tree = treeFor(project, target);
    const host = target === 'codex' ? 'codex' : 'claude';
    await copyPristinePlugin(project, tree, target);
    await writeFiles(tree, {
      [target === 'codex' ? 'plugin.json' : '.claude-plugin/plugin.json']:
        JSON.stringify({
          name: target === 'codex' ? 'pstack-codex' : 'pstack-cc',
          version: '1.0.0',
          license: 'MIT',
        }),
      // Codex edits three lines, Claude only the review line.
      'guide.md':
        target === 'codex'
          ? oldSource['guide.md'].replaceAll('cursor', 'codex')
          : oldSource['guide.md'].replace('cursor agent', `${host} agent`),
    });
    await generatePatch(project, '0001-native.patch', undefined, target);
    await rm(path.join(tree, 'procedure.md'));
    await generatePatch(project, '0002-transfer.patch', undefined, target);
  }
  const codex = treeFor(project, 'codex');
  const share = async (name: string, file: string, content: string) => {
    await writeFile(path.join(codex, file), content);
    await generateSharedPatch(project, { from: 'codex', name, paths: [file] });
  };
  await share('0001-procedure.patch', 'procedure.md', sharedProcedure);
  for (const target of targets) {
    await writeFile(
      path.join(treeFor(project, target), 'playbook.md'),
      sharedPlaybook,
    );
    await generatePatch(project, '0003-playbook.patch', undefined, target);
  }
  await share(
    '0002-playbook-note.patch',
    'playbook.md',
    `${sharedPlaybook}Portable note.\n`,
  );

  await writeFile(
    path.join(project, 'patches/0004-rename.patch'),
    text(
      'diff --git a/legacy/old-name.md b/docs/new-name.md',
      'similarity index 100%',
      'rename from legacy/old-name.md',
      'rename to docs/new-name.md',
    ),
  );
  await appendFile(path.join(project, 'patches/series'), '0004-rename.patch\n');
  await mkdir(path.join(codex, 'docs'));
  await rename(
    path.join(codex, 'legacy/old-name.md'),
    path.join(codex, 'docs/new-name.md'),
  );
  await rmdir(path.join(codex, 'legacy'));

  await writeFiles(codex, {
    'retired.md': text('Retired codex note.'),
    'reference.md': oldSource['reference.md'].replace(
      'cursor fact 7.',
      'codex fact 7.',
    ),
  });
  await generatePatch(project, '0005-retired.patch');
  await writeFile(path.join(codex, 'notes.md'), text('Codex notes.'));
  await generatePatch(project, '0006-notes.patch');
  await writeFile(
    path.join(codex, 'guide.md'),
    (await readFile(path.join(codex, 'guide.md'), 'utf8')).replace(
      'codex folder.\n',
      'codex folder.\nAsk before pushing.\n',
    ),
  );
  await generatePatch(project, '0007-guide-followup.patch');
  await share(
    '0003-outcome.patch',
    'procedure.md',
    `${sharedProcedure}Report the outcome.\n`,
  );
  for (const target of targets) await verifyPatches(project, target);
  return { root, project };
}

// The candidate carries the new source and both reviewed final trees, with the pinned series.
async function reviewedCandidate(t: TestContext) {
  const { root, project } = await pinnedProject(t);
  const candidate = path.join(root, 'candidate');
  await copyTree(project, candidate);
  const upstream = path.join(candidate, 'upstream/pstack');
  await writeFiles(upstream, newSource);
  await rm(path.join(upstream, 'retired.md'));
  await pinSource(candidate);
  const refreshed = sharedProcedure.replace(
    'Step two.',
    'Step two, with evidence.',
  );
  for (const target of targets) {
    const tree = treeFor(candidate, target);
    await rm(path.join(tree, 'retired.md'));
    await writeFiles(tree, {
      'guide.md':
        target === 'codex'
          ? movedGuide('codex', ['Ask before pushing or publishing.'])
          : movedGuide('claude'),
      'procedure.md': `${refreshed}Report the outcome.\n`,
      'reference.md': newSource['reference.md'],
      ...(target === 'codex' ? {} : { 'notes.md': newSource['notes.md'] }),
    });
  }
  return { root, project, candidate };
}

const series = async (root: string, target: TargetId) =>
  (await readFile(path.join(patchesFor(root, target), 'series'), 'utf8'))
    .split('\n')
    .filter(Boolean);
const patch = (root: string, target: TargetId, name: string) =>
  readFile(
    name.startsWith('shared/')
      ? path.join(root, 'patches', name)
      : path.join(patchesFor(root, target), name),
  );

test('rebase moves each historical change onto the changed source and records the update in refresh patches', async (t) => {
  const { root, project, candidate } = await reviewedCandidate(t);
  await assert.rejects(
    regenerateCandidatePatches(candidate, path.join(root, 'regenerated')),
    /Cannot reconstruct candidate intermediate.*rebase-patches/s,
  );
  const before = await inspectTree(candidate);
  const output = path.join(root, 'rebased');
  const result = await rebaseCandidatePatches(project, candidate, output);
  assert.deepEqual(await inspectTree(candidate), before);
  assert.equal(result.unexplainedAdditions, 0);
  assert.equal(
    result.sharedRefresh,
    'shared/0004-upstream-1-0-0-refresh.patch',
  );

  assert.deepEqual(await series(output, 'codex'), [
    '0001-native.patch',
    '0002-transfer.patch',
    'shared/0001-procedure.patch',
    '0003-playbook.patch',
    'shared/0002-playbook-note.patch',
    '0004-rename.patch',
    '0006-notes.patch',
    '0007-guide-followup.patch',
    'shared/0003-outcome.patch',
    'shared/0004-upstream-1-0-0-refresh.patch',
    '0008-upstream-1-0-0-refresh.patch',
  ]);
  assert.deepEqual(await series(output, 'claude-code'), [
    '0001-native.patch',
    '0002-transfer.patch',
    'shared/0001-procedure.patch',
    '0003-playbook.patch',
    'shared/0002-playbook-note.patch',
    'shared/0003-outcome.patch',
    'shared/0004-upstream-1-0-0-refresh.patch',
  ]);

  const report = JSON.parse(
    await readFile(path.join(output, 'rebase-report.json'), 'utf8'),
  );
  const expected = {
    codex: {
      kept: [
        'shared/0001-procedure.patch',
        'shared/0002-playbook-note.patch',
        '0004-rename.patch',
        'shared/0003-outcome.patch',
      ],
      regenerated: [
        '0001-native.patch',
        '0002-transfer.patch',
        '0003-playbook.patch',
        '0006-notes.patch',
        '0007-guide-followup.patch',
      ],
      dropped: ['0005-retired.patch'],
    },
    'claude-code': {
      kept: [
        'shared/0001-procedure.patch',
        'shared/0002-playbook-note.patch',
        'shared/0003-outcome.patch',
      ],
      regenerated: [
        '0001-native.patch',
        '0002-transfer.patch',
        '0003-playbook.patch',
      ],
      dropped: [],
    },
  };
  for (const [index, target] of targets.entries()) {
    const groups: { name: string; status: string }[] =
      report.targets[index].groups;
    const source = path.join(root, `source-${target}`);
    await copyPristinePlugin(candidate, source, target);
    const sourceLines = new Set<string>();
    for (const entry of await inspectTree(source))
      if (entry.kind === 'file')
        for (const line of (
          await readFile(path.join(source, entry.path), 'latin1')
        ).split('\n'))
          sourceLines.add(line);
    for (const status of ['kept', 'regenerated', 'dropped'] as const)
      assert.deepEqual(
        new Set(
          groups
            .filter((group) => group.status === status)
            .map((group) => group.name),
        ),
        new Set(expected[target][status]),
        `${target} ${status}`,
      );
    for (const name of expected[target].kept)
      assert.deepEqual(
        await patch(output, target, name),
        await patch(project, target, name),
        `${target} ${name} keeps its bytes`,
      );
    // The rewritten playbook is adaptation-owned, so it keeps the line upstream later edited.
    for (const name of expected[target].regenerated)
      assert.deepEqual(
        unexplainedAdditions(
          await patch(output, target, name),
          await patch(project, target, name),
          sourceLines,
        ),
        name === '0003-playbook.patch' ? ['Rule 5: cursor habit 5.'] : [],
        `${target} ${name} adds only what it added before`,
      );

    // Replaying the historical patches alone shows each change moved, without the update's edits.
    const replay = path.join(root, `replay-${target}`);
    await copyPristinePlugin(candidate, replay, target);
    for (const name of await series(output, target))
      if (!name.includes('refresh'))
        applyPatchBytes(replay, await patch(output, target, name));
    assert.equal(
      await readFile(path.join(replay, 'guide.md'), 'utf8'),
      target === 'codex'
        ? movedGuide('codex', ['Ask before pushing.'])
        : movedGuide('claude'),
    );
    assert.equal(
      await readFile(path.join(replay, 'procedure.md'), 'utf8'),
      `${sharedProcedure}Report the outcome.\n`,
    );
    assert.equal(
      await readFile(path.join(replay, 'playbook.md'), 'utf8'),
      `${sharedPlaybook}Portable note.\n`,
    );
  }

  const native = (await patch(output, 'codex', '0001-native.patch')).toString();
  assert.match(
    native,
    /-Use the cursor agent for careful review\.\n\+Use the codex agent for review\.\n Report the outcome in the thread\.\n-Keep notes in the cursor folder\.\n\+Keep notes in the codex folder\.\n/,
  );
  assert.doesNotMatch(native, /explorer/);
  const transfer = (
    await patch(output, 'claude-code', '0002-transfer.patch')
  ).toString();
  assert.match(transfer, /^-Step 3: upstream reworked this step\.$/m);
  assert.doesNotMatch(transfer, /^\+[^+]/m);
  assert.match(
    (await patch(output, 'codex', '0003-playbook.patch')).toString(),
    /^-Rule 5: upstream reworked this rule\.$/m,
  );
  assert.match(
    (await patch(output, 'codex', '0006-notes.patch')).toString(),
    /-Upstream notes\.\n\+Codex notes\.\n/,
  );

  const refresh = (name: string) =>
    patch(output, 'codex', name).then((bytes) =>
      bytes
        .toString()
        .split('\n')
        .filter((line) => /^[+-][^+-]/.test(line)),
    );
  assert.deepEqual(await refresh('shared/0004-upstream-1-0-0-refresh.patch'), [
    '-Step two.',
    '+Step two, with evidence.',
  ]);
  assert.deepEqual(await refresh('0008-upstream-1-0-0-refresh.patch'), [
    '-Ask before pushing.',
    '+Ask before pushing or publishing.',
  ]);
  assert.equal(report.targets[1].refreshPatch, null);

  await rm(path.join(candidate, 'patches'), { recursive: true });
  await copyTree(path.join(output, 'patches'), path.join(candidate, 'patches'));
  for (const target of targets) await verifyPatches(candidate, target);
});

test('candidate targets with different shared bodies stop the rebase before any output', async (t) => {
  const { root, project, candidate } = await reviewedCandidate(t);
  await appendFile(
    path.join(treeFor(candidate, 'claude-code'), 'procedure.md'),
    'Claude only step.\n',
  );
  const output = path.join(root, 'rebased');
  await assert.rejects(
    rebaseCandidatePatches(project, candidate, output),
    /Candidate targets differ in shared bodies \(procedure\.md\)/,
  );
  await assert.rejects(readFile(path.join(output, 'rebase-report.json')), {
    code: 'ENOENT',
  });
});

test('rebase CLI names the refresh patches and leaves the pinned series unchanged', async (t) => {
  const { root, project, candidate } = await reviewedCandidate(t);
  const pinned = await inspectTree(project);
  const output = path.join(root, 'rebased');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'rebase-patches',
      '--project',
      project,
      '--candidate',
      candidate,
      '--output',
      output,
      '--name',
      'reviewed-source',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Rebased codex onto pstack 1\.0\.0: 4 kept, 5 regenerated, 1 dropped, refresh shared\/0004-reviewed-source\.patch and 0008-reviewed-source\.patch/,
  );
  assert.match(
    result.stdout,
    /Rebased claude-code onto pstack 1\.0\.0: 3 kept, 3 regenerated, 0 dropped, refresh shared\/0004-reviewed-source\.patch;/,
  );
  assert.deepEqual(await inspectTree(project), pinned);
  assert.equal(
    (await series(output, 'codex')).at(-1),
    '0008-reviewed-source.patch',
  );
});

test('an upstream replacement counts as an edit only when it still resembles the line', async () => {
  const move = async (adapted: string, old: string, next: string) =>
    (
      await moveOntoSource(
        Buffer.from(adapted),
        Buffer.from(old),
        Buffer.from(next),
      )
    ).bytes.toString();
  assert.equal(
    await move(
      'Run the codex agent.\n',
      'Run the cursor agent.\n',
      'Run the cursor agent first.\nThen report.\n',
    ),
    'Run the codex agent.\nThen report.\n',
  );
  // Unrelated replacement text is an upstream deletion plus new lines, so the edit has no referent.
  assert.equal(
    await move(
      'Run the codex agent.\n',
      'Run the cursor agent.\n',
      'Trace code directly.\nThen report.\n',
    ),
    'Trace code directly.\nThen report.\n',
  );
});

test('line reconciliation keeps non-UTF-8 bytes, marker-like text, and the final newline state', async () => {
  const lines = (...values: Buffer[]) =>
    Buffer.concat(
      values.map((value) => Buffer.concat([value, Buffer.from('\n')])),
    );
  const marker = Buffer.from('<'.repeat(48));
  const invalid = Buffer.from([0xff, 0x20, 0x6f, 0x6c, 0x64]);
  const old = lines(marker, invalid, Buffer.from('shared line one'));
  const adapted = lines(
    marker,
    Buffer.from([0xff, 0x20, 0x6f, 0x75, 0x72, 0x73]),
    Buffer.from('shared line one'),
  );
  const next = lines(
    marker,
    Buffer.from([0xff, 0x20, 0x6f, 0x6c, 0x64, 0x20, 0x6e, 0x65, 0x77]),
    Buffer.from('shared line one, upstream'),
  );
  const moved = await moveOntoSource(adapted, old, next);
  assert.equal(moved.conflicts, 1);
  assert.deepEqual(
    moved.bytes,
    lines(
      marker,
      Buffer.from([0xff, 0x20, 0x6f, 0x75, 0x72, 0x73]),
      Buffer.from('shared line one, upstream'),
    ),
  );
  const unterminated = await moveOntoSource(
    Buffer.from('ours'),
    Buffer.from('base'),
    Buffer.from('theirs'),
  );
  assert.equal(unterminated.bytes.toString(), 'ours');
  assert.equal(
    (
      await moveOntoSource(
        Buffer.from('kept\nours'),
        Buffer.from('kept\nbase'),
        Buffer.from('kept\ntheirs\n'),
      )
    ).bytes.toString(),
    'kept\nours\n',
  );
  assert.equal(
    (
      await moveOntoSource(
        Buffer.from('top\nkept'),
        Buffer.from('base\nkept'),
        Buffer.from('base\nkept'),
      )
    ).bytes.toString(),
    'top\nkept',
  );
});
