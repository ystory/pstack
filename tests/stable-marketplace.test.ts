import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyTree, inspectTree, sha256 } from '../src/distribution/tree.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-marketplace-test-'),
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
  await writeFile(
    path.join(upstream, 'content.txt'),
    'First verified content\n',
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
        version: '0.15.24',
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
  await mkdir(path.join(project, 'patches'));
  await writeFile(
    path.join(project, 'patches', 'series'),
    '0001-identity.patch\n',
  );
  await writeFile(
    path.join(project, 'patches', '0001-identity.patch'),
    '--- a/plugin.json\n+++ b/plugin.json\n@@ -1,5 +1,5 @@\n {\n-  "name": "pstack",\n+  "name": "pstack-codex",\n   "version": "0.15.24",\n   "license": "MIT"\n }\n',
  );
  const plugin = path.join(project, 'plugin');
  await copyTree(upstream, plugin);
  await writeFile(
    path.join(plugin, 'plugin.json'),
    manifest.replace('"pstack"', '"pstack-codex"'),
  );
  const marketplace = path.join(root, 'artifacts');
  await mkdir(marketplace);
  const marketplaceManifest = path.join(
    marketplace,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  return { project, plugin, marketplace, marketplaceManifest };
}

test('a verified build selects its immutable child through the fixed native marketplace', async (t) => {
  const { project, marketplace, marketplaceManifest } = await fixture(t);
  const artifact = path.join(marketplace, 'first');
  const result = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    artifact,
    '--marketplace',
    marketplace,
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(marketplaceManifest, 'utf8'));
  assert.equal(manifest.name, 'pstack-codex');
  assert.equal(manifest.plugins[0].source.path, './first/plugin');
  const installedSource = path.resolve(
    marketplace,
    manifest.plugins[0].source.path,
  );
  assert.equal(
    await readFile(path.join(installedSource, 'content.txt'), 'utf8'),
    'First verified content\n',
  );
  assert.equal(runCli('verify-plugin', '--artifact', artifact).status, 0);
});

test('artifacts reject a different marketplace identity even with a matching digest', async (t) => {
  const { project, marketplace } = await fixture(t);
  const artifact = path.join(marketplace, 'wrong-name');
  assert.equal(
    runCli('build-plugin', '--project', project, '--output', artifact).status,
    0,
  );
  const embeddedFile = path.join(
    artifact,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  const metadataFile = path.join(artifact, 'artifact.json');
  const manifest = JSON.parse(await readFile(embeddedFile, 'utf8'));
  manifest.name = 'another-marketplace';
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  metadata.marketplaceSha256 = sha256(bytes);
  await writeFile(embeddedFile, bytes);
  await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  assert.equal(runCli('verify-plugin', '--artifact', artifact).status, 1);
  assert.equal(
    runCli(
      'promote-plugin',
      '--artifact',
      artifact,
      '--marketplace',
      marketplace,
    ).status,
    1,
  );
});

test('staged builds leave selection alone until promotion advances the same-version source', async (t) => {
  const { project, plugin, marketplace, marketplaceManifest } =
    await fixture(t);
  const first = path.join(marketplace, 'first');
  const second = path.join(marketplace, 'second');
  assert.equal(
    runCli(
      'build-plugin',
      '--project',
      project,
      '--output',
      first,
      '--marketplace',
      marketplace,
    ).status,
    0,
  );
  const oldSelection = await readFile(marketplaceManifest);
  const firstTree = await inspectTree(first);
  await writeFile(
    path.join(plugin, 'content.txt'),
    'Second verified content\n',
  );
  const patch = runCli(
    'generate-patch',
    '--project',
    project,
    '--name',
    '0002-content.patch',
  );
  assert.equal(patch.status, 0, patch.stderr);
  const build = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    second,
  );
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(await readFile(marketplaceManifest), oldSelection);
  const promotion = runCli(
    'promote-plugin',
    '--artifact',
    second,
    '--marketplace',
    marketplace,
  );
  assert.equal(promotion.status, 0, promotion.stderr);
  const manifest = JSON.parse(await readFile(marketplaceManifest, 'utf8'));
  assert.equal(manifest.plugins[0].source.path, './second/plugin');
  const installedSource = path.resolve(
    marketplace,
    manifest.plugins[0].source.path,
  );
  assert.equal(
    await readFile(path.join(installedSource, 'content.txt'), 'utf8'),
    'Second verified content\n',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(first, 'artifact.json'), 'utf8'))
      .version,
    JSON.parse(await readFile(path.join(second, 'artifact.json'), 'utf8'))
      .version,
  );
  assert.deepEqual(await inspectTree(first), firstTree);
  const third = path.join(marketplace, 'third');
  const nextBuild = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    third,
    '--marketplace',
    marketplace,
  );
  assert.equal(nextBuild.status, 0, nextBuild.stderr);
  assert.equal(
    JSON.parse(await readFile(marketplaceManifest, 'utf8')).plugins[0].source
      .path,
    './third/plugin',
  );
  assert.deepEqual(await inspectTree(first), firstTree);
});

test('failed builds and failed artifact verification preserve the selected manifest bytes', async (t) => {
  const { project, plugin, marketplace, marketplaceManifest } =
    await fixture(t);
  const first = path.join(marketplace, 'first');
  assert.equal(
    runCli(
      'build-plugin',
      '--project',
      project,
      '--output',
      first,
      '--marketplace',
      marketplace,
    ).status,
    0,
  );
  const selected = await readFile(marketplaceManifest);
  const corrupt = path.join(marketplace, 'corrupt');
  assert.equal(
    runCli('build-plugin', '--project', project, '--output', corrupt).status,
    0,
  );
  await writeFile(
    path.join(corrupt, 'plugin', 'content.txt'),
    'Unverified content\n',
  );
  const promotion = runCli(
    'promote-plugin',
    '--artifact',
    corrupt,
    '--marketplace',
    marketplace,
  );
  assert.equal(promotion.status, 1);
  assert.match(promotion.stderr, /integrity mismatch/);
  assert.deepEqual(await readFile(marketplaceManifest), selected);
  await writeFile(path.join(plugin, 'content.txt'), 'Unpatched source\n');
  const build = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    path.join(marketplace, 'failed'),
    '--marketplace',
    marketplace,
  );
  assert.equal(build.status, 1);
  assert.match(build.stderr, /differs/);
  assert.deepEqual(await readFile(marketplaceManifest), selected);
  assert.equal(runCli('verify-plugin', '--artifact', first).status, 0);
});

test('promotion rejects outside artifacts and symlinked marketplace paths without changing the selection', async (t) => {
  const { project, marketplace, marketplaceManifest } = await fixture(t);
  const artifact = path.join(marketplace, 'first');
  assert.equal(
    runCli(
      'build-plugin',
      '--project',
      project,
      '--output',
      artifact,
      '--marketplace',
      marketplace,
    ).status,
    0,
  );
  const selected = await readFile(marketplaceManifest);
  const otherMarketplace = path.join(marketplace, 'other');
  await mkdir(otherMarketplace);
  const outside = runCli(
    'promote-plugin',
    '--artifact',
    artifact,
    '--marketplace',
    otherMarketplace,
  );
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /immutable child/);
  const alias = path.join(marketplace, 'alias');
  await symlink(marketplace, alias);
  const aliased = runCli(
    'promote-plugin',
    '--artifact',
    artifact,
    '--marketplace',
    alias,
  );
  assert.equal(aliased.status, 1);
  assert.match(aliased.stderr, /symlink/);
  assert.deepEqual(await readFile(marketplaceManifest), selected);
});

test('promotion cannot rewrite an artifact through its own root or native metadata directory', async (t) => {
  const { project, marketplace } = await fixture(t);
  const artifact = path.join(marketplace, '.agents');
  const build = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    artifact,
  );
  assert.equal(build.status, 0, build.stderr);
  const before = await inspectTree(artifact);
  const ownRoot = runCli(
    'promote-plugin',
    '--artifact',
    artifact,
    '--marketplace',
    artifact,
  );
  assert.equal(ownRoot.status, 1);
  const metadataRoot = runCli(
    'promote-plugin',
    '--artifact',
    artifact,
    '--marketplace',
    marketplace,
  );
  assert.equal(metadataRoot.status, 1);
  assert.match(metadataRoot.stderr, /metadata/);
  assert.deepEqual(await inspectTree(artifact), before);
});

test('promotion keeps native marketplace metadata in physical directories', async (t) => {
  const { project, marketplace, marketplaceManifest } = await fixture(t);
  const artifact = path.join(marketplace, 'first');
  assert.equal(
    runCli(
      'build-plugin',
      '--project',
      project,
      '--output',
      artifact,
      '--marketplace',
      marketplace,
    ).status,
    0,
  );
  const selected = await readFile(marketplaceManifest);
  const metadata = path.join(marketplace, '.agents');
  const moved = path.join(marketplace, 'moved-metadata');
  await rename(metadata, moved);
  await symlink(moved, metadata);
  const promotion = runCli(
    'promote-plugin',
    '--artifact',
    artifact,
    '--marketplace',
    marketplace,
  );
  assert.equal(promotion.status, 1);
  assert.match(promotion.stderr, /symlink/);
  assert.deepEqual(await readFile(marketplaceManifest), selected);
});

test('an existing artifact cannot become the mutable marketplace root for its nested artifact', async (t) => {
  const { project, marketplace } = await fixture(t);
  const previous = path.join(marketplace, 'previous');
  const build = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    previous,
  );
  assert.equal(build.status, 0, build.stderr);
  const previousManifest = path.join(
    previous,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  const before = await readFile(previousManifest);
  const nested = path.join(previous, 'next');
  const nextBuild = runCli(
    'build-plugin',
    '--project',
    project,
    '--output',
    nested,
  );
  assert.equal(nextBuild.status, 0, nextBuild.stderr);
  assert.equal(runCli('verify-plugin', '--artifact', previous).status, 0);
  const promotion = runCli(
    'promote-plugin',
    '--artifact',
    nested,
    '--marketplace',
    previous,
  );
  assert.equal(promotion.status, 1);
  assert.match(promotion.stderr, /artifact directory.*marketplace root/);
  assert.deepEqual(await readFile(previousManifest), before);
  const verification = runCli('verify-plugin', '--artifact', previous);
  assert.equal(verification.status, 0, verification.stderr);
});
