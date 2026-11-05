import { distributionTarget } from './targets.ts';
import type { TargetId } from './targets.ts';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertPhysicalDirectory,
  copyTree,
  inspectTree,
  sha256,
  treeDigest,
} from './tree.ts';
import { verifySnapshot } from '../upstream/verify.ts';
import { copyPristinePlugin } from '../upstream/dependencies.ts';
import { readDistributionPolicy, verifyDistributionPolicy } from './policy.ts';

export interface PatchRecord {
  name: string;
  sha256: string;
}

export function runGit(
  root: string,
  args: string[],
  input?: Uint8Array,
  env?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    input,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function readPatchSeries(
  projectRoot: string,
  target: TargetId = 'codex',
): Promise<PatchRecord[]> {
  await assertPhysicalDirectory(
    path.join(projectRoot, distributionTarget(target).patchDirectory),
  );
  const names = (
    await readFile(
      path.join(
        projectRoot,
        distributionTarget(target).patchDirectory,
        'series',
      ),
      'utf8',
    )
  )
    .split(/\r?\n/)
    .filter((name) => name && !name.startsWith('#'));
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !/^\d{4}-[a-z0-9-]+\.patch$/.test(name))
  ) {
    throw new Error(
      'Patch series must contain unique numbered patch basenames.',
    );
  }
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(
        projectRoot,
        distributionTarget(target).patchDirectory,
        name,
      );
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Patch must be a physical file: ${name}`);
      return { name, sha256: sha256(await readFile(file)) };
    }),
  );
}

export async function applyPatchSeries(
  projectRoot: string,
  destination: string,
  target: TargetId = 'codex',
): Promise<PatchRecord[]> {
  const patches = await readPatchSeries(projectRoot, target);
  const env = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(destination)),
  };
  for (const patch of patches) {
    const bytes = await readFile(
      path.join(
        projectRoot,
        distributionTarget(target).patchDirectory,
        patch.name,
      ),
    );
    try {
      runGit(destination, ['apply', '--check', '--binary', '-'], bytes, env);
      runGit(destination, ['apply', '--binary', '-'], bytes, env);
    } catch (error) {
      throw new Error(
        `Patch conflict in ${patch.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return patches;
}

export async function verifyPatches(
  projectRoot: string,
  target: TargetId = 'codex',
): Promise<{ files: number; digest: string; patches: PatchRecord[] }> {
  await verifySnapshot(projectRoot);
  await verifyDistributionPolicy(
    path.join(projectRoot, distributionTarget(target).pluginDirectory),
    await readDistributionPolicy(projectRoot),
  );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-patch-replay-'),
  );
  try {
    await copyPristinePlugin(projectRoot, temporary, target);
    const patches = await applyPatchSeries(projectRoot, temporary, target);
    const actual = await inspectTree(temporary);
    const expected = await inspectTree(
      path.join(projectRoot, distributionTarget(target).pluginDirectory),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
      const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
      const changed = [
        ...new Set([...actualMap.keys(), ...expectedMap.keys()]),
      ].filter(
        (file) =>
          JSON.stringify(actualMap.get(file)) !==
          JSON.stringify(expectedMap.get(file)),
      );
      throw new Error(
        `Patch replay differs from plugin bytes or modes: ${changed.join(', ')}`,
      );
    }
    return {
      files: actual.filter((entry) => entry.kind === 'file').length,
      digest: treeDigest(actual),
      patches,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function generatePatch(
  projectRoot: string,
  name: string,
  selectedPaths?: string[],
  target: TargetId = 'codex',
): Promise<string> {
  if (!/^\d{4}-[a-z0-9-]+\.patch$/.test(name))
    throw new Error('Patch name must be NNNN-lowercase-name.patch.');
  await verifySnapshot(projectRoot);
  const patches = await readPatchSeries(projectRoot, target);
  if (patches.some((patch) => patch.name === name))
    throw new Error('Existing patches are immutable; use a new name.');
  if (patches.length && name <= patches.at(-1)!.name)
    throw new Error('New patch must sort after the current series.');
  if (
    selectedPaths &&
    (!selectedPaths.length ||
      selectedPaths.some(
        (file) =>
          !file ||
          path.posix.isAbsolute(file) ||
          file
            .split('/')
            .some(
              (part) =>
                !part || part === '..' || part === '.' || part === '.git',
            ),
      ))
  )
    throw new Error(
      'Selected patch paths must be relative files or directories inside plugin/.',
    );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-patch-generate-'),
  );
  try {
    await copyPristinePlugin(projectRoot, temporary, target);
    await applyPatchSeries(projectRoot, temporary, target);
    const previousFiles = new Set(
      (await inspectTree(temporary))
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.path),
    );
    runGit(temporary, ['init', '--quiet']);
    runGit(temporary, ['-c', 'core.fileMode=true', 'add', '--force', '--all']);
    if (!selectedPaths) {
      for (const entry of await readdir(temporary))
        if (entry !== '.git')
          await rm(path.join(temporary, entry), {
            recursive: true,
            force: true,
          });
      await copyTree(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
        temporary,
      );
    } else {
      for (const file of selectedPaths)
        await rm(path.join(temporary, file), { recursive: true, force: true });
      for (const entry of await inspectTree(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
      )) {
        if (
          !selectedPaths.some(
            (file) => entry.path === file || entry.path.startsWith(`${file}/`),
          )
        )
          continue;
        const destinationFile = path.join(temporary, entry.path);
        if (entry.kind === 'directory')
          await mkdir(destinationFile, { recursive: true });
        else {
          await mkdir(path.dirname(destinationFile), { recursive: true });
          await copyFile(
            path.join(
              projectRoot,
              distributionTarget(target).pluginDirectory,
              entry.path,
            ),
            destinationFile,
          );
        }
        await chmod(destinationFile, entry.mode);
      }
    }
    const newFiles = (await inspectTree(temporary))
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          !entry.path.startsWith('.git/') &&
          !previousFiles.has(entry.path),
      )
      .map((entry) => entry.path);
    if (newFiles.length)
      runGit(temporary, [
        'add',
        '--intent-to-add',
        '--force',
        '--',
        ...newFiles,
      ]);
    const patch = runGit(temporary, [
      '-c',
      'core.fileMode=true',
      'diff',
      '--binary',
      '--no-ext-diff',
    ]);
    if (!patch.trim()) throw new Error('No new plugin changes to record.');
    await writeFile(
      path.join(projectRoot, distributionTarget(target).patchDirectory, name),
      patch,
      {
        flag: 'wx',
      },
    );
    await writeFile(
      path.join(
        projectRoot,
        distributionTarget(target).patchDirectory,
        'series',
      ),
      `${[...patches.map((patch) => patch.name), name].join('\n')}\n`,
    );
    return name;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
