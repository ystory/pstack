import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildPluginArtifact } from '../src/distribution/artifact.ts';
import { runGit, verifyPatches } from '../src/distribution/patches.ts';
import { copyTree } from '../src/distribution/tree.ts';
import { createUpstreamCandidate } from '../src/upstream/candidate.ts';
import { checkUpstream } from '../src/upstream/check.ts';
import {
  copyPristinePlugin,
  dependencyFiles,
  readDependencyLock,
  validateDependencyLock,
  verifyDependencies,
} from '../src/upstream/dependencies.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import type { DependencyLock } from '../src/upstream/dependencies.ts';
import type { UpstreamLock } from '../src/upstream/lock.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-dependencies-test-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const pstack = path.join(project, 'upstream', 'pstack');
  await mkdir(path.join(pstack, '.cursor-plugin'), { recursive: true });
  const manifest = JSON.stringify({
    name: 'pstack',
    version: '0.15.24',
    license: 'MIT',
  });
  await writeFile(path.join(pstack, '.cursor-plugin', 'plugin.json'), manifest);
  await writeFile(path.join(pstack, 'plugin.json'), manifest);
  await writeFile(
    path.join(pstack, 'LICENSE'),
    'MIT License\nCopyright Lauren Tan\n',
  );
  const lock: UpstreamLock = {
    schemaVersion: 1,
    pstack: {
      repository: 'https://github.com/cursor/plugins',
      ref: 'main',
      path: 'pstack',
      revision: '1'.repeat(40),
      pathRevision: '1'.repeat(40),
      version: '0.15.24',
      snapshotSha256: await computeSnapshotDigest(pstack),
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
  const dependency = path.join(project, 'upstream', 'cursor-team-kit');
  for (const file of dependencyFiles) {
    await mkdir(path.dirname(path.join(dependency, file.source)), {
      recursive: true,
    });
    await writeFile(
      path.join(dependency, file.source),
      file.source === 'LICENSE'
        ? 'MIT License\nCopyright Cursor\n'
        : `---\nname: ${path.dirname(file.source).split('/').at(-1)}\ndescription: Original dependency\n---\nOriginal kit source\n`,
    );
  }
  const dependencies: DependencyLock = {
    schemaVersion: 1,
    cursorTeamKit: {
      repository: 'https://github.com/cursor/plugins',
      ref: 'main',
      path: 'cursor-team-kit',
      revision: '1'.repeat(40),
      pathRevision: '3'.repeat(40),
      snapshotSha256: await computeSnapshotDigest(dependency),
      files: dependencyFiles,
    },
  };
  await writeFile(
    path.join(project, 'dependencies.lock.json'),
    JSON.stringify(dependencies),
  );
  await copyPristinePlugin(project, path.join(project, 'plugin'));
  await writeFile(
    path.join(project, 'plugin', 'plugin.json'),
    manifest.replace('"pstack"', '"pstack-codex"'),
  );
  await mkdir(path.join(project, 'patches'));
  await writeFile(
    path.join(project, 'patches', 'series'),
    '0001-identity.patch\n',
  );
  await writeFile(
    path.join(project, 'patches', '0001-identity.patch'),
    `--- a/plugin.json\n+++ b/plugin.json\n@@ -1 +1 @@\n-${manifest}\n\\ No newline at end of file\n+${manifest.replace('"pstack"', '"pstack-codex"')}\n\\ No newline at end of file\n`,
  );
  return { root, project, pstack, dependency, lock, dependencies };
}

test('selected source verification and artifact provenance are independent of the pstack pin', async (t) => {
  const { root, project, pstack, dependency, lock, dependencies } =
    await fixture(t);
  assert.deepEqual(await verifyDependencies(project), dependencies);
  await verifyPatches(project);
  const artifact = await buildPluginArtifact(
    project,
    path.join(root, 'artifact'),
  );
  assert.deepEqual(artifact.dependencies, dependencies);
  assert.ok(
    artifact.entries.some(
      (entry) => entry.path === 'licenses/cursor-team-kit/LICENSE',
    ),
  );
  await chmod(
    path.join(project, 'plugin', 'skills', 'control-cli', 'SKILL.md'),
    0o755,
  );
  await assert.rejects(verifyPatches(project), /modes/);
  await writeFile(
    path.join(dependency, 'skills', 'control-ui', 'SKILL.md'),
    'changed source',
  );
  await assert.rejects(verifyDependencies(project), /integrity mismatch/);
  assert.equal(await computeSnapshotDigest(pstack), lock.pstack.snapshotSha256);
  assert.throws(
    () =>
      validateDependencyLock({
        ...dependencies,
        cursorTeamKit: {
          ...dependencies.cursorTeamKit,
          files: [{ source: '../escape', target: 'skills/escape' }],
        },
      }),
    /Invalid/,
  );
});

test('source update checking watches the kit path independently', async (t) => {
  const { lock, dependencies } = await fixture(t);
  const urls: string[] = [];
  const results = await checkUpstream(lock, {
    dependencies,
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes('cursor-team-kit')
            ? [{ sha: '4'.repeat(40) }]
            : url.includes('path=pstack')
              ? [{ sha: lock.pstack.pathRevision }]
              : { sha: lock.codex.sourceRevision },
      };
    },
  });
  assert.equal(results.length, 3);
  assert.ok(urls.some((url) => url.includes('path=cursor-team-kit')));
  assert.deepEqual(
    results.find((result) => result.name === 'cursor-team-kit'),
    {
      status: 'checked',
      name: 'cursor-team-kit',
      pinned: dependencies.cursorTeamKit.pathRevision,
      remote: '4'.repeat(40),
      changed: true,
    },
  );
});

test('a new dependency source flows into a composite candidate without an added-file adaptation patch', async (t) => {
  const { root, project, dependency, dependencies } = await fixture(t);
  const source = path.join(root, 'source');
  await copyTree(path.join(project, 'upstream'), source);
  const changed = path.join(
    source,
    'cursor-team-kit',
    'skills',
    'control-ui',
    'SKILL.md',
  );
  const nextBody = `${await readFile(changed, 'utf8')}New upstream behavior\n`;
  await writeFile(changed, nextBody);
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
    'next kit source',
  ]);
  const revision = runGit(source, ['rev-parse', 'HEAD']).trim();
  const output = path.join(root, 'candidate');
  assert.equal(
    (await createUpstreamCandidate(project, source, revision, output)).status,
    'ready-for-review',
  );
  assert.equal(
    await readFile(
      path.join(output, 'plugin', 'skills', 'control-ui', 'SKILL.md'),
      'utf8',
    ),
    nextBody,
  );
  assert.match(
    await readFile(path.join(output, 'dependency-changes.diff'), 'utf8'),
    /New upstream behavior/,
  );
  assert.equal(
    (await readDependencyLock(output))?.cursorTeamKit.revision,
    revision,
  );
  assert.notEqual(
    (await readDependencyLock(output))?.cursorTeamKit.snapshotSha256,
    dependencies.cursorTeamKit.snapshotSha256,
  );
  assert.deepEqual(await readDependencyLock(project), dependencies);
  assert.doesNotMatch(
    await readFile(
      path.join(dependency, 'skills', 'control-ui', 'SKILL.md'),
      'utf8',
    ),
    /New upstream behavior/,
  );
});
