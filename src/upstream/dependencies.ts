import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { computeSnapshotDigest } from './snapshot.ts';
import { copyTree } from '../distribution/tree.ts';
import type { TargetId } from '../distribution/targets.ts';
import { copyCodexRuntime } from './runtime.ts';
import { applyDistributionPolicy } from '../distribution/policy.ts';

export const dependencyFiles = [
  { source: 'LICENSE', target: 'licenses/cursor-team-kit/LICENSE' },
  ...['control-ui', 'control-cli', 'deslop'].map((name) => ({
    source: `skills/${name}/SKILL.md`,
    target: `skills/${name}/SKILL.md`,
  })),
];

export interface DependencyLock {
  schemaVersion: 1;
  cursorTeamKit: {
    repository: 'https://github.com/cursor/plugins';
    ref: 'main';
    path: 'cursor-team-kit';
    revision: string;
    pathRevision: string;
    snapshotSha256: string;
    files: { source: string; target: string }[];
  };
}

export function validateDependencyLock(value: unknown): DependencyLock {
  const lock = value as DependencyLock | undefined;
  const source = lock?.cursorTeamKit;
  if (
    lock?.schemaVersion !== 1 ||
    source?.repository !== 'https://github.com/cursor/plugins' ||
    source.ref !== 'main' ||
    source.path !== 'cursor-team-kit' ||
    !/^[0-9a-f]{40}$/.test(source.revision) ||
    !/^[0-9a-f]{40}$/.test(source.pathRevision) ||
    !/^[0-9a-f]{64}$/.test(source.snapshotSha256) ||
    JSON.stringify(source.files) !== JSON.stringify(dependencyFiles)
  )
    throw new Error('Invalid dependencies.lock.json.');
  return lock;
}

export async function readDependencyLock(
  projectRoot: string,
): Promise<DependencyLock | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(
      path.join(projectRoot, 'dependencies.lock.json'),
      'utf8',
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
  return validateDependencyLock(JSON.parse(bytes));
}

export async function verifyDependencies(
  projectRoot: string,
): Promise<DependencyLock | undefined> {
  const lock = await readDependencyLock(projectRoot);
  if (!lock) {
    try {
      await lstat(path.join(projectRoot, 'upstream', 'cursor-team-kit'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    }
    throw new Error(
      'Selected cursor-team-kit sources require dependencies.lock.json.',
    );
  }
  const digest = await computeSnapshotDigest(
    path.join(projectRoot, 'upstream', 'cursor-team-kit'),
  );
  if (digest !== lock.cursorTeamKit.snapshotSha256)
    throw new Error('cursor-team-kit selected snapshot integrity mismatch.');
  return lock;
}

export async function copyPristinePlugin(
  projectRoot: string,
  destination: string,
  target: TargetId = 'codex',
): Promise<void> {
  await copyTree(path.join(projectRoot, 'upstream', 'pstack'), destination);
  const lock = await verifyDependencies(projectRoot);
  for (const mapping of lock?.cursorTeamKit.files ?? []) {
    const source = path.join(
      projectRoot,
      'upstream',
      'cursor-team-kit',
      mapping.source,
    );
    const target = path.join(destination, mapping.target);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, (await lstat(source)).mode & 0o777);
  }
  await applyDistributionPolicy(projectRoot, destination);
  if (target === 'claude-code')
    await copyCodexRuntime(projectRoot, destination);
}
