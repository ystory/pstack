import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyPatchSeries,
  readPatchSeries,
  runGit,
} from '../distribution/patches.ts';
import {
  createOutputDirectory,
  copyTree,
  inspectTree,
  treeDigest,
} from '../distribution/tree.ts';
import { projectTargets, distributionTarget } from '../distribution/targets.ts';
import { verifySnapshot } from './verify.ts';
import { readCodexRuntimeLock, verifyCodexRuntime } from './runtime.ts';
import { readLock } from './lock.ts';
import { computeSnapshotDigest } from './snapshot.ts';
import { copyPristinePlugin, readDependencyLock } from './dependencies.ts';
import { readDistributionPolicy } from '../distribution/policy.ts';
import { DistributionPolicyConflict } from '../distribution/policy.ts';

async function exportSnapshot(
  source: string,
  revision: string,
  directory: string,
  output: string,
  selectedFiles: string[] = [],
): Promise<void> {
  const sourceEntries = runGit(source, [
    'ls-tree',
    '-r',
    `${revision}:${directory}`,
    '--',
    ...selectedFiles,
  ])
    .trim()
    .split('\n');
  if (
    sourceEntries.some(
      (entry) => !/^(100644|100755) blob [0-9a-f]{40}\t/.test(entry),
    )
  )
    throw new Error(
      'Candidate source contains symlinks or unsupported entries.',
    );
  await mkdir(output, { recursive: true });
  const archive = spawnSync(
    'git',
    [
      '-c',
      'tar.umask=0022',
      'archive',
      `${revision}:${directory}`,
      ...selectedFiles,
    ],
    { cwd: source, timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (archive.error) throw archive.error;
  if (archive.status !== 0)
    throw new Error(
      `Cannot export ${directory} candidate: ${archive.stderr.toString()}`,
    );
  const unpack = spawnSync('tar', ['-xf', '-', '-C', output], {
    input: archive.stdout,
    timeout: 30000,
  });
  if (unpack.error) throw unpack.error;
  if (unpack.status !== 0)
    throw new Error(`Cannot unpack candidate: ${unpack.stderr.toString()}`);
  await inspectTree(output);
}

async function writeSourceDifference(
  previous: string,
  candidate: string,
  file: string,
): Promise<void> {
  const difference = spawnSync(
    'git',
    ['diff', '--no-index', '--binary', '--no-ext-diff', previous, candidate],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (difference.error) throw difference.error;
  if (difference.status !== 0 && difference.status !== 1)
    throw new Error(`Cannot compare candidate source: ${difference.stderr}`);
  await writeFile(file, difference.stdout);
}

export async function createUpstreamCandidate(
  projectRoot: string,
  source: string,
  revision: string,
  output: string,
): Promise<{
  status: 'ready-for-review' | 'patch-conflict' | 'source-policy-conflict';
  output: string;
}> {
  if (!path.isAbsolute(source) || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error(
      'Candidate requires an absolute Git checkout and full commit SHA.',
    );
  if (runGit(source, ['rev-parse', `${revision}^{commit}`]).trim() !== revision)
    throw new Error('Candidate revision must identify a commit.');
  const origin = runGit(source, ['remote', 'get-url', 'origin'])
    .trim()
    .replace(/\.git$/, '');
  if (
    ![
      'https://github.com/cursor/plugins',
      'git@github.com:cursor/plugins',
    ].includes(origin)
  )
    throw new Error('Candidate source origin must be cursor/plugins.');
  await verifySnapshot(projectRoot);
  await verifyCodexRuntime(projectRoot);
  const targets = await projectTargets(projectRoot);
  await createOutputDirectory(output);
  const snapshotRoot = path.join(output, 'upstream', 'pstack');
  await exportSnapshot(source, revision, 'pstack', snapshotRoot);
  await writeSourceDifference(
    path.join(projectRoot, 'upstream', 'pstack'),
    snapshotRoot,
    path.join(output, 'upstream-changes.diff'),
  );
  const manifest = JSON.parse(
    await readFile(
      path.join(snapshotRoot, '.cursor-plugin', 'plugin.json'),
      'utf8',
    ),
  );
  if (manifest.name !== 'pstack' || typeof manifest.version !== 'string')
    throw new Error('Candidate is not a pstack snapshot.');
  const lock = await readLock(projectRoot);
  const distributionPolicy = await readDistributionPolicy(projectRoot);
  if (distributionPolicy)
    await writeFile(
      path.join(output, 'distribution-policy.json'),
      `${JSON.stringify(distributionPolicy, null, 2)}\n`,
    );
  const dependencies = await readDependencyLock(projectRoot);
  let candidateDependencies;
  if (dependencies) {
    const dependencyRoot = path.join(output, 'upstream', 'cursor-team-kit');
    await exportSnapshot(
      source,
      revision,
      'cursor-team-kit',
      dependencyRoot,
      dependencies.cursorTeamKit.files.map((file) => file.source),
    );
    candidateDependencies = {
      ...dependencies,
      cursorTeamKit: {
        ...dependencies.cursorTeamKit,
        revision,
        pathRevision: runGit(source, [
          'log',
          '-1',
          '--format=%H',
          revision,
          '--',
          'cursor-team-kit',
        ]).trim(),
        snapshotSha256: await computeSnapshotDigest(dependencyRoot),
      },
    };
    await writeFile(
      path.join(output, 'dependencies.lock.json'),
      `${JSON.stringify(candidateDependencies, null, 2)}\n`,
    );
    await writeSourceDifference(
      path.join(projectRoot, 'upstream', 'cursor-team-kit'),
      dependencyRoot,
      path.join(output, 'dependency-changes.diff'),
    );
  }
  const candidateLock = {
    ...lock,
    pstack: {
      ...lock.pstack,
      revision,
      pathRevision: runGit(source, [
        'log',
        '-1',
        '--format=%H',
        revision,
        '--',
        'pstack',
      ]).trim(),
      version: manifest.version,
      snapshotSha256: await computeSnapshotDigest(snapshotRoot),
    },
    codex: { ...lock.codex, testedVersions: [] },
  };
  await writeFile(
    path.join(output, 'upstream.lock.json'),
    `${JSON.stringify(candidateLock, null, 2)}\n`,
  );
  const runtime = await readCodexRuntimeLock(projectRoot);
  if (runtime) {
    await copyTree(
      path.join(projectRoot, 'upstream', 'codex-runtime'),
      path.join(output, 'upstream', 'codex-runtime'),
    );
    await copyFile(
      path.join(projectRoot, 'codex-runtime.lock.json'),
      path.join(output, 'codex-runtime.lock.json'),
    );
  }
  await copyTree(
    path.join(projectRoot, 'patches'),
    path.join(output, 'patches'),
  );
  const targetReports = [];
  for (const target of targets) {
    const pluginRoot = path.join(
      output,
      distributionTarget(target).pluginDirectory,
    );
    let status:
      'ready-for-review' | 'patch-conflict' | 'source-policy-conflict' =
      'ready-for-review';
    let conflict: string | undefined;
    try {
      await copyPristinePlugin(output, pluginRoot, target);
      await applyPatchSeries(projectRoot, pluginRoot, target);
    } catch (error) {
      status =
        error instanceof DistributionPolicyConflict
          ? 'source-policy-conflict'
          : 'patch-conflict';
      conflict = error instanceof Error ? error.message : String(error);
    }
    const patches = await readPatchSeries(projectRoot, target);
    const failedIndex = conflict
      ? patches.findIndex((patch) => conflict?.includes(patch.name))
      : -1;
    targetReports.push({
      target,
      status,
      patches,
      appliedPatches:
        status === 'ready-for-review'
          ? patches.map((patch) => patch.name)
          : patches
              .slice(0, Math.max(0, failedIndex))
              .map((patch) => patch.name),
      ...(failedIndex >= 0 ? { failedPatch: patches[failedIndex]!.name } : {}),
      unappliedPatches:
        status === 'ready-for-review'
          ? []
          : patches.slice(Math.max(0, failedIndex)).map((patch) => patch.name),
      pluginTreeSha256: treeDigest(await inspectTree(pluginRoot)),
      ...(conflict ? { conflict } : {}),
    });
  }
  const codex = targetReports[0]!;
  const failure = targetReports.find(
    (report) => report.status !== 'ready-for-review',
  );
  const status = failure?.status ?? 'ready-for-review';
  const conflict = failure?.conflict;
  const report = {
    schemaVersion: 1,
    status,
    previous: lock.pstack,
    candidate: candidateLock.pstack,
    patches: codex.patches,
    appliedPatches: codex.appliedPatches,
    ...(codex.failedPatch ? { failedPatch: codex.failedPatch } : {}),
    unappliedPatches: codex.unappliedPatches,
    targets: targetReports,
    ...(failure ? { failedTarget: failure.target } : {}),
    ...(runtime ? { codexRuntime: runtime } : {}),
    upstreamChanges: 'upstream-changes.diff',
    ...(distributionPolicy ? { distributionPolicy } : {}),
    ...(candidateDependencies
      ? {
          previousDependencies: dependencies,
          candidateDependencies,
          dependencyChanges: 'dependency-changes.diff',
        }
      : {}),
    pluginTreeSha256: codex.pluginTreeSha256,
    ...(conflict ? { conflict } : {}),
    review: [
      'Review upstream changes and adaptation semantics.',
      'Resolve reported patch conflicts and regenerate new adaptation patches.',
      'Run offline validation and isolated workflows for every candidate target.',
      'Obtain approval before replacing the pinned source or distributing the candidate.',
    ],
  };
  await writeFile(
    path.join(output, 'candidate-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { status, output };
}
