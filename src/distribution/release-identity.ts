import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { distributionTarget } from './targets.ts';
import type { TargetId } from './targets.ts';

export interface TargetReleaseSnapshot {
  target: TargetId;
  version: string;
  treeSha: string;
}

export interface ReleaseIdentityReceipt {
  baseCommit: string;
  headCommit: string;
  targets: {
    target: TargetId;
    before: TargetReleaseSnapshot;
    after: TargetReleaseSnapshot;
    changed: boolean;
  }[];
}

interface SemVer {
  version: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
}

const requiredTargets: Record<TargetId, true> = {
  codex: true,
  'claude-code': true,
};
const execute = promisify(execFile);
const numeric = '(0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-(${prerelease}(?:\\.${prerelease})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parseSemVer(value: unknown, target: TargetId): SemVer {
  const match = typeof value === 'string' ? semver.exec(value) : null;
  if (typeof value !== 'string' || !match || match[0] !== value)
    throw new Error(
      `${target} manifest has invalid SemVer ${JSON.stringify(value)}.`,
    );
  return {
    version: value,
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function order<T extends bigint | string>(left: T, right: T): number {
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareVersions(left: SemVer, right: SemVer): number {
  const core =
    order(left.major, right.major) ||
    order(left.minor, right.minor) ||
    order(left.patch, right.patch);
  if (core) return core;
  if (!left.prerelease.length) return right.prerelease.length ? 1 : 0;
  if (!right.prerelease.length) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a);
    const bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return order(BigInt(a), BigInt(b));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return order(a, b);
  }
  return 0;
}

async function git(project: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', project, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function resolveCommit(
  project: string,
  ref: string,
  side: 'base' | 'head',
): Promise<string> {
  try {
    const commit = (
      await git(project, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref}^{commit}`,
      ])
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
      throw new Error('Invalid resolved commit SHA.');
    return commit;
  } catch (cause) {
    throw new Error(
      `Could not resolve ${side} commit ${JSON.stringify(ref)}. Fetch the baseline and head before checking release identity.`,
      { cause },
    );
  }
}

async function gitEntry(project: string, commit: string, file: string) {
  const output = await git(project, ['ls-tree', '-z', commit, '--', file]);
  return /^(\d{6}) (blob|tree) ([0-9a-f]+)\t([^\0]+)\0$/.exec(output);
}

async function snapshot(
  project: string,
  commit: string,
  target: TargetId,
): Promise<{ identity: TargetReleaseSnapshot; precedence: SemVer }> {
  const definition = distributionTarget(target);
  const tree = await gitEntry(project, commit, definition.pluginDirectory);
  if (!tree || tree[2] !== 'tree')
    throw new Error(
      `${target} is missing required target tree ${definition.pluginDirectory} at ${commit}. Target additions and removals require an explicit release policy change.`,
    );
  const manifestPath = `${definition.pluginDirectory}/${definition.manifest}`;
  const entry = await gitEntry(project, commit, manifestPath);
  if (
    !entry ||
    entry[2] !== 'blob' ||
    !['100644', '100755'].includes(entry[1]!)
  )
    throw new Error(
      `${target} is missing a regular manifest ${manifestPath} at ${commit}.`,
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await git(project, ['cat-file', 'blob', entry[3]!]));
  } catch (cause) {
    throw new Error(
      `${target} manifest ${manifestPath} at ${commit} is invalid JSON.`,
      { cause },
    );
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('name' in manifest) ||
    manifest.name !== definition.name
  )
    throw new Error(
      `${target} manifest identity at ${commit} must be ${definition.name}.`,
    );
  const precedence = parseSemVer(
    'version' in manifest ? manifest.version : undefined,
    target,
  );
  return {
    identity: { target, version: precedence.version, treeSha: tree[3]! },
    precedence,
  };
}

export async function checkReleaseIdentity(options: {
  project: string;
  base: string;
  head?: string;
}): Promise<ReleaseIdentityReceipt> {
  const project = (
    await git(options.project, ['rev-parse', '--show-toplevel'])
  ).trim();
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(project, options.base, 'base'),
    resolveCommit(project, options.head ?? 'HEAD', 'head'),
  ]);
  const targets: ReleaseIdentityReceipt['targets'] = [];
  for (const target of Object.keys(requiredTargets) as TargetId[]) {
    const [baseline, head] = await Promise.all([
      snapshot(project, baseCommit, target),
      snapshot(project, headCommit, target),
    ]);
    const before = baseline.identity;
    const after = head.identity;
    const changed = before.treeSha !== after.treeSha;
    if (changed && compareVersions(head.precedence, baseline.precedence) <= 0)
      throw new Error(
        `${target} changed payload requires a strictly increasing SemVer. Base ${before.version}, head ${after.version}.`,
      );
    targets.push({ target, before, after, changed });
  }
  return { baseCommit, headCommit, targets };
}
