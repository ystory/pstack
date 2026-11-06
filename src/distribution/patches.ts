import { distributionTarget, projectTargets } from './targets.ts';
import type { TargetId } from './targets.ts';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
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

export class GitPatchConflict extends Error {}

function runGitBytes(
  root: string,
  args: string[],
  input?: Uint8Array,
  env?: NodeJS.ProcessEnv,
): Buffer {
  let temporary: string | undefined;
  let descriptor: number | undefined;
  try {
    if (input !== undefined) {
      temporary = mkdtempSync(path.join(os.tmpdir(), 'pstack-git-input-'));
      const file = path.join(temporary, 'stdin');
      writeFileSync(file, input);
      descriptor = openSync(file, 'r');
    }
    const result = spawnSync('git', args, {
      cwd: root,
      timeout: 30000,
      stdio: [descriptor ?? 'pipe', 'pipe', 'pipe'],
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = `git ${args[0]} failed: ${result.stderr.toString('utf8') || result.stdout.toString('utf8') || result.signal || result.status}`;
      if (args[0] === 'apply' && result.status !== null)
        throw new GitPatchConflict(message);
      throw new Error(message);
    }
    return result.stdout;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export function runGit(
  root: string,
  args: string[],
  input?: Uint8Array,
  env?: NodeJS.ProcessEnv,
): string {
  return runGitBytes(root, args, input, env).toString('utf8');
}

export type PatchReference =
  { scope: 'target'; name: string } | { scope: 'shared'; name: string };

export type FileImage =
  { kind: 'absent' } | { kind: 'file'; bytes: Buffer; mode: number };

export function isPatchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(shared\/)?\d{4}-[a-z0-9-]+\.patch$/.test(value)
  );
}

export function parsePatchReference(value: string): PatchReference {
  if (!isPatchName(value))
    throw new Error(
      'Patch series must contain unique numbered patch basenames or shared/NNNN-name.patch references.',
    );
  return value.startsWith('shared/')
    ? { scope: 'shared', name: value.slice('shared/'.length) }
    : { scope: 'target', name: value };
}

export function patchFile(
  projectRoot: string,
  target: TargetId,
  name: string,
): string {
  const reference = parsePatchReference(name);
  return path.join(
    projectRoot,
    reference.scope === 'shared'
      ? 'patches/shared'
      : distributionTarget(target).patchDirectory,
    reference.name,
  );
}

export async function readPatchSeries(
  projectRoot: string,
  target: TargetId = 'codex',
): Promise<PatchRecord[]> {
  const directory = path.join(
    projectRoot,
    distributionTarget(target).patchDirectory,
  );
  await assertPhysicalDirectory(directory);
  const names = (await readFile(path.join(directory, 'series'), 'utf8'))
    .split(/\r?\n/)
    .filter((name) => name && !name.startsWith('#'));
  if (new Set(names).size !== names.length)
    throw new Error(
      'Patch series must contain unique numbered patch basenames or shared references.',
    );
  const files = names.map((name) => patchFile(projectRoot, target, name));
  for (const directory of new Set(files.map((file) => path.dirname(file))))
    await assertPhysicalDirectory(directory);
  return Promise.all(
    names.map(async (name, index) => {
      const file = files[index]!;
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Patch must be a physical file: ${name}`);
      return { name, sha256: sha256(await readFile(file)) };
    }),
  );
}

export function applyPatchBytes(
  destination: string,
  bytes: Uint8Array,
  reverse = false,
): void {
  const env = patchGitEnvironment(destination);
  const args = ['apply', '--binary', ...(reverse ? ['--reverse'] : [])];
  runGit(destination, [...args, '--check', '-'], bytes, env);
  runGit(destination, [...args, '-'], bytes, env);
}

function patchGitEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)),
  };
}

export function validatePatchPaths(files: readonly string[]): void {
  if (
    !files.length ||
    files.some(
      (file) =>
        !file ||
        path.posix.isAbsolute(file) ||
        file
          .split('/')
          .some(
            (part) => !part || part === '..' || part === '.' || part === '.git',
          ),
    )
  )
    throw new Error(
      'Selected patch paths must be relative files or directories inside plugin/.',
    );
}

export function patchPaths(root: string, bytes: Uint8Array): string[] {
  const records = runGit(
    root,
    ['apply', '--numstat', '-z', '-'],
    bytes,
    patchGitEnvironment(root),
  ).split('\0');
  const files: string[] = [];
  for (let index = 0; index < records.length - 1; index++) {
    const file = records[index]!.split('\t').slice(2).join('\t');
    if (file) files.push(file);
    else files.push(records[++index]!, records[++index]!);
  }
  validatePatchPaths(files);
  return [...new Set(files)];
}

export function patchAdditions(root: string, bytes: Uint8Array): string[] {
  const files = patchPaths(root, bytes);
  const chunks = Buffer.from(bytes)
    .toString('utf8')
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '));
  return chunks.length === files.length
    ? files.filter((_, index) => /^new file mode /m.test(chunks[index]!))
    : [];
}

export async function readFileImages(
  root: string,
  files: readonly string[],
): Promise<Map<string, FileImage>> {
  const images = new Map<string, FileImage>();
  for (const file of files) {
    try {
      const absolute = path.join(root, file);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        images.set(file, { kind: 'absent' });
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Expected physical file: ${file}`);
      images.set(file, {
        kind: 'file',
        bytes: await readFile(absolute),
        mode: stat.mode & 0o777,
      });
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ))
        throw error;
      images.set(file, { kind: 'absent' });
    }
  }
  return images;
}

export async function writeFileImages(
  root: string,
  images: ReadonlyMap<string, FileImage>,
): Promise<void> {
  const boundary = path.resolve(root);
  const actual = await readFileImages(boundary, [...images.keys()]);
  for (const [file, image] of images) {
    if (image.kind !== 'absent') continue;
    let directory = path.join(boundary, file);
    if (actual.get(file)!.kind === 'file') {
      await rm(directory, { force: true });
      directory = path.dirname(directory);
    }
    while (directory !== boundary) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error)) throw error;
        if (error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR') break;
        if (error.code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
  }
  for (const [file, image] of images) {
    if (image.kind !== 'file') continue;
    const absolute = path.join(boundary, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    try {
      await rmdir(absolute);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ))
        throw error;
    }
    await writeFile(absolute, image.bytes);
    await chmod(absolute, image.mode);
  }
}

export function sameFileImage(left: FileImage, right: FileImage): boolean {
  return left.kind === 'absent'
    ? right.kind === 'absent'
    : right.kind === 'file' &&
        left.mode === right.mode &&
        left.bytes.equals(right.bytes);
}

export async function applyPatchSeries(
  projectRoot: string,
  destination: string,
  target: TargetId = 'codex',
): Promise<PatchRecord[]> {
  const patches = await readPatchSeries(projectRoot, target);
  for (const patch of patches) {
    const bytes = await readFile(patchFile(projectRoot, target, patch.name));
    try {
      applyPatchBytes(destination, bytes);
    } catch (error) {
      if (error instanceof GitPatchConflict)
        throw new GitPatchConflict(
          `Patch conflict in ${patch.name}: ${error.message}`,
          { cause: error },
        );
      throw new Error(
        `Cannot apply ${patch.name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
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

async function appendReference(
  projectRoot: string,
  target: TargetId,
  name: string,
): Promise<void> {
  const series = path.join(
    projectRoot,
    distributionTarget(target).patchDirectory,
    'series',
  );
  const previous = await readFile(series, 'utf8');
  await appendFile(
    series,
    `${previous && !previous.endsWith('\n') ? '\n' : ''}${name}\n`,
  );
}

export async function diffPluginTrees(
  previous: string,
  next: string,
  selectedPaths?: readonly string[],
): Promise<Buffer> {
  if (selectedPaths) validatePatchPaths(selectedPaths);
  const paths = selectedPaths
    ? [...new Set(selectedPaths)].filter(
        (file, _, files) =>
          !files.some(
            (parent) => file !== parent && file.startsWith(`${parent}/`),
          ),
      )
    : undefined;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pstack-tree-diff-'));
  try {
    await copyTree(previous, temporary);
    runGit(temporary, ['init', '--quiet']);
    runGit(temporary, ['-c', 'core.fileMode=true', 'add', '--force', '--all']);
    const previousTree = runGit(temporary, ['write-tree']).trim();
    if (!paths) {
      for (const entry of await readdir(temporary))
        if (entry !== '.git')
          await rm(path.join(temporary, entry), {
            recursive: true,
            force: true,
          });
      await copyTree(next, temporary);
    } else {
      for (const file of paths)
        await rm(path.join(temporary, file), { recursive: true, force: true });
      for (const entry of await inspectTree(next)) {
        if (
          !paths.some(
            (file) => entry.path === file || entry.path.startsWith(`${file}/`),
          )
        )
          continue;
        const destination = path.join(temporary, entry.path);
        if (entry.kind === 'directory')
          await mkdir(destination, { recursive: true });
        else {
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(path.join(next, entry.path), destination);
        }
        await chmod(destination, entry.mode);
      }
    }
    runGit(temporary, ['-c', 'core.fileMode=true', 'add', '--force', '--all']);
    return runGitBytes(temporary, [
      '-c',
      'core.fileMode=true',
      'diff',
      '--cached',
      previousTree,
      '--binary',
      '--no-renames',
      '--no-ext-diff',
    ]);
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
  const local = patches.filter(
    (patch) => parsePatchReference(patch.name).scope === 'target',
  );
  if (local.some((patch) => patch.name === name))
    throw new Error('Existing patches are immutable; use a new name.');
  if (local.length && name <= local.at(-1)!.name)
    throw new Error('New patch must sort after the current series.');
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-patch-generate-'),
  );
  try {
    await copyPristinePlugin(projectRoot, temporary, target);
    await applyPatchSeries(projectRoot, temporary, target);
    const patch = await diffPluginTrees(
      temporary,
      path.join(projectRoot, distributionTarget(target).pluginDirectory),
      selectedPaths,
    );
    if (!patch.length) throw new Error('No new plugin changes to record.');
    await writeFile(patchFile(projectRoot, target, name), patch, {
      flag: 'wx',
    });
    await appendReference(projectRoot, target, name);
    return name;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function generateSharedPatch(
  projectRoot: string,
  input: { from: TargetId; name: string; paths: readonly string[] },
): Promise<string> {
  if (!/^\d{4}-[a-z0-9-]+\.patch$/.test(input.name))
    throw new Error('Patch name must be NNNN-lowercase-name.patch.');
  validatePatchPaths(input.paths);
  await verifySnapshot(projectRoot);
  const targets = await projectTargets(projectRoot);
  if (targets.length < 2 || !targets.includes(input.from))
    throw new Error(
      'Shared patches require both complete host targets and an explicit source target.',
    );
  const plans = await Promise.all(
    targets.map((target) => readPatchSeries(projectRoot, target)),
  );
  const shared = plans.map((plan) =>
    plan
      .filter((patch) => parsePatchReference(patch.name).scope === 'shared')
      .map((patch) => patch.name),
  );
  if (shared.some((plan) => JSON.stringify(plan) !== JSON.stringify(shared[0])))
    throw new Error('Shared patch order differs between host series.');
  const name = `shared/${input.name}`;
  if (shared[0]!.includes(name))
    throw new Error('Existing patches are immutable; use a new name.');
  if (shared[0]!.length && name <= shared[0]!.at(-1)!)
    throw new Error(
      'New shared patch must sort after the current shared series.',
    );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-shared-patch-'),
  );
  try {
    const baselines = new Map<TargetId, string>();
    for (const target of targets) {
      await inspectTree(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
      );
      const baseline = path.join(temporary, target);
      await copyPristinePlugin(projectRoot, baseline, target);
      await applyPatchSeries(projectRoot, baseline, target);
      baselines.set(target, baseline);
    }
    const source = path.join(
      projectRoot,
      distributionTarget(input.from).pluginDirectory,
    );
    const bytes = await diffPluginTrees(
      baselines.get(input.from)!,
      source,
      input.paths,
    );
    if (!bytes.length) throw new Error('No new plugin changes to record.');
    const files = patchPaths(temporary, bytes);
    for (const target of targets) {
      const baseline = baselines.get(target)!;
      const before = await readFileImages(baseline, files);
      applyPatchBytes(baseline, bytes);
      const after = await readFileImages(baseline, files);
      const actual = await readFileImages(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
        files,
      );
      for (const file of files)
        if (
          !sameFileImage(actual.get(file)!, before.get(file)!) &&
          !sameFileImage(actual.get(file)!, after.get(file)!)
        )
          throw new Error(
            `Unrecorded ${target} edit conflicts with shared patch: ${file}`,
          );
      const staged = path.join(temporary, `actual-${target}`);
      await copyTree(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
        staged,
      );
      await writeFileImages(staged, after);
    }
    await mkdir(path.join(projectRoot, 'patches/shared'), { recursive: true });
    await assertPhysicalDirectory(path.join(projectRoot, 'patches/shared'));
    await writeFile(patchFile(projectRoot, input.from, name), bytes, {
      flag: 'wx',
    });
    for (const target of targets) {
      await writeFileImages(
        path.join(projectRoot, distributionTarget(target).pluginDirectory),
        await readFileImages(baselines.get(target)!, files),
      );
      await appendReference(projectRoot, target, name);
    }
    return name;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
