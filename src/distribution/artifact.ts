import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readLock, validateLock } from '../upstream/lock.ts';
import type { UpstreamLock } from '../upstream/lock.ts';
import {
  readDependencyLock,
  validateDependencyLock,
} from '../upstream/dependencies.ts';
import type { DependencyLock } from '../upstream/dependencies.ts';
import {
  readDistributionPolicy,
  validateDistributionPolicy,
  verifyDistributionPolicy,
} from './policy.ts';
import type { DistributionPolicy } from './policy.ts';
import { verifyPatches } from './patches.ts';
import type { PatchRecord } from './patches.ts';
import {
  copyTree,
  createOutputDirectory,
  inspectTree,
  sha256,
  treeDigest,
} from './tree.ts';
import type { TreeEntry } from './tree.ts';

export interface PluginArtifact {
  schemaVersion: 1;
  name: 'pstack-codex';
  version: string;
  upstream: UpstreamLock;
  dependencies?: DependencyLock;
  distributionPolicy?: DistributionPolicy;
  patches: PatchRecord[];
  treeSha256: string;
  marketplaceSha256: string;
  entries: TreeEntry[];
}

export const localMarketplace = {
  name: 'pstack-codex',
  plugins: [
    { name: 'pstack-codex', source: { source: 'local', path: './plugin' } },
  ],
};

export async function buildPluginArtifact(
  projectRoot: string,
  output: string,
): Promise<PluginArtifact> {
  const verified = await verifyPatches(projectRoot);
  const upstream = await readLock(projectRoot);
  const dependencies = await readDependencyLock(projectRoot);
  const distributionPolicy = await readDistributionPolicy(projectRoot);
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, 'plugin', 'plugin.json'), 'utf8'),
  );
  if (
    manifest.name !== 'pstack-codex' ||
    typeof manifest.version !== 'string' ||
    !manifest.version
  )
    throw new Error('Plugin manifest has invalid identity.');
  if (
    !(
      await readFile(path.join(projectRoot, 'plugin', 'LICENSE'), 'utf8')
    ).includes('Lauren Tan')
  )
    throw new Error('Plugin attribution is missing.');
  const entries = await inspectTree(path.join(projectRoot, 'plugin'));
  const marketplaceBytes = `${JSON.stringify(localMarketplace, null, 2)}\n`;
  const artifact: PluginArtifact = {
    schemaVersion: 1,
    name: 'pstack-codex',
    version: manifest.version,
    upstream,
    ...(dependencies ? { dependencies } : {}),
    ...(distributionPolicy ? { distributionPolicy } : {}),
    patches: verified.patches,
    treeSha256: treeDigest(entries),
    marketplaceSha256: sha256(marketplaceBytes),
    entries,
  };
  await createOutputDirectory(output);
  await copyTree(path.join(projectRoot, 'plugin'), path.join(output, 'plugin'));
  const marketplaceDirectory = path.join(output, '.agents', 'plugins');
  await mkdir(marketplaceDirectory, { recursive: true });
  await writeFile(
    path.join(marketplaceDirectory, 'marketplace.json'),
    marketplaceBytes,
    { flag: 'wx', mode: 0o644 },
  );
  await writeFile(
    path.join(output, 'artifact.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  await verifyPluginArtifact(output);
  return artifact;
}

export async function verifyPluginArtifact(
  root: string,
): Promise<PluginArtifact> {
  const value = JSON.parse(
    await readFile(path.join(root, 'artifact.json'), 'utf8'),
  );
  if (
    value.schemaVersion !== 1 ||
    value.name !== 'pstack-codex' ||
    typeof value.version !== 'string' ||
    !value.version ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.patches) ||
    typeof value.treeSha256 !== 'string'
  )
    throw new Error('Invalid artifact.json.');
  validateLock(value.upstream);
  if (value.dependencies !== undefined)
    validateDependencyLock(value.dependencies);
  if (value.distributionPolicy !== undefined)
    validateDistributionPolicy(value.distributionPolicy);
  await verifyDistributionPolicy(
    path.join(root, 'plugin'),
    value.distributionPolicy,
  );
  const marketplaceBytes = await readFile(
    path.join(root, '.agents', 'plugins', 'marketplace.json'),
  );
  const marketplace =
    sha256(marketplaceBytes) === value.marketplaceSha256
      ? JSON.parse(marketplaceBytes.toString('utf8'))
      : undefined;
  if (JSON.stringify(marketplace) !== JSON.stringify(localMarketplace))
    throw new Error('Native marketplace manifest integrity mismatch.');
  const entries = await inspectTree(path.join(root, 'plugin'));
  if (
    JSON.stringify(entries) !== JSON.stringify(value.entries) ||
    treeDigest(entries) !== value.treeSha256
  )
    throw new Error(
      'Plugin artifact integrity mismatch (paths, bytes, or modes).',
    );
  const manifest = JSON.parse(
    await readFile(path.join(root, 'plugin', 'plugin.json'), 'utf8'),
  );
  if (
    manifest.name !== value.name ||
    manifest.version !== value.version ||
    manifest.license !== 'MIT'
  )
    throw new Error('Artifact identity or license mismatch.');
  if (
    !(await readFile(path.join(root, 'plugin', 'LICENSE'), 'utf8')).includes(
      'Lauren Tan',
    )
  )
    throw new Error('Plugin attribution is missing.');
  return value as PluginArtifact;
}
