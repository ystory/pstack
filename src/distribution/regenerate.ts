import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { distributionTarget, projectTargets } from './targets.ts';
import type { TargetId } from './targets.ts';
import { readCodexRuntimeLock } from '../upstream/runtime.ts';
import { readLock } from '../upstream/lock.ts';
import { verifySnapshot } from '../upstream/verify.ts';
import { readDependencyLock } from '../upstream/dependencies.ts';
import { readDistributionPolicy } from './policy.ts';
import {
  applyPatchBytes,
  diffPluginTrees,
  generatePatch,
  GitPatchConflict,
  parsePatchReference,
  patchAdditions,
  patchFile,
  patchPaths,
  readFileImages,
  readPatchSeries,
  sameFileImage,
  verifyPatches,
  writeFileImages,
} from './patches.ts';
import type { FileImage } from './patches.ts';
import { copyPristinePlugin } from '../upstream/dependencies.ts';
import { copyTree, createOutputDirectory, inspectTree } from './tree.ts';

async function regenerateTargetPatches(
  candidate: string,
  output: string,
  target: TargetId,
): Promise<{ files: number; digest: string }> {
  if (!path.isAbsolute(candidate))
    throw new Error('Candidate must be an absolute path.');
  await verifySnapshot(candidate);
  const candidateReport = JSON.parse(
    await readFile(path.join(candidate, 'candidate-report.json'), 'utf8'),
  );
  const originalReport =
    candidateReport.targets?.find(
      (report: { target: string }) => report.target === target,
    ) ?? candidateReport;
  const originalPatches = await readPatchSeries(candidate, target);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-candidate-regenerate-'),
  );
  try {
    for (const directory of [
      'upstream',
      distributionTarget(target).pluginDirectory,
    ])
      await copyTree(
        path.join(candidate, directory),
        path.join(temporary, directory),
      );
    await copyFile(
      path.join(candidate, 'upstream.lock.json'),
      path.join(temporary, 'upstream.lock.json'),
    );
    if (await readDependencyLock(candidate))
      await copyFile(
        path.join(candidate, 'dependencies.lock.json'),
        path.join(temporary, 'dependencies.lock.json'),
      );
    if (await readDistributionPolicy(candidate))
      await copyFile(
        path.join(candidate, 'distribution-policy.json'),
        path.join(temporary, 'distribution-policy.json'),
      );
    if (await readCodexRuntimeLock(candidate))
      await copyFile(
        path.join(candidate, 'codex-runtime.lock.json'),
        path.join(temporary, 'codex-runtime.lock.json'),
      );
    await mkdir(
      path.join(temporary, distributionTarget(target).patchDirectory),
      { recursive: true },
    );
    await writeFile(
      path.join(temporary, distributionTarget(target).patchDirectory, 'series'),
      '',
    );
    const groups: {
      name: string;
      status: 'generated' | 'no-remaining-changes';
    }[] = [];
    for (const patch of originalPatches) {
      if (patch.name === '9999-candidate-remainder.patch') continue;
      const bytes = await readFile(
        patchFile(candidate, target, patch.name),
        'utf8',
      );
      const files = [
        ...new Set(
          [
            ...bytes.matchAll(/^\+\+\+ b\/(.+)$/gm),
            ...bytes.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm),
          ].map((match) => match[1]!),
        ),
      ];
      if (!files.length) {
        groups.push({ name: patch.name, status: 'no-remaining-changes' });
        continue;
      }
      try {
        await generatePatch(temporary, patch.name, files, target);
        groups.push({ name: patch.name, status: 'generated' });
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message === 'No new plugin changes to record.'
        ))
          throw error;
        groups.push({ name: patch.name, status: 'no-remaining-changes' });
      }
    }
    try {
      await generatePatch(
        temporary,
        '9999-candidate-remainder.patch',
        undefined,
        target,
      );
      groups.push({
        name: '9999-candidate-remainder.patch',
        status: 'generated',
      });
    } catch (error) {
      if (!(
        error instanceof Error &&
        error.message === 'No new plugin changes to record.'
      ))
        throw error;
    }
    const verified = await verifyPatches(temporary, target);
    await createOutputDirectory(output);
    await copyTree(
      path.join(temporary, distributionTarget(target).patchDirectory),
      path.join(output, 'patches'),
    );
    await writeFile(
      path.join(output, 'regeneration-report.json'),
      `${JSON.stringify({ schemaVersion: 1, target, source: await readLock(candidate), codexRuntime: await readCodexRuntimeLock(candidate), originalCandidateStatus: originalReport.status, originalConflict: originalReport.conflict ?? null, originalUnappliedPatches: originalReport.unappliedPatches ?? [], originalPatches, regeneratedPatches: verified.patches, groups, pluginTreeSha256: verified.digest, verification: 'Full byte and mode replay equality only; original failed patches are not evidence of semantic preservation or runtime compatibility. Review the complete target tree and run its workflows before integration.' }, null, 2)}\n`,
    );
    return { files: verified.files, digest: verified.digest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function regenerateCandidatePatches(
  candidate: string,
  output: string,
): Promise<{ files: number; digest: string }> {
  if (!path.isAbsolute(candidate))
    throw new Error('Candidate must be an absolute path.');
  await verifySnapshot(candidate);
  const targets = await projectTargets(candidate);
  const plans = await Promise.all(
    targets.map((target) => readPatchSeries(candidate, target)),
  );
  if (
    plans.some((plan) =>
      plan.some((patch) => parsePatchReference(patch.name).scope === 'shared'),
    )
  )
    return regenerateSharedCandidate(candidate, output, targets);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-regenerate-targets-'),
  );
  try {
    const results = [];
    for (const target of targets) {
      const directory = path.join(temporary, target);
      const verified = await regenerateTargetPatches(
        candidate,
        directory,
        target,
      );
      results.push({
        target,
        ...verified,
        report: JSON.parse(
          await readFile(
            path.join(directory, 'regeneration-report.json'),
            'utf8',
          ),
        ),
      });
    }
    await createOutputDirectory(output);
    for (const result of results)
      await copyTree(
        path.join(temporary, result.target, 'patches'),
        path.join(output, distributionTarget(result.target).patchDirectory),
      );
    const codex = results[0]!;
    await writeFile(
      path.join(output, 'regeneration-report.json'),
      `${JSON.stringify({ ...codex.report, targets: results.map((result) => result.report) }, null, 2)}\n`,
    );
    return { files: codex.files, digest: codex.digest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

type RegenerationNode = {
  name: string;
  bytes: Buffer;
  paths: string[];
  after: Map<string, FileImage>;
};

type RegenerationPlan = {
  target: TargetId;
  nodes: RegenerationNode[];
  position: number;
  directory: string;
  groups: { name: string; status: 'generated' | 'no-remaining-changes' }[];
};

async function patchForNode(
  directory: string,
  node: RegenerationNode,
): Promise<Buffer> {
  const next = await mkdtemp(path.join(os.tmpdir(), 'pstack-node-output-'));
  try {
    await copyTree(directory, next);
    let applied = false;
    try {
      applyPatchBytes(next, node.bytes);
      applied = true;
    } catch (error) {
      if (!(error instanceof GitPatchConflict)) throw error;
    }
    if (applied) {
      const actual = await readFileImages(next, node.paths);
      if (
        node.paths.every((file) =>
          sameFileImage(actual.get(file)!, node.after.get(file)!),
        )
      )
        return node.bytes;
    }
    await writeFileImages(next, node.after);
    return Buffer.from(await diffPluginTrees(directory, next, node.paths));
  } finally {
    await rm(next, { recursive: true, force: true });
  }
}

async function reconstructNodes(
  candidate: string,
  target: TargetId,
  backward: string,
): Promise<RegenerationNode[]> {
  await copyTree(
    path.join(candidate, distributionTarget(target).pluginDirectory),
    backward,
  );
  const records = await readPatchSeries(candidate, target);
  const nodes: RegenerationNode[] = [];
  for (const record of records) {
    const bytes = await readFile(patchFile(candidate, target, record.name));
    nodes.push({
      name: record.name,
      bytes,
      paths: patchPaths(backward, bytes),
      after: new Map(),
    });
  }
  const prefix = await mkdtemp(path.join(os.tmpdir(), 'pstack-node-prefix-'));
  try {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]!;
      node.after = await readFileImages(backward, node.paths);
      const additions = patchAdditions(backward, node.bytes);
      if (additions.length === node.paths.length) {
        await writeFileImages(
          backward,
          new Map(
            node.paths.map((file) => [file, { kind: 'absent' } as const]),
          ),
        );
        continue;
      }
      try {
        applyPatchBytes(backward, node.bytes, true);
      } catch (inverseError) {
        if (!(inverseError instanceof GitPatchConflict)) throw inverseError;
        try {
          await rm(prefix, { recursive: true, force: true });
          await copyPristinePlugin(candidate, prefix, target);
          for (const earlier of nodes.slice(0, index))
            applyPatchBytes(prefix, earlier.bytes);
          await writeFileImages(
            backward,
            await readFileImages(prefix, node.paths),
          );
        } catch (prefixError) {
          if (!(prefixError instanceof GitPatchConflict)) throw prefixError;
          throw new Error(
            `Cannot reconstruct candidate intermediate before ${node.name} for ${target} (${node.paths.join(', ')}). Refresh this reviewed candidate patch before regeneration. ${inverseError instanceof Error ? inverseError.message : String(inverseError)}; prefix: ${prefixError instanceof Error ? prefixError.message : String(prefixError)}`,
          );
        }
      }
    }
    return nodes;
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}

async function appendRegenerated(
  project: string,
  target: TargetId,
  name: string,
): Promise<void> {
  const file = path.join(
    project,
    distributionTarget(target).patchDirectory,
    'series',
  );
  const previous = await readFile(file, 'utf8');
  await writeFile(file, `${previous}${name}\n`);
}

async function regenerateSharedCandidate(
  candidate: string,
  output: string,
  targets: TargetId[],
): Promise<{ files: number; digest: string }> {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-shared-regenerate-'),
  );
  const project = path.join(temporary, 'project');
  try {
    await copyTree(
      path.join(candidate, 'upstream'),
      path.join(project, 'upstream'),
    );
    for (const file of [
      'upstream.lock.json',
      'dependencies.lock.json',
      'distribution-policy.json',
      'codex-runtime.lock.json',
    ]) {
      try {
        await copyFile(path.join(candidate, file), path.join(project, file));
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    }
    await mkdir(path.join(project, 'patches/shared'), { recursive: true });
    const plans: RegenerationPlan[] = [];
    for (const target of targets) {
      const directory = path.join(
        project,
        distributionTarget(target).pluginDirectory,
      );
      await copyPristinePlugin(project, directory, target);
      await mkdir(
        path.join(project, distributionTarget(target).patchDirectory),
        { recursive: true },
      );
      await writeFile(
        path.join(project, distributionTarget(target).patchDirectory, 'series'),
        '',
      );
      plans.push({
        target,
        directory,
        position: 0,
        groups: [],
        nodes: await reconstructNodes(
          candidate,
          target,
          path.join(temporary, 'backward', target),
        ),
      });
    }
    const sharedOrder = plans.map((plan) =>
      plan.nodes
        .filter((node) => parsePatchReference(node.name).scope === 'shared')
        .map((node) => node.name),
    );
    if (
      sharedOrder.some(
        (order) => JSON.stringify(order) !== JSON.stringify(sharedOrder[0]),
      )
    )
      throw new Error(
        'Shared patch order differs between candidate host series.',
      );
    while (plans.some((plan) => plan.position < plan.nodes.length)) {
      for (const plan of plans) {
        while (
          plan.position < plan.nodes.length &&
          parsePatchReference(plan.nodes[plan.position]!.name).scope ===
            'target'
        ) {
          const node = plan.nodes[plan.position++]!;
          const bytes = await patchForNode(plan.directory, node);
          if (bytes.length) {
            await writeFile(patchFile(project, plan.target, node.name), bytes, {
              flag: 'wx',
            });
            try {
              applyPatchBytes(plan.directory, bytes);
            } catch (error) {
              throw new Error(
                `Regeneration failed for ${plan.target} ${node.name} (${node.paths.join(', ')}): ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
            await appendRegenerated(project, plan.target, node.name);
          }
          plan.groups.push({
            name: node.name,
            status: bytes.length ? 'generated' : 'no-remaining-changes',
          });
        }
      }
      if (plans.every((plan) => plan.position === plan.nodes.length)) break;
      const first = plans[0]!;
      const node = first.nodes[first.position]!;
      if (plans.some((plan) => plan.nodes[plan.position]?.name !== node.name))
        throw new Error(
          `Candidate shared node order cannot be reconciled at ${node.name}.`,
        );
      const bytes = await patchForNode(first.directory, node);
      for (const plan of plans) {
        const expected = plan.nodes[plan.position++]!;
        if (bytes.length) applyPatchBytes(plan.directory, bytes);
        const actual = await readFileImages(plan.directory, expected.paths);
        for (const file of expected.paths)
          if (!sameFileImage(actual.get(file)!, expected.after.get(file)!))
            throw new Error(
              `Shared candidate patch ${node.name} cannot express ${plan.target} output for ${file}.`,
            );
        if (bytes.length)
          await appendRegenerated(project, plan.target, node.name);
        plan.groups.push({
          name: node.name,
          status: bytes.length ? 'generated' : 'no-remaining-changes',
        });
      }
      if (bytes.length)
        await writeFile(patchFile(project, first.target, node.name), bytes, {
          flag: 'wx',
        });
    }
    for (const plan of plans) {
      const final = path.join(
        candidate,
        distributionTarget(plan.target).pluginDirectory,
      );
      const remainder = await diffPluginTrees(plan.directory, final);
      if (remainder.trim()) {
        const name = '9999-candidate-remainder.patch';
        if (plan.nodes.some((node) => node.name === name))
          throw new Error(
            `Candidate has additional unowned changes after ${name} for ${plan.target}. Record their intended patch before regeneration.`,
          );
        await writeFile(patchFile(project, plan.target, name), remainder, {
          flag: 'wx',
        });
        applyPatchBytes(plan.directory, Buffer.from(remainder));
        await appendRegenerated(project, plan.target, name);
        plan.groups.push({ name, status: 'generated' });
      }
    }
    const candidateReport = JSON.parse(
      await readFile(path.join(candidate, 'candidate-report.json'), 'utf8'),
    );
    const reports = [];
    for (const plan of plans) {
      const expected = await inspectTree(
        path.join(candidate, distributionTarget(plan.target).pluginDirectory),
      );
      if (
        JSON.stringify(await inspectTree(plan.directory)) !==
        JSON.stringify(expected)
      )
        throw new Error(
          `Regenerated ${plan.target} tree differs from candidate bytes or modes.`,
        );
      const verified = await verifyPatches(project, plan.target);
      const original =
        candidateReport.targets?.find(
          (report: { target: string }) => report.target === plan.target,
        ) ?? candidateReport;
      reports.push({
        schemaVersion: 1,
        target: plan.target,
        source: await readLock(candidate),
        codexRuntime: await readCodexRuntimeLock(candidate),
        originalCandidateStatus: original.status,
        originalConflict: original.conflict ?? null,
        originalUnappliedPatches: original.unappliedPatches ?? [],
        originalPatches: await readPatchSeries(candidate, plan.target),
        regeneratedPatches: verified.patches,
        groups: plan.groups,
        pluginTreeSha256: verified.digest,
        verification:
          'Shared node ownership and full byte/mode replay equality only; review upstream semantics and execute affected workflows.',
        files: verified.files,
      });
    }
    await createOutputDirectory(output);
    await copyTree(path.join(project, 'patches'), path.join(output, 'patches'));
    await writeFile(
      path.join(output, 'regeneration-report.json'),
      `${JSON.stringify({ ...reports[0], targets: reports }, null, 2)}\n`,
    );
    return { files: reports[0]!.files, digest: reports[0]!.pluginTreeSha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
