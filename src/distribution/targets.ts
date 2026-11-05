import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type TargetId = 'codex' | 'claude-code';

const targets = {
  codex: {
    id: 'codex',
    name: 'pstack-for-codex',
    pluginDirectory: 'plugin',
    patchDirectory: 'patches',
    manifest: 'plugin.json',
    marketplaceDirectory: '.agents/plugins',
  },
  'claude-code': {
    id: 'claude-code',
    name: 'pstack-cc',
    pluginDirectory: 'plugin-claude',
    patchDirectory: 'patches/claude',
    manifest: '.claude-plugin/plugin.json',
    marketplaceDirectory: '.claude-plugin',
  },
} as const;

export function distributionTarget(id: TargetId = 'codex') {
  if (!Object.hasOwn(targets, id))
    throw new Error(`Unsupported distribution target: ${String(id)}.`);
  return targets[id];
}

export function parseTarget(value: string | undefined): TargetId {
  if (value === undefined) return 'codex';
  if (value === 'codex' || value === 'claude-code') return value;
  throw new Error(`Unsupported distribution target: ${value}.`);
}

export async function projectTargets(projectRoot: string): Promise<TargetId[]> {
  const present = await Promise.all(
    [
      'plugin-claude',
      'patches/claude',
      'codex-runtime.lock.json',
      'upstream/codex-runtime',
    ].map(async (file) => {
      try {
        await lstat(path.join(projectRoot, file));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }),
  );
  if (!present.some(Boolean)) return ['codex'];
  if (!present.every(Boolean))
    throw new Error(
      'Claude distribution requires plugin-claude, patches/claude, codex-runtime.lock.json, and upstream/codex-runtime together.',
    );
  return ['codex', 'claude-code'];
}
