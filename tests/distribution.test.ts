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
import {
  buildPluginArtifact,
  verifyPluginArtifact,
} from '../src/distribution/artifact.ts';
import {
  generatePatch,
  runGit,
  verifyPatches,
} from '../src/distribution/patches.ts';
import { copyTree, inspectTree } from '../src/distribution/tree.ts';
import { createUpstreamCandidate } from '../src/upstream/candidate.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import { regenerateCandidatePatches } from '../src/distribution/regenerate.ts';
import { readPatchSeries } from '../src/distribution/patches.ts';
import type { UpstreamLock } from '../src/upstream/lock.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-distribution-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const upstream = path.join(project, 'upstream', 'pstack');
  await mkdir(path.join(upstream, '.cursor-plugin'), { recursive: true });
  const manifest = `${JSON.stringify({ name: 'pstack', version: '0.15.24', license: 'MIT' }, null, 2)}\n`;
  await writeFile(
    path.join(upstream, '.cursor-plugin', 'plugin.json'),
    manifest,
  );
  await writeFile(path.join(upstream, 'plugin.json'), manifest);
  await writeFile(
    path.join(upstream, 'LICENSE'),
    'MIT License\nCopyright Lauren Tan\n',
  );
  await writeFile(path.join(upstream, '.gitignore'), 'cache/\n');
  await writeFile(path.join(upstream, 'runner.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(upstream, 'runner.sh'), 0o755);
  const lock: UpstreamLock = {
    schemaVersion: 1,
    pstack: {
      repository: 'https://github.com/cursor/plugins',
      ref: 'main',
      path: 'pstack',
      revision: '1'.repeat(40),
      pathRevision: '1'.repeat(40),
      version: '0.15.24',
      snapshotSha256: await computeSnapshotDigest(upstream),
    },
    codex: {
      repository: 'https://github.com/openai/codex',
      ref: 'main',
      sourceRevision: '2'.repeat(40),
      testedVersions: [],
    },
  };
  await writeFile(
    path.join(project, 'upstream.lock.json'),
    JSON.stringify(lock),
  );
  await mkdir(path.join(project, 'patches'));
  await writeFile(
    path.join(project, 'patches', 'series'),
    '0001-plugin-identity.patch\n',
  );
  await writeFile(
    path.join(project, 'patches', '0001-plugin-identity.patch'),
    '--- a/plugin.json\n+++ b/plugin.json\n@@ -1,5 +1,5 @@\n {\n-  "name": "pstack",\n+  "name": "pstack-for-codex",\n   "version": "0.15.24",\n   "license": "MIT"\n }\n',
  );
  const plugin = path.join(project, 'plugin');
  await copyTree(upstream, plugin);
  await writeFile(
    path.join(plugin, 'plugin.json'),
    manifest.replace('"pstack"', '"pstack-for-codex"'),
  );
  return { root, project, upstream, plugin, lock };
}

test('standalone plugin builds reproduce metadata and preserve hidden files and executable modes', async (t) => {
  const { root, project } = await fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const first = await buildPluginArtifact(project, a);
  assert.deepEqual(await buildPluginArtifact(project, b), first);
  assert.equal(
    await readFile(path.join(a, 'artifact.json'), 'utf8'),
    await readFile(path.join(b, 'artifact.json'), 'utf8'),
  );
  assert.deepEqual(
    await inspectTree(path.join(a, 'plugin')),
    await inspectTree(path.join(b, 'plugin')),
  );
  assert.ok(first.entries.some((entry) => entry.path === '.gitignore'));
  assert.equal(
    first.entries.find((entry) => entry.path === 'runner.sh')?.mode,
    0o755,
  );
  const marketplace = JSON.parse(
    await readFile(
      path.join(a, '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ),
  );
  assert.equal(marketplace.plugins[0].source.path, './plugin');
  await assert.rejects(buildPluginArtifact(project, a), /EEXIST/);
});

test('artifact verification catches bytes, extra files, executable mode changes, and symlinks', async (t) => {
  const { root, project } = await fixture(t);
  const artifact = path.join(root, 'artifact');
  await buildPluginArtifact(project, artifact);
  const runner = path.join(artifact, 'plugin', 'runner.sh');
  await chmod(runner, 0o644);
  await assert.rejects(verifyPluginArtifact(artifact), /integrity mismatch/);
  await chmod(runner, 0o755);
  await writeFile(path.join(artifact, 'plugin', 'extra'), 'unowned');
  await assert.rejects(verifyPluginArtifact(artifact), /integrity mismatch/);
  await rm(path.join(artifact, 'plugin', 'extra'));
  await writeFile(runner, 'changed');
  await assert.rejects(verifyPluginArtifact(artifact), /integrity mismatch/);
  await rm(runner);
  await symlink(path.join(project, 'plugin', 'runner.sh'), runner);
  await assert.rejects(
    verifyPluginArtifact(artifact),
    /Unsupported tree entry/,
  );
});

test('new patches preserve old patches and replay additions, deletions, binary bytes, and modes', async (t) => {
  const { project, plugin } = await fixture(t);
  const previous = await readFile(
    path.join(project, 'patches', '0001-plugin-identity.patch'),
  );
  await writeFile(path.join(plugin, 'new.bin'), Buffer.from([0, 255, 1, 2]));
  await rm(path.join(plugin, '.gitignore'));
  await chmod(path.join(plugin, 'runner.sh'), 0o644);
  await assert.rejects(verifyPatches(project), /differs/);
  await generatePatch(project, '0002-port.patch');
  assert.deepEqual(
    await readFile(path.join(project, 'patches', '0001-plugin-identity.patch')),
    previous,
  );
  assert.equal((await verifyPatches(project)).patches.length, 2);
  await assert.rejects(generatePatch(project, '0002-port.patch'), /immutable/);
  await assert.rejects(generatePatch(project, '../escape.patch'), /Patch name/);
});

test('selected paths produce separate reviewable patches and preserve remaining work', async (t) => {
  const { project, plugin } = await fixture(t);
  await mkdir(path.join(plugin, 'skills', 'setup'), { recursive: true });
  await writeFile(path.join(plugin, 'skills', 'setup', 'config'), 'roles');
  await writeFile(path.join(plugin, 'metadata'), 'policy');
  await generatePatch(project, '0002-config.patch', ['skills/setup']);
  const patch = await readFile(
    path.join(project, 'patches', '0002-config.patch'),
    'utf8',
  );
  assert.match(patch, /skills\/setup\/config/);
  assert.doesNotMatch(patch, /b\/metadata/);
  await assert.rejects(verifyPatches(project), /metadata/);
  await generatePatch(project, '0003-metadata.patch', ['metadata']);
  await verifyPatches(project);
  await assert.rejects(
    generatePatch(project, '0004-bad.patch', ['../escape']),
    /relative files/,
  );
});

test('invalid patch series and conflicts fail before artifact creation', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(
    path.join(project, 'patches', 'series'),
    '../outside.patch\n',
  );
  await assert.rejects(
    buildPluginArtifact(project, path.join(root, 'bad')),
    /unique numbered/,
  );
  await writeFile(
    path.join(project, 'patches', 'series'),
    '0001-plugin-identity.patch\n',
  );
  await writeFile(
    path.join(project, 'patches', '0001-plugin-identity.patch'),
    'invalid patch\n',
  );
  await assert.rejects(
    buildPluginArtifact(project, path.join(root, 'bad')),
    /Patch conflict/,
  );
});

test('upstream candidates preserve current pin and record both ready and conflict outcomes', async (t) => {
  const { root, project, upstream } = await fixture(t);
  const before = await readFile(path.join(project, 'upstream.lock.json'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await copyTree(upstream, path.join(source, 'pstack'));
  await writeFile(
    path.join(source, 'pstack', 'new-upstream.txt'),
    'New source material\n',
  );
  runGit(source, ['init', '--quiet']);
  runGit(source, [
    'remote',
    'add',
    'origin',
    'https://github.com/cursor/plugins.git',
  ]);
  runGit(source, ['add', '--force', '.']);
  runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'upstream',
  ]);
  const revision = runGit(source, ['rev-parse', 'HEAD']).trim();
  const ready = path.join(root, 'ready');
  assert.equal(
    (await createUpstreamCandidate(project, source, revision, ready)).status,
    'ready-for-review',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(ready, 'upstream.lock.json'), 'utf8'))
      .pstack.revision,
    revision,
  );
  assert.match(
    await readFile(path.join(ready, 'upstream-changes.diff'), 'utf8'),
    /new-upstream\.txt/,
  );
  await writeFile(
    path.join(project, 'patches', '0001-plugin-identity.patch'),
    'invalid patch\n',
  );
  const conflict = path.join(root, 'conflict');
  assert.equal(
    (await createUpstreamCandidate(project, source, revision, conflict)).status,
    'patch-conflict',
  );
  assert.match(
    JSON.parse(
      await readFile(path.join(conflict, 'candidate-report.json'), 'utf8'),
    ).conflict,
    /0001-plugin-identity/,
  );
  const failedReport = JSON.parse(
    await readFile(path.join(conflict, 'candidate-report.json'), 'utf8'),
  );
  assert.equal(failedReport.failedPatch, '0001-plugin-identity.patch');
  assert.deepEqual(failedReport.unappliedPatches, [
    '0001-plugin-identity.patch',
  ]);
  assert.deepEqual(
    await readFile(path.join(project, 'upstream.lock.json')),
    before,
  );
  await assert.rejects(
    createUpstreamCandidate(
      project,
      source,
      'HEAD',
      path.join(root, 'invalid'),
    ),
    /full commit SHA/,
  );
});

test('conflict recovery emits candidate-only verified patches and preserves the original conflict evidence', async (t) => {
  const { root, project, upstream, plugin } = await fixture(t);
  const candidate = path.join(root, 'candidate');
  await mkdir(candidate);
  await copyTree(
    path.join(project, 'upstream'),
    path.join(candidate, 'upstream'),
  );
  await copyTree(plugin, path.join(candidate, 'plugin'));
  await copyTree(
    path.join(project, 'patches'),
    path.join(candidate, 'patches'),
  );
  await writeFile(
    path.join(candidate, 'upstream.lock.json'),
    await readFile(path.join(project, 'upstream.lock.json')),
  );
  await writeFile(
    path.join(candidate, 'candidate-report.json'),
    JSON.stringify({
      status: 'patch-conflict',
      conflict: '0001-plugin-identity.patch',
      unappliedPatches: ['0001-plugin-identity.patch'],
    }),
  );
  await writeFile(
    path.join(candidate, 'upstream', 'pstack', 'new-source'),
    'Next source\n',
  );
  const lock = JSON.parse(
    await readFile(path.join(candidate, 'upstream.lock.json'), 'utf8'),
  );
  lock.pstack.snapshotSha256 = await computeSnapshotDigest(
    path.join(candidate, 'upstream', 'pstack'),
  );
  await writeFile(
    path.join(candidate, 'upstream.lock.json'),
    JSON.stringify(lock),
  );
  await writeFile(
    path.join(candidate, 'plugin', 'new-source'),
    'Next source with reviewed adaptation\n',
  );
  const original = await readFile(
    path.join(candidate, 'patches', '0001-plugin-identity.patch'),
  );
  const output = path.join(root, 'rebuilt-patches');
  const result = await regenerateCandidatePatches(candidate, output);
  assert.ok(result.files > 0);
  assert.deepEqual(
    await readFile(
      path.join(candidate, 'patches', '0001-plugin-identity.patch'),
    ),
    original,
  );
  assert.deepEqual(
    (await readPatchSeries(project)).map((patch) => patch.name),
    ['0001-plugin-identity.patch'],
  );
  const report = JSON.parse(
    await readFile(path.join(output, 'regeneration-report.json'), 'utf8'),
  );
  assert.equal(report.originalCandidateStatus, 'patch-conflict');
  assert.deepEqual(report.originalUnappliedPatches, [
    '0001-plugin-identity.patch',
  ]);
  assert.ok(
    report.regeneratedPatches.some(
      (patch: { name: string }) =>
        patch.name === '9999-candidate-remainder.patch',
    ),
  );
  await rm(path.join(candidate, 'patches'), { recursive: true });
  await copyTree(path.join(output, 'patches'), path.join(candidate, 'patches'));
  assert.equal((await verifyPatches(candidate)).digest, result.digest);
  assert.equal(
    await computeSnapshotDigest(upstream),
    JSON.parse(await readFile(path.join(project, 'upstream.lock.json'), 'utf8'))
      .pstack.snapshotSha256,
  );
});

test('candidate source-policy conflicts remain reviewable and never silently reintroduce a moved excluded entrypoint', async (t) => {
  const { root, project, upstream } = await fixture(t);
  await mkdir(path.join(upstream, 'automations', 'benny'), { recursive: true });
  await writeFile(
    path.join(upstream, 'automations', 'benny', 'FOR_AGENTS.md'),
    'Original excluded source\n',
  );
  const lock = JSON.parse(
    await readFile(path.join(project, 'upstream.lock.json'), 'utf8'),
  );
  lock.pstack.snapshotSha256 = await computeSnapshotDigest(upstream);
  await writeFile(
    path.join(project, 'upstream.lock.json'),
    JSON.stringify(lock),
  );
  await writeFile(
    path.join(project, 'distribution-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      excludedDirectories: ['automations/benny'],
    }),
  );
  const source = path.join(root, 'source');
  await copyTree(upstream, path.join(source, 'pstack'));
  await mkdir(path.join(source, 'pstack', 'skills', 'setup-benny'), {
    recursive: true,
  });
  await writeFile(
    path.join(source, 'pstack', 'skills', 'setup-benny', 'SKILL.md'),
    'New relocated entrypoint\n',
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
    '--no-gpg-sign',
    '--quiet',
    '-m',
    'new source surface',
  ]);
  const output = path.join(root, 'candidate');
  assert.equal(
    (
      await createUpstreamCandidate(
        project,
        source,
        runGit(source, ['rev-parse', 'HEAD']).trim(),
        output,
      )
    ).status,
    'source-policy-conflict',
  );
  const report = JSON.parse(
    await readFile(path.join(output, 'candidate-report.json'), 'utf8'),
  );
  assert.match(report.conflict, /New Benny source surface/);
  assert.deepEqual(report.appliedPatches, []);
  assert.deepEqual(report.unappliedPatches, ['0001-plugin-identity.patch']);
  assert.equal(
    await readFile(
      path.join(
        output,
        'upstream',
        'pstack',
        'automations',
        'benny',
        'FOR_AGENTS.md',
      ),
      'utf8',
    ),
    'Original excluded source\n',
  );
  assert.equal(
    await computeSnapshotDigest(upstream),
    lock.pstack.snapshotSha256,
  );
});

test('Codex invocation metadata mirrors all 57 upstream explicit-only flags without removing frontmatter', async () => {
  const project = path.resolve(import.meta.dirname, '..');
  const entries = (
    await inspectTree(path.join(project, 'upstream', 'pstack', 'skills'))
  ).filter((entry) => /^[^/]+\/SKILL\.md$/.test(entry.path));
  assert.equal(entries.length, 58);
  let explicit = 0;
  for (const entry of entries) {
    const upstream = await readFile(
      path.join(project, 'upstream', 'pstack', 'skills', entry.path),
      'utf8',
    );
    if (!/^disable-model-invocation: true$/m.test(upstream.split('---')[1]!))
      continue;
    explicit += 1;
    const skill = await readFile(
      path.join(project, 'plugin', 'skills', entry.path),
      'utf8',
    );
    assert.match(skill.split('---')[1]!, /^disable-model-invocation: true$/m);
    const policy = await readFile(
      path.join(
        project,
        'plugin',
        'skills',
        path.dirname(entry.path),
        'agents',
        'openai.yaml',
      ),
      'utf8',
    );
    assert.match(policy, /^policy:\n  allow_implicit_invocation: false$/m);
    assert.match(policy, /^  display_name: ".+"$/m);
    assert.match(policy, /^  short_description: ".+"$/m);
    const quotedDescription = skill
      .split('---')[1]!
      .match(/^description: ("(?:\\.|[^"\\])*")$/m)?.[1];
    if (quotedDescription) {
      const sidecarDescription = policy.match(
        /^  short_description: (.+)$/m,
      )![1]!;
      assert.equal(
        JSON.parse(sidecarDescription),
        JSON.parse(quotedDescription),
      );
    }
  }
  assert.equal(explicit, 57);
});
