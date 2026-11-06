import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPluginArtifact, verifyPluginArtifact } from './artifact.ts';
import type { PluginArtifact } from './artifact.ts';
import {
  buildClaudePluginArtifact,
  verifyClaudePluginArtifact,
} from './claude-artifact.ts';
import type { ClaudePluginArtifact } from './claude-artifact.ts';
import { distributionTarget } from './targets.ts';
import type { TargetId } from './targets.ts';
import { assertPhysicalDirectory } from './tree.ts';

export type DistributionArtifact = PluginArtifact | ClaudePluginArtifact;

export async function buildDistributionArtifact(
  projectRoot: string,
  output: string,
  target: TargetId = 'codex',
): Promise<DistributionArtifact> {
  distributionTarget(target);
  return target === 'codex'
    ? buildPluginArtifact(projectRoot, output)
    : buildClaudePluginArtifact(projectRoot, output);
}

export async function verifyDistributionArtifact(
  root: string,
): Promise<DistributionArtifact> {
  await assertPhysicalDirectory(root);
  const metadataStat = await lstat(path.join(root, 'artifact.json'));
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile())
    throw new Error('Artifact metadata must be a physical file.');
  const metadata = JSON.parse(
    await readFile(path.join(root, 'artifact.json'), 'utf8'),
  );
  if (metadata.schemaVersion === 2 && metadata.target === 'claude-code')
    return verifyClaudePluginArtifact(root);
  if (
    metadata.schemaVersion === 1 &&
    metadata.name === 'pstack-codex' &&
    metadata.target === undefined
  )
    return verifyPluginArtifact(root);
  throw new Error('Unsupported distribution artifact target or schema.');
}

export function artifactTarget(artifact: DistributionArtifact): TargetId {
  return artifact.schemaVersion === 2 ? artifact.target : 'codex';
}
