import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyPristinePlugin } from '../upstream/dependencies.ts';
import { readLock } from '../upstream/lock.ts';
import { verifySnapshot } from '../upstream/verify.ts';
import {
  applyPatchBytes,
  diffPluginTrees,
  GitPatchConflict,
  isPatchName,
  parsePatchReference,
  patchFile,
  patchPaths,
  readFileImages,
  readPatchSeries,
  sameFileImage,
  writeFileImages,
} from './patches.ts';
import type { FileImage, PatchRecord } from './patches.ts';
import { distributionTarget, projectTargets } from './targets.ts';
import type { TargetId } from './targets.ts';
import { moveOntoSource, rewrites } from './transport.ts';
import {
  createOutputDirectory,
  inspectTree,
  sha256,
  treeDigest,
} from './tree.ts';

type FileImages = Map<string, FileImage>;

interface SeriesNode {
  name: string;
  bytes: Buffer;
  paths: string[];
  before: FileImages;
  after: FileImages;
}

interface RebasedGroup {
  name: string;
  status: 'kept' | 'regenerated' | 'dropped';
  droppedPaths: string[];
  unexplainedAdditions: string[];
}

interface TargetPlan {
  target: TargetId;
  replay: string;
  final: string;
  nodes: SeriesNode[];
  series: string[];
  groups: RebasedGroup[];
  transport: { conflictHunks: number; upstreamRewrites: number };
  sharedPaths: Set<string>;
  refreshPatch: string | null;
  refreshPaths: string[];
}

export interface RebasedTarget {
  target: TargetId;
  kept: number;
  regenerated: number;
  dropped: number;
  refreshPatch: string | null;
  files: number;
  digest: string;
}

export interface RebaseResult {
  version: string;
  sharedRefresh: string | null;
  unexplainedAdditions: number;
  targets: RebasedTarget[];
}

function signedLines(patch: Uint8Array, sign: '+' | '-'): Set<string> {
  return new Set(
    Buffer.from(patch)
      .toString('latin1')
      .split('\n')
      .filter(
        (line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3)),
      )
      .map((line) => line.slice(1)),
  );
}

// Lines a rebased patch adds that its original never added and the new source does not contain.
// A historical patch keeps only its own change, so the only such lines the contract allows are
// those an adaptation-owned body kept from the old source.
export function unexplainedAdditions(
  rebased: Uint8Array,
  original: Uint8Array,
  sourceLines: ReadonlySet<string>,
): string[] {
  const known = signedLines(original, '+');
  return [...signedLines(rebased, '+')].filter(
    (line) => line.trim() && !known.has(line) && !sourceLines.has(line),
  );
}

// Added lines the original never added count fully. Those the same diff also removes are a hunk
// boundary placed differently and count a thousandth.
function foreignWeight(candidate: Uint8Array, original: Uint8Array): number {
  const known = signedLines(original, '+');
  const removed = signedLines(candidate, '-');
  let weight = 0;
  for (const line of signedLines(candidate, '+'))
    if (line.trim() && !known.has(line)) weight += removed.has(line) ? 1 : 1000;
  return weight;
}

// Equivalent diffs can place a hunk boundary differently. Prefer the one whose added lines stay
// closest to the original patch, so an unchanged line is context rather than removed and re-added.
async function closestDiff(
  previous: string,
  next: string,
  original: Uint8Array,
): Promise<Buffer> {
  let best = await diffPluginTrees(previous, next);
  let weight = foreignWeight(best, original);
  for (const algorithm of ['patience', 'histogram', 'minimal'] as const) {
    if (!weight) break;
    const bytes = await diffPluginTrees(previous, next, undefined, algorithm);
    const candidate = foreignWeight(bytes, original);
    if (candidate < weight) [best, weight] = [bytes, candidate];
  }
  return best;
}

async function sameTree(left: string, right: string): Promise<boolean> {
  return (
    JSON.stringify(await inspectTree(left)) ===
    JSON.stringify(await inspectTree(right))
  );
}

function applyNamed(directory: string, bytes: Uint8Array, label: string): void {
  try {
    applyPatchBytes(directory, bytes);
  } catch (error) {
    throw new Error(
      `Cannot apply ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readSeriesNodes(
  project: string,
  target: TargetId,
  directory: string,
): Promise<SeriesNode[]> {
  await copyPristinePlugin(project, directory, target);
  const nodes: SeriesNode[] = [];
  for (const record of await readPatchSeries(project, target)) {
    const bytes = await readFile(patchFile(project, target, record.name));
    const renamed = [
      ...bytes.toString('utf8').matchAll(/^rename from (.+)$/gm),
    ].map((match) => match[1]!);
    const paths = [...new Set([...patchPaths(directory, bytes), ...renamed])];
    const before = await readFileImages(directory, paths);
    applyNamed(directory, bytes, `pinned ${target} ${record.name}`);
    const after = await readFileImages(directory, paths);
    nodes.push({ name: record.name, bytes, paths, before, after });
  }
  const pluginDirectory = distributionTarget(target).pluginDirectory;
  if (!(await sameTree(directory, path.join(project, pluginDirectory))))
    throw new Error(
      `Pinned ${target} series does not reproduce ${pluginDirectory}. Run verify-patches before rebasing.`,
    );
  return nodes;
}

function nextPatchName(
  nodes: SeriesNode[],
  scope: 'shared' | 'target',
  slug: string,
): string {
  const numbers = nodes
    .map((node) => parsePatchReference(node.name))
    .filter((reference) => reference.scope === scope)
    .map((reference) => Number(reference.name.slice(0, 4)));
  const name = `${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}-${slug}.patch`;
  if (!isPatchName(name))
    throw new Error(`Cannot number a refresh patch as ${name}.`);
  return scope === 'shared' ? `shared/${name}` : name;
}

async function selectedDiff(
  work: string,
  previous: FileImages,
  next: FileImages,
  original?: Uint8Array,
): Promise<Buffer> {
  const directory = await mkdtemp(path.join(work, 'diff-'));
  try {
    const before = path.join(directory, 'before');
    const after = path.join(directory, 'after');
    await mkdir(before);
    await mkdir(after);
    await writeFileImages(before, previous);
    await writeFileImages(after, next);
    return original
      ? await closestDiff(before, after, original)
      : await diffPluginTrees(before, after);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function reusesOriginal(
  work: string,
  node: SeriesNode,
  before: FileImages,
  after: FileImages,
): Promise<boolean> {
  const trial = await mkdtemp(path.join(work, 'trial-'));
  try {
    await writeFileImages(trial, before);
    try {
      applyPatchBytes(trial, node.bytes);
    } catch (error) {
      if (!(error instanceof GitPatchConflict)) throw error;
      return false;
    }
    const actual = await readFileImages(trial, node.paths);
    return node.paths.every((file) =>
      sameFileImage(actual.get(file)!, after.get(file)!),
    );
  } finally {
    await rm(trial, { recursive: true, force: true });
  }
}

const outputPatch = (target: TargetId, name: string) =>
  patchFile('', target, name);

// `patches` collects output bytes by relative path. A shared patch enters once, from the first
// target, and every later target must produce the same bytes.
async function rebaseTarget(
  project: string,
  candidate: string,
  target: TargetId,
  work: string,
  patches: Map<string, Buffer>,
  first: boolean,
): Promise<TargetPlan> {
  const nodes = await readSeriesNodes(
    project,
    target,
    path.join(work, target, 'pinned'),
  );
  const replay = path.join(work, target, 'replay');
  await copyPristinePlugin(candidate, replay, target);
  const sourceLines = new Set<string>();
  for (const entry of await inspectTree(replay))
    if (entry.kind === 'file')
      for (const line of (await readFile(path.join(replay, entry.path)))
        .toString('latin1')
        .split('\n'))
        sourceLines.add(line);

  // Every node path starts at the old source, so its first `before` image is the old source file.
  const source = new Map<string, [FileImage, FileImage]>();
  const owned = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const next = await readFileImages(
      replay,
      node.paths.filter((file) => !source.has(file)),
    );
    for (const [file, image] of next)
      source.set(file, [node.before.get(file)!, image]);
    for (const file of node.paths) {
      const before = node.before.get(file)!;
      const after = node.after.get(file)!;
      if (
        !owned.has(file) &&
        before.kind === 'file' &&
        (after.kind === 'absent' || rewrites(before.bytes, after.bytes))
      )
        owned.set(file, index);
    }
  }

  const transport = { conflictHunks: 0, upstreamRewrites: 0 };
  const moved = new Map<string, FileImage>();
  const move = async (file: string, image: FileImage): Promise<FileImage> => {
    const [before, after] = source.get(file)!;
    if (sameFileImage(before, after)) return image;
    if (sameFileImage(image, before)) return after;
    if (image.kind === 'absent' || before.kind === 'absent') return image;
    if (after.kind === 'absent') return after;
    const key = `${file}\0${image.mode}\0${sha256(image.bytes)}`;
    let result = moved.get(key);
    if (result) return result;
    if (rewrites(before.bytes, after.bytes)) {
      transport.upstreamRewrites++;
      result = after;
    } else {
      const merged = await moveOntoSource(
        image.bytes,
        before.bytes,
        after.bytes,
      );
      transport.conflictHunks += merged.conflicts;
      result = {
        kind: 'file',
        bytes: merged.bytes,
        mode: image.mode === before.mode ? after.mode : image.mode,
      };
    }
    moved.set(key, result);
    return result;
  };
  // A file the adaptation deleted or rewrote is adaptation-owned from that node on and keeps its
  // historical bytes. Earlier states move onto the new source.
  const stateAfter = async (index: number, images: FileImages) => {
    const result: FileImages = new Map();
    for (const [file, image] of images)
      result.set(
        file,
        index < (owned.get(file) ?? Infinity) ? await move(file, image) : image,
      );
    return result;
  };

  const plan: TargetPlan = {
    target,
    replay,
    final: path.join(candidate, distributionTarget(target).pluginDirectory),
    nodes,
    series: [],
    groups: [],
    transport,
    sharedPaths: new Set(),
    refreshPatch: null,
    refreshPaths: [],
  };
  for (const [index, node] of nodes.entries()) {
    const shared = parsePatchReference(node.name).scope === 'shared';
    if (shared) for (const file of node.paths) plan.sharedPaths.add(file);
    const before = await stateAfter(index - 1, node.before);
    const after = await stateAfter(index, node.after);
    const actual = await readFileImages(replay, node.paths);
    for (const file of node.paths)
      if (!sameFileImage(actual.get(file)!, before.get(file)!))
        throw new Error(
          `Cannot rebase ${target} ${node.name}: ${file} differs from the state its earlier patches produce on the candidate source.`,
        );
    const changed = node.paths.filter(
      (file) => !sameFileImage(before.get(file)!, after.get(file)!),
    );
    const destination = outputPatch(target, node.name);
    const identical = () =>
      new Error(
        `Shared patch ${node.name} cannot stay identical for every target on the candidate source.`,
      );
    if (!changed.length) {
      if (shared && patches.has(destination)) throw identical();
      plan.groups.push({
        name: node.name,
        status: 'dropped',
        droppedPaths: node.paths,
        unexplainedAdditions: [],
      });
      continue;
    }
    const kept = await reusesOriginal(work, node, before, after);
    let bytes = node.bytes;
    let unexplained: string[] = [];
    if (!kept) {
      bytes = await selectedDiff(
        work,
        new Map(changed.map((file) => [file, before.get(file)!])),
        new Map(changed.map((file) => [file, after.get(file)!])),
        node.bytes,
      );
      const ownedLines = new Set(
        node.paths
          .filter((file) => owned.get(file) === index)
          .flatMap((file) => {
            const image = node.after.get(file)!;
            return image.kind === 'file'
              ? image.bytes.toString('latin1').split('\n')
              : [];
          }),
      );
      unexplained = unexplainedAdditions(bytes, node.bytes, sourceLines).filter(
        (line) => !ownedLines.has(line),
      );
    }
    if (shared && !first && !patches.get(destination)?.equals(bytes))
      throw identical();
    patches.set(destination, bytes);
    applyNamed(replay, bytes, `rebased ${target} ${node.name}`);
    plan.series.push(node.name);
    plan.groups.push({
      name: node.name,
      status: kept ? 'kept' : 'regenerated',
      droppedPaths: node.paths.filter((file) => !changed.includes(file)),
      unexplainedAdditions: unexplained,
    });
  }
  return plan;
}

export async function rebaseCandidatePatches(
  project: string,
  candidate: string,
  output: string,
  refreshName?: string,
): Promise<RebaseResult> {
  if (![project, candidate, output].every((value) => path.isAbsolute(value)))
    throw new Error('Project, candidate, and output must be absolute paths.');
  if (await lstat(output).catch(() => undefined))
    throw new Error(`Output already exists: ${output}`);
  await verifySnapshot(project);
  await verifySnapshot(candidate);
  const lock = await readLock(candidate);
  const slug =
    refreshName ??
    `upstream-${lock.pstack.version.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-refresh`;
  if (!isPatchName(`0001-${slug}.patch`))
    throw new Error('Refresh name must be a lowercase-name without a number.');
  const targets = await projectTargets(project);
  if (
    JSON.stringify(targets) !== JSON.stringify(await projectTargets(candidate))
  )
    throw new Error('Project and candidate must carry the same host targets.');
  const work = await mkdtemp(path.join(os.tmpdir(), 'pstack-rebase-'));
  try {
    const patches = new Map<string, Buffer>();
    const plans: TargetPlan[] = [];
    for (const target of targets)
      plans.push(
        await rebaseTarget(
          project,
          candidate,
          target,
          work,
          patches,
          !plans.length,
        ),
      );
    const sharedOrder = plans.map((plan) =>
      JSON.stringify(
        plan.series.filter(
          (name) => parsePatchReference(name).scope === 'shared',
        ),
      ),
    );
    if (sharedOrder.some((order) => order !== sharedOrder[0]))
      throw new Error('Shared patch order differs between host series.');

    // Everything the update changed lands in new patches: one shared patch for common bodies,
    // then one patch per target.
    const remaining = new Map<TargetPlan, string[]>();
    for (const plan of plans) {
      const bytes = await diffPluginTrees(plan.replay, plan.final);
      remaining.set(plan, bytes.length ? patchPaths(plan.replay, bytes) : []);
    }
    const sharedPaths = [
      ...new Set(
        plans.flatMap((plan) =>
          remaining.get(plan)!.filter((file) => plan.sharedPaths.has(file)),
        ),
      ),
    ].sort();
    let sharedRefresh: string | null = null;
    if (sharedPaths.length) {
      let bytes: Buffer | undefined;
      for (const plan of plans) {
        const next = await selectedDiff(
          work,
          await readFileImages(plan.replay, sharedPaths),
          await readFileImages(plan.final, sharedPaths),
        );
        if (bytes && !bytes.equals(next))
          throw new Error(
            `Candidate targets differ in shared bodies (${sharedPaths.join(', ')}). Make them identical before rebasing.`,
          );
        bytes = next;
      }
      sharedRefresh = nextPatchName(plans[0]!.nodes, 'shared', slug);
      patches.set(outputPatch(plans[0]!.target, sharedRefresh), bytes!);
      for (const plan of plans) {
        applyNamed(plan.replay, bytes!, `${plan.target} ${sharedRefresh}`);
        plan.series.push(sharedRefresh);
      }
    }
    for (const plan of plans) {
      const bytes = await diffPluginTrees(plan.replay, plan.final);
      if (bytes.length) {
        plan.refreshPatch = nextPatchName(plan.nodes, 'target', slug);
        plan.refreshPaths = patchPaths(plan.replay, bytes);
        patches.set(outputPatch(plan.target, plan.refreshPatch), bytes);
        applyNamed(plan.replay, bytes, `${plan.target} ${plan.refreshPatch}`);
        plan.series.push(plan.refreshPatch);
      }
      if (!(await sameTree(plan.replay, plan.final)))
        throw new Error(
          `Rebased ${plan.target} series differs from candidate bytes or modes.`,
        );
    }

    const previous = await readLock(project);
    const reports = [];
    const result: RebaseResult = {
      version: lock.pstack.version,
      sharedRefresh,
      unexplainedAdditions: 0,
      targets: [],
    };
    for (const plan of plans) {
      const entries = await inspectTree(plan.replay);
      const count = (status: RebasedGroup['status']) =>
        plan.groups.filter((group) => group.status === status).length;
      const summary = {
        target: plan.target,
        kept: count('kept'),
        regenerated: count('regenerated'),
        dropped: count('dropped'),
        refreshPatch: plan.refreshPatch,
        files: entries.filter((entry) => entry.kind === 'file').length,
        digest: treeDigest(entries),
      };
      result.targets.push(summary);
      result.unexplainedAdditions += plan.groups.reduce(
        (total, group) => total + group.unexplainedAdditions.length,
        0,
      );
      const rebasedPatches: PatchRecord[] = plan.series.map((name) => ({
        name,
        sha256: sha256(patches.get(outputPatch(plan.target, name))!),
      }));
      reports.push({
        ...summary,
        transport: plan.transport,
        refreshPaths: plan.refreshPaths,
        sharedRefresh,
        sharedRefreshPaths: sharedPaths,
        groups: plan.groups,
        rebasedPatches,
      });
    }
    await createOutputDirectory(output);
    for (const [file, bytes] of patches) {
      await mkdir(path.dirname(path.join(output, file)), { recursive: true });
      await writeFile(path.join(output, file), bytes, { flag: 'wx' });
    }
    for (const plan of plans) {
      const directory = path.join(
        output,
        distributionTarget(plan.target).patchDirectory,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'series'),
        plan.series.map((name) => `${name}\n`).join(''),
      );
    }
    await writeFile(
      path.join(output, 'rebase-report.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          previousSource: previous.pstack,
          source: lock.pstack,
          refreshName: slug,
          targets: reports,
          verification:
            'Full byte and mode replay equality, and that no rebased historical patch adds a line its original did not add. Conflicts are resolved line by line without judging meaning; review every regenerated and refresh patch and run the affected workflows before integration.',
        },
        null,
        2,
      )}\n`,
    );
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
