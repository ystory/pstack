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
  readCodexRuntimeLock,
  validateCodexRuntimeLock,
} from '../upstream/runtime.ts';
import type { CodexRuntimeLock } from '../upstream/runtime.ts';
import {
  readDistributionPolicy,
  validateDistributionPolicy,
  verifyDistributionPolicy,
} from './policy.ts';
import type { DistributionPolicy } from './policy.ts';
import { isPatchName, verifyPatches } from './patches.ts';
import type { PatchRecord } from './patches.ts';
import {
  assertPhysicalDirectory,
  copyTree,
  createOutputDirectory,
  inspectTree,
  sha256,
  treeDigest,
} from './tree.ts';
import type { TreeEntry } from './tree.ts';

export interface ClaudePluginArtifact {
  schemaVersion: 2;
  target: 'claude-code';
  name: 'pstack-cc';
  version: string;
  upstream: UpstreamLock;
  dependencies?: DependencyLock;
  codexRuntime: CodexRuntimeLock;
  distributionPolicy?: DistributionPolicy;
  patches: PatchRecord[];
  treeSha256: string;
  marketplaceSha256: string;
  entries: TreeEntry[];
}

export const claudeMarketplace = {
  name: 'pstack-cc',
  owner: { name: 'ystory' },
  plugins: [{ name: 'pstack-cc', source: './plugin' }],
};

async function verifyIdentity(root: string, version: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  if (
    manifest.name !== 'pstack-cc' ||
    manifest.version !== version ||
    manifest.license !== 'MIT'
  )
    throw new Error('Claude artifact identity or license mismatch.');
  if (
    !(await readFile(path.join(root, 'LICENSE'), 'utf8')).includes('Lauren Tan')
  )
    throw new Error('Plugin attribution is missing.');
  if (
    !(
      await readFile(
        path.join(root, 'vendor', 'codex-plugin-cc', 'LICENSE'),
        'utf8',
      )
    ).includes('Apache License')
  )
    throw new Error('Codex runtime Apache license is missing.');
}

export async function buildClaudePluginArtifact(
  projectRoot: string,
  output: string,
): Promise<ClaudePluginArtifact> {
  const verified = await verifyPatches(projectRoot, 'claude-code');
  const upstream = await readLock(projectRoot);
  const dependencies = await readDependencyLock(projectRoot);
  const codexRuntime = await readCodexRuntimeLock(projectRoot);
  if (!codexRuntime)
    throw new Error('Claude artifact requires the pinned Codex runtime.');
  const distributionPolicy = await readDistributionPolicy(projectRoot);
  const plugin = path.join(projectRoot, 'plugin-claude');
  const manifest = JSON.parse(
    await readFile(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  if (typeof manifest.version !== 'string' || !manifest.version)
    throw new Error('Claude plugin version is missing.');
  await verifyIdentity(plugin, manifest.version);
  const entries = await inspectTree(plugin);
  const marketplaceBytes = `${JSON.stringify(claudeMarketplace, null, 2)}\n`;
  const artifact: ClaudePluginArtifact = {
    schemaVersion: 2,
    target: 'claude-code',
    name: 'pstack-cc',
    version: manifest.version,
    upstream,
    ...(dependencies ? { dependencies } : {}),
    codexRuntime,
    ...(distributionPolicy ? { distributionPolicy } : {}),
    patches: verified.patches,
    treeSha256: treeDigest(entries),
    marketplaceSha256: sha256(marketplaceBytes),
    entries,
  };
  await createOutputDirectory(output);
  await copyTree(plugin, path.join(output, 'plugin'));
  await mkdir(path.join(output, '.claude-plugin'));
  await writeFile(
    path.join(output, '.claude-plugin', 'marketplace.json'),
    marketplaceBytes,
    { flag: 'wx', mode: 0o644 },
  );
  await writeFile(
    path.join(output, 'artifact.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  await verifyClaudePluginArtifact(output);
  return artifact;
}

export async function verifyClaudePluginArtifact(
  root: string,
): Promise<ClaudePluginArtifact> {
  await assertPhysicalDirectory(root);
  const value = JSON.parse(
    await readFile(path.join(root, 'artifact.json'), 'utf8'),
  );
  if (
    value.schemaVersion !== 2 ||
    value.target !== 'claude-code' ||
    value.name !== 'pstack-cc' ||
    typeof value.version !== 'string' ||
    !value.version ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.patches) ||
    value.patches.some(
      (patch: PatchRecord) =>
        !patch ||
        !isPatchName(patch.name) ||
        typeof patch.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(patch.sha256),
    ) ||
    new Set(value.patches.map((patch: PatchRecord) => patch.name)).size !==
      value.patches.length
  )
    throw new Error('Invalid Claude artifact.json.');
  validateLock(value.upstream);
  validateCodexRuntimeLock(value.codexRuntime);
  if (value.dependencies !== undefined)
    validateDependencyLock(value.dependencies);
  if (value.distributionPolicy !== undefined)
    validateDistributionPolicy(value.distributionPolicy);
  const metadataEntries = await inspectTree(path.join(root, '.claude-plugin'));
  if (
    metadataEntries.length !== 1 ||
    metadataEntries[0]?.path !== 'marketplace.json' ||
    metadataEntries[0].kind !== 'file'
  )
    throw new Error('Invalid Claude marketplace metadata tree.');
  const marketplaceBytes = await readFile(
    path.join(root, '.claude-plugin', 'marketplace.json'),
  );
  if (
    sha256(marketplaceBytes) !== value.marketplaceSha256 ||
    JSON.stringify(JSON.parse(marketplaceBytes.toString('utf8'))) !==
      JSON.stringify(claudeMarketplace)
  )
    throw new Error('Claude marketplace manifest integrity mismatch.');
  const plugin = path.join(root, 'plugin');
  const entries = await inspectTree(plugin);
  if (
    JSON.stringify(entries) !== JSON.stringify(value.entries) ||
    treeDigest(entries) !== value.treeSha256
  )
    throw new Error(
      'Claude plugin artifact integrity mismatch (paths, bytes, or modes).',
    );
  await verifyDistributionPolicy(plugin, value.distributionPolicy);
  await verifyIdentity(plugin, value.version);
  for (const mapping of (value.codexRuntime as CodexRuntimeLock).codexRuntime
    .files)
    if (
      !entries.some(
        (entry) => entry.kind === 'file' && entry.path === mapping.target,
      )
    )
      throw new Error(
        `Claude artifact is missing runtime source: ${mapping.target}`,
      );
  return value as ClaudePluginArtifact;
}
