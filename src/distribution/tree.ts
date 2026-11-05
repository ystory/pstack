import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';

export interface TreeEntry {
  path: string;
  kind: 'file' | 'directory';
  mode: number;
  sha256?: string;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function inspectTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(absolute: string, relative = ''): Promise<void> {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Unsupported tree entry: ${absolute}`);
    }
    if (relative) {
      entries.push({
        path: relative,
        kind: stat.isDirectory() ? 'directory' : 'file',
        mode: stat.mode & 0o777,
        ...(stat.isFile() ? { sha256: sha256(await readFile(absolute)) } : {}),
      });
    } else if (!stat.isDirectory())
      throw new Error(`Expected directory: ${root}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        await visit(
          path.join(absolute, name),
          relative ? `${relative}/${name}` : name,
        );
      }
    }
  }
  await visit(root);
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export function treeDigest(entries: TreeEntry[]): string {
  return sha256(JSON.stringify(entries));
}

export async function copyTree(
  source: string,
  destination: string,
): Promise<void> {
  const entries = await inspectTree(source);
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, entry.path);
    if (entry.kind === 'directory') await mkdir(target, { recursive: true });
    else await copyFile(path.join(source, entry.path), target);
    await chmod(target, entry.mode);
  }
}

export async function createOutputDirectory(output: string): Promise<void> {
  if (!path.isAbsolute(output))
    throw new Error('Output must be an absolute path.');
  await assertPhysicalDirectory(path.dirname(output));
  await mkdir(output, { recursive: false });
}

export async function assertPhysicalDirectory(
  directory: string,
): Promise<void> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Expected physical directory, not a symlink: ${directory}`);
}
