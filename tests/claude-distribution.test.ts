import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  buildDistributionArtifact,
  verifyDistributionArtifact,
} from '../src/distribution/products.ts';
import {
  generatePatch,
  readPatchSeries,
  runGit,
  verifyPatches,
} from '../src/distribution/patches.ts';
import { copyTree, inspectTree } from '../src/distribution/tree.ts';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import {
  validateCodexRuntimeLock,
  verifyCodexRuntime,
} from '../src/upstream/runtime.ts';
import { promotePluginArtifact } from '../src/distribution/marketplace.ts';
import { createUpstreamCandidate } from '../src/upstream/candidate.ts';
import { regenerateCandidatePatches } from '../src/distribution/regenerate.ts';
import type { CodexRuntimeLock } from '../src/upstream/runtime.ts';
import { checkUpstream } from '../src/upstream/check.ts';
import { readLock } from '../src/upstream/lock.ts';
import { projectTargets } from '../src/distribution/targets.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-dual-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const upstream = path.join(project, 'upstream', 'pstack');
  const runtime = path.join(project, 'upstream', 'codex-runtime');
  await mkdir(path.join(upstream, '.cursor-plugin'), { recursive: true });
  await writeFile(
    path.join(upstream, '.cursor-plugin', 'plugin.json'),
    JSON.stringify({ name: 'pstack', version: '1.0.0' }),
  );
  await writeFile(
    path.join(upstream, 'LICENSE'),
    'MIT License\nCopyright Lauren Tan\n',
  );
  await writeFile(path.join(upstream, 'original.txt'), 'Unadapted source\n');
  await mkdir(path.join(runtime, 'scripts'), { recursive: true });
  await writeFile(
    path.join(runtime, 'LICENSE'),
    'Apache License\nVersion 2.0\n',
  );
  await writeFile(
    path.join(runtime, 'NOTICE'),
    'Official runtime attribution\n',
  );
  await writeFile(
    path.join(runtime, 'scripts', 'worker.mjs'),
    '#!/usr/bin/env node\nconsole.log("runtime");\n',
  );
  await chmod(path.join(runtime, 'scripts', 'worker.mjs'), 0o755);
  await mkdir(path.join(runtime, 'plugins/codex/.claude-plugin'), {
    recursive: true,
  });
  await writeFile(
    path.join(runtime, 'plugins/codex/.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'codex', version: '1.0.6' }),
  );
  const runtimeLock: CodexRuntimeLock = {
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
        'scripts/worker.mjs',
      ].map((source) => ({
        source,
        target: `vendor/codex-plugin-cc/${source}`,
      })),
    },
  };
  await writeFile(
    path.join(project, 'codex-runtime.lock.json'),
    JSON.stringify(runtimeLock),
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
  await mkdir(path.join(project, 'patches', 'claude'), { recursive: true });
  for (const directory of ['patches', 'patches/claude'])
    await writeFile(path.join(project, directory, 'series'), '');
  await copyPristinePlugin(project, path.join(project, 'plugin'));
  await writeFile(
    path.join(project, 'plugin', 'plugin.json'),
    JSON.stringify({
      name: 'pstack-for-codex',
      version: '1.0.0',
      license: 'MIT',
    }),
  );
  await writeFile(
    path.join(project, 'plugin', 'original.txt'),
    'Codex adaptation\n',
  );
  await generatePatch(project, '0001-codex.patch');
  await copyPristinePlugin(
    project,
    path.join(project, 'plugin-claude'),
    'claude-code',
  );
  await mkdir(path.join(project, 'plugin-claude', '.claude-plugin'));
  await writeFile(
    path.join(project, 'plugin-claude', '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'pstack-cc',
      version: '1.0.0',
      license: 'MIT',
    }),
  );
  await writeFile(
    path.join(project, 'plugin-claude', 'original.txt'),
    'Claude adaptation\n',
  );
  await generatePatch(project, '0001-claude.patch', undefined, 'claude-code');
  return { root, project, upstream, runtime, runtimeLock };
}

test('two products replay independent pristine baselines and append only their own patch series', async (t) => {
  const { project } = await fixture(t);
  const before = await readFile(
    path.join(project, 'patches', '0001-codex.patch'),
  );
  const codex = await verifyPatches(project);
  assert.equal(codex.patches.length, 1);
  const claude = await verifyPatches(project, 'claude-code');
  assert.notEqual(codex.digest, claude.digest);
  assert.equal(
    await readFile(path.join(project, 'plugin-claude', 'original.txt'), 'utf8'),
    'Claude adaptation\n',
  );
  assert.equal(
    await readFile(
      path.join(
        project,
        'plugin-claude',
        'vendor/codex-plugin-cc/scripts/worker.mjs',
      ),
      'utf8',
    ),
    '#!/usr/bin/env node\nconsole.log("runtime");\n',
  );
  await writeFile(
    path.join(project, 'plugin-claude', 'new.bin'),
    Buffer.from([0, 255, 1]),
  );
  await generatePatch(project, '0002-binary.patch', undefined, 'claude-code');
  await verifyPatches(project, 'claude-code');
  assert.deepEqual(
    await readFile(path.join(project, 'patches', '0001-codex.patch')),
    before,
  );
  assert.deepEqual(
    (await readPatchSeries(project)).map((patch) => patch.name),
    ['0001-codex.patch'],
  );
  assert.deepEqual(await verifyPatches(project), codex);
});

test('Claude artifacts are deterministic, resolve native marketplace sources and preserve runtime provenance and modes', async (t) => {
  const { root, project, runtimeLock } = await fixture(t);
  const a = path.join(root, 'a');
  const first = await buildDistributionArtifact(project, a, 'claude-code');
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.name, 'pstack-cc');
  if (first.schemaVersion !== 2) throw new Error('Expected Claude artifact.');
  assert.deepEqual(first.codexRuntime, runtimeLock);
  assert.equal(
    first.entries.find(
      (entry) => entry.path === 'vendor/codex-plugin-cc/scripts/worker.mjs',
    )?.mode,
    0o755,
  );
  assert.deepEqual(
    await buildDistributionArtifact(
      project,
      path.join(root, 'b'),
      'claude-code',
    ),
    first,
  );
  assert.deepEqual(await verifyDistributionArtifact(a), first);
  await promotePluginArtifact(a, root);
  const marketplace = JSON.parse(
    await readFile(
      path.join(root, '.claude-plugin', 'marketplace.json'),
      'utf8',
    ),
  );
  assert.equal(marketplace.plugins[0].source, './a/plugin');
  const manifest = JSON.parse(
    await readFile(
      path.join(
        root,
        marketplace.plugins[0].source,
        '.claude-plugin/plugin.json',
      ),
      'utf8',
    ),
  );
  assert.equal(manifest.name, 'pstack-cc');
  const selected = await readFile(
    path.join(root, '.claude-plugin', 'marketplace.json'),
  );
  await chmod(
    path.join(a, 'plugin/vendor/codex-plugin-cc/scripts/worker.mjs'),
    0o644,
  );
  await assert.rejects(verifyDistributionArtifact(a), /integrity mismatch/);
  await assert.rejects(promotePluginArtifact(a, root), /integrity mismatch/);
  assert.deepEqual(
    await readFile(path.join(root, '.claude-plugin', 'marketplace.json')),
    selected,
  );
  const codex = path.join(root, 'codex');
  assert.equal(
    (await buildDistributionArtifact(project, codex)).schemaVersion,
    1,
  );
  await promotePluginArtifact(codex, root);
  assert.deepEqual(
    await readFile(path.join(root, '.claude-plugin', 'marketplace.json')),
    selected,
  );
});

test('runtime verification rejects source tampering, missing license, escaped maps and symlinks', async (t) => {
  const { project, runtime, runtimeLock } = await fixture(t);
  await writeFile(path.join(runtime, 'scripts/worker.mjs'), 'tampered');
  await assert.rejects(verifyCodexRuntime(project), /integrity mismatch/);
  await writeFile(path.join(runtime, 'LICENSE'), 'Unlicensed bytes');
  runtimeLock.codexRuntime.snapshotSha256 =
    await computeSnapshotDigest(runtime);
  await writeFile(
    path.join(project, 'codex-runtime.lock.json'),
    JSON.stringify(runtimeLock),
  );
  await assert.rejects(verifyCodexRuntime(project), /Apache license/);
  for (const source of [
    '../escape',
    '/absolute',
    'scripts/../worker',
    'scripts\\worker',
  ]) {
    const invalid = structuredClone(runtimeLock);
    invalid.codexRuntime.files[0] = {
      source,
      target: `vendor/codex-plugin-cc/${source}`,
    };
    assert.throws(() => validateCodexRuntimeLock(invalid), /Invalid/);
  }
  await rm(path.join(runtime, 'scripts/worker.mjs'));
  await symlink('../LICENSE', path.join(runtime, 'scripts/worker.mjs'));
  await assert.rejects(verifyCodexRuntime(project), /Unsupported tree entry/);
});

test('Claude artifact verification rejects wrong target metadata, native paths, licensing and symlink selection', async (t) => {
  const { root, project } = await fixture(t);
  const artifact = path.join(root, 'artifact');
  await buildDistributionArtifact(project, artifact, 'claude-code');
  const metadata = await readFile(path.join(artifact, 'artifact.json'), 'utf8');
  await writeFile(
    path.join(artifact, 'artifact.json'),
    metadata.replace('"claude-code"', '"codex"'),
  );
  await assert.rejects(verifyDistributionArtifact(artifact), /Unsupported/);
  await writeFile(path.join(artifact, 'artifact.json'), metadata);
  const manifest = path.join(artifact, '.claude-plugin/marketplace.json');
  await writeFile(
    manifest,
    (await readFile(manifest, 'utf8')).replace('./plugin', '../plugin'),
  );
  await assert.rejects(
    verifyDistributionArtifact(artifact),
    /marketplace.*integrity/,
  );
  const linked = path.join(root, 'linked');
  await symlink(artifact, linked);
  await assert.rejects(
    verifyDistributionArtifact(linked),
    /physical directory/,
  );
  await assert.rejects(
    promotePluginArtifact(linked, root),
    /physical directory/,
  );
});

test('upstream candidates preserve the independently pinned runtime and both products through regeneration', async (t) => {
  const { root, project, upstream, runtimeLock } = await fixture(t);
  const source = path.join(root, 'source');
  await copyTree(upstream, path.join(source, 'pstack'));
  await writeFile(
    path.join(source, 'pstack', 'new-source'),
    'New upstream bytes\n',
  );
  runGit(source, ['init', '--quiet']);
  runGit(source, [
    'remote',
    'add',
    'origin',
    'https://github.com/cursor/plugins',
  ]);
  runGit(source, ['add', '--force', '.']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'source',
  ]);
  const candidate = path.join(root, 'candidate');
  const currentPatches = await inspectTree(path.join(project, 'patches'));
  assert.equal(
    (
      await createUpstreamCandidate(
        project,
        source,
        runGit(source, ['rev-parse', 'HEAD']).trim(),
        candidate,
      )
    ).status,
    'ready-for-review',
  );
  assert.deepEqual(await verifyCodexRuntime(candidate), runtimeLock);
  const report = JSON.parse(
    await readFile(path.join(candidate, 'candidate-report.json'), 'utf8'),
  );
  assert.deepEqual(
    report.targets.map((target: { target: string }) => target.target),
    ['codex', 'claude-code'],
  );
  for (const target of ['codex', 'claude-code'] as const)
    await verifyPatches(candidate, target);
  await writeFile(
    path.join(candidate, 'plugin-claude', 'new-source'),
    'Reviewed Claude adaptation\n',
  );
  const regenerated = path.join(root, 'regenerated');
  await regenerateCandidatePatches(candidate, regenerated);
  assert.deepEqual(
    await inspectTree(path.join(project, 'patches')),
    currentPatches,
  );
  await rm(path.join(candidate, 'patches'), { recursive: true });
  await copyTree(
    path.join(regenerated, 'patches'),
    path.join(candidate, 'patches'),
  );
  for (const target of ['codex', 'claude-code'] as const) {
    await verifyPatches(candidate, target);
    await buildDistributionArtifact(
      candidate,
      path.join(root, `rebuilt-${target}`),
      target,
    );
  }
  assert.equal(
    await readFile(path.join(candidate, 'plugin-claude/new-source'), 'utf8'),
    'Reviewed Claude adaptation\n',
  );
});

test('all verification never silently ignores an incomplete target and mutation commands reject all', async (t) => {
  const { project } = await fixture(t);
  await rm(path.join(project, 'plugin-claude'), { recursive: true });
  await assert.rejects(projectTargets(project), /requires/);
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  for (const args of [
    ['verify-patches', '--target', 'unknown'],
    [
      'build-plugin',
      '--target',
      'all',
      '--output',
      path.join(project, 'output'),
    ],
    ['generate-patch', '--target', 'all', '--name', '0002-nope.patch'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, '--project', project],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported distribution target/);
  }
});

test('a Codex-only build keeps its existing source contract when an unused Claude runtime is damaged', async (t) => {
  const { root, project, runtime } = await fixture(t);
  await writeFile(
    path.join(runtime, 'scripts/worker.mjs'),
    'damaged unused runtime',
  );
  assert.equal(
    (await buildDistributionArtifact(project, path.join(root, 'codex-only')))
      .name,
    'pstack-for-codex',
  );
  await assert.rejects(
    buildDistributionArtifact(
      project,
      path.join(root, 'claude-damaged'),
      'claude-code',
    ),
    /integrity mismatch/,
  );
});

test('a Claude patch conflict cannot be reported as a successful Codex-only upstream candidate', async (t) => {
  const { root, project, upstream } = await fixture(t);
  const source = path.join(root, 'source');
  await copyTree(upstream, path.join(source, 'pstack'));
  runGit(source, ['init', '--quiet']);
  runGit(source, [
    'remote',
    'add',
    'origin',
    'https://github.com/cursor/plugins',
  ]);
  runGit(source, ['add', '--force', '.']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'source',
  ]);
  await writeFile(
    path.join(project, 'patches/claude/0001-claude.patch'),
    'invalid patch\n',
  );
  const candidate = path.join(root, 'conflict');
  assert.equal(
    (
      await createUpstreamCandidate(
        project,
        source,
        runGit(source, ['rev-parse', 'HEAD']).trim(),
        candidate,
      )
    ).status,
    'patch-conflict',
  );
  const report = JSON.parse(
    await readFile(path.join(candidate, 'candidate-report.json'), 'utf8'),
  );
  assert.equal(report.failedTarget, 'claude-code');
  assert.equal(report.targets[0].status, 'ready-for-review');
  assert.equal(report.targets[1].failedPatch, '0001-claude.patch');
  assert.deepEqual(report.targets[1].unappliedPatches, ['0001-claude.patch']);
  await verifyPatches(candidate);
});

test('source update checks report the independently pinned official runtime without changing its lock', async (t) => {
  const { project, runtimeLock } = await fixture(t);
  const lockFile = path.join(project, 'codex-runtime.lock.json');
  const before = await readFile(lockFile);
  const urls: string[] = [];
  const results = await checkUpstream(await readLock(project), {
    codexRuntime: runtimeLock,
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes('codex-plugin-cc')
            ? { sha: '4'.repeat(40) }
            : url.includes('cursor/plugins')
              ? [{ sha: '1'.repeat(40) }]
              : { sha: '2'.repeat(40) },
      };
    },
  });
  assert.deepEqual(results.at(-1), {
    status: 'checked',
    name: 'codex-runtime',
    pinned: '3'.repeat(40),
    remote: '4'.repeat(40),
    changed: true,
  });
  assert.equal(
    urls.at(-1),
    'https://api.github.com/repos/openai/codex-plugin-cc/commits/main',
  );
  assert.deepEqual(await readFile(lockFile), before);
});
