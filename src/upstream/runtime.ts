import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { computeSnapshotDigest } from './snapshot.ts';
import { inspectTree } from '../distribution/tree.ts';

export interface CodexRuntimeLock {
  schemaVersion: 1;
  codexRuntime: {
    repository: 'https://github.com/openai/codex-plugin-cc';
    revision: string;
    version: string;
    snapshotSha256: string;
    files: { source: string; target: string }[];
  };
}

function safeFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
}

export function validateCodexRuntimeLock(value: unknown): CodexRuntimeLock {
  const lock = value as CodexRuntimeLock | undefined;
  const runtime = lock?.codexRuntime;
  if (
    lock?.schemaVersion !== 1 ||
    runtime?.repository !== 'https://github.com/openai/codex-plugin-cc' ||
    typeof runtime.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(runtime.revision) ||
    typeof runtime.version !== 'string' ||
    !runtime.version.trim() ||
    typeof runtime.snapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(runtime.snapshotSha256) ||
    !Array.isArray(runtime.files) ||
    !runtime.files.length ||
    runtime.files.some(
      (file) =>
        !file ||
        !safeFile(file.source) ||
        file.target !== `vendor/codex-plugin-cc/${file.source}`,
    ) ||
    new Set(runtime.files.map((file) => file.source)).size !==
      runtime.files.length ||
    !['LICENSE', 'NOTICE', 'plugins/codex/.claude-plugin/plugin.json'].every(
      (source) => runtime.files.some((file) => file.source === source),
    )
  )
    throw new Error('Invalid codex-runtime.lock.json.');
  return lock;
}

export async function readCodexRuntimeLock(
  projectRoot: string,
): Promise<CodexRuntimeLock | undefined> {
  try {
    return validateCodexRuntimeLock(
      JSON.parse(
        await readFile(
          path.join(projectRoot, 'codex-runtime.lock.json'),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function verifyCodexRuntime(
  projectRoot: string,
): Promise<CodexRuntimeLock | undefined> {
  const lock = await readCodexRuntimeLock(projectRoot);
  const root = path.join(projectRoot, 'upstream', 'codex-runtime');
  if (!lock) {
    try {
      await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    throw new Error(
      'Selected Codex runtime sources require codex-runtime.lock.json.',
    );
  }
  const entries = await inspectTree(root);
  const files = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.path)
    .sort();
  if (
    JSON.stringify(files) !==
      JSON.stringify(
        lock.codexRuntime.files.map((file) => file.source).sort(),
      ) ||
    (await computeSnapshotDigest(root)) !== lock.codexRuntime.snapshotSha256
  )
    throw new Error('Codex runtime selected snapshot integrity mismatch.');
  if (
    !(await readFile(path.join(root, 'LICENSE'), 'utf8')).includes(
      'Apache License',
    )
  )
    throw new Error('Codex runtime Apache license is missing.');
  const manifest = JSON.parse(
    await readFile(
      path.join(root, 'plugins/codex/.claude-plugin/plugin.json'),
      'utf8',
    ),
  );
  if (
    manifest.name !== 'codex' ||
    manifest.version !== lock.codexRuntime.version
  )
    throw new Error('Codex runtime manifest version mismatch.');
  if (!(await readFile(path.join(root, 'NOTICE'), 'utf8')).trim())
    throw new Error('Codex runtime NOTICE is missing.');
  return lock;
}

export async function copyCodexRuntime(
  projectRoot: string,
  destination: string,
): Promise<void> {
  const lock = await verifyCodexRuntime(projectRoot);
  if (!lock)
    throw new Error('Claude distribution requires codex-runtime.lock.json.');
  for (const mapping of lock.codexRuntime.files) {
    const source = path.join(
      projectRoot,
      'upstream',
      'codex-runtime',
      mapping.source,
    );
    const target = path.join(destination, mapping.target);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, (await lstat(source)).mode & 0o777);
  }
}
