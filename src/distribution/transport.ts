import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pairingSimilarity = 0.4;
const rewriteMinimumLines = 20;
const rewriteKeptRatio = 0.4;

type PairedLine =
  { kind: 'same' } | { kind: 'modified'; line: string } | { kind: 'deleted' };

interface Pairing {
  lines: PairedLine[];
  inserts: string[][];
}

// Text is handled as latin1 lines so every byte survives, including text that is not UTF-8.
const linesOf = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('latin1').split('\n');

function similarity(left: string, right: string): number {
  const words = left.split(/\s+/).filter(Boolean);
  const other = new Set(right.split(/\s+/).filter(Boolean));
  if (!words.length || !other.size) return 0;
  return (
    (2 * words.filter((word) => other.has(word)).length) /
    (words.length + other.size)
  );
}

// Pairs each old line with its counterpart in another version: unchanged, modified, or deleted.
// Lines without an old counterpart are insertions, recorded before the old index they precede.
function pairLines(old: string[], other: string[]): Pairing {
  const common = Array.from(
    { length: old.length + 1 },
    () => new Uint32Array(other.length + 1),
  );
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = other.length - 1; j >= 0; j--)
      common[i]![j] =
        old[i] === other[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: PairedLine[] = old.map(() => ({ kind: 'deleted' }));
  const inserts: string[][] = Array.from({ length: old.length + 1 }, () => []);
  const pairGap = (
    fromOld: number,
    toOld: number,
    fromOther: number,
    toOther: number,
  ) => {
    const count = toOld - fromOld;
    if (count && count === toOther - fromOther) {
      for (let k = 0; k < count; k++)
        lines[fromOld + k] = { kind: 'modified', line: other[fromOther + k]! };
      return;
    }
    let cursor = fromOther;
    for (let i = fromOld; i < toOld; i++) {
      let match = -1;
      for (let j = cursor; j < toOther && match < 0; j++)
        if (similarity(old[i]!, other[j]!) >= pairingSimilarity) match = j;
      if (match < 0) continue;
      inserts[i]!.push(...other.slice(cursor, match));
      lines[i] = { kind: 'modified', line: other[match]! };
      cursor = match + 1;
    }
    inserts[toOld]!.push(...other.slice(cursor, toOther));
  };
  let i = 0;
  let j = 0;
  let gapOld = 0;
  let gapOther = 0;
  while (i < old.length && j < other.length) {
    if (old[i] === other[j]) {
      pairGap(gapOld, i, gapOther, j);
      lines[i] = { kind: 'same' };
      gapOld = ++i;
      gapOther = ++j;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) i++;
    else j++;
  }
  pairGap(gapOld, old.length, gapOther, other.length);
  return { lines, inserts };
}

// Resolves one conflict region. A line only upstream changed takes upstream's version. A line both
// changed keeps the adapted text. A line either side deleted stays deleted.
function resolveConflict(
  old: string[],
  adapted: string[],
  next: string[],
): string[] {
  const ours = pairLines(old, adapted);
  const theirs = pairLines(old, next);
  const resolved: string[] = [];
  const insert = (index: number) => {
    const own = ours.inserts[index]!;
    resolved.push(...own);
    for (const line of theirs.inserts[index]!)
      if (!own.includes(line)) resolved.push(line);
  };
  old.forEach((line, index) => {
    insert(index);
    const our = ours.lines[index]!;
    const their = theirs.lines[index]!;
    if (their.kind === 'deleted' || our.kind === 'deleted') return;
    if (our.kind === 'modified') resolved.push(our.line);
    else resolved.push(their.kind === 'modified' ? their.line : line);
  });
  insert(old.length);
  return resolved;
}

function markerSize(...versions: Uint8Array[]): number {
  let longest = 6;
  for (const version of versions)
    for (const line of linesOf(version)) {
      const run = /^(<+|\|+|=+|>+)/.exec(line)?.[0].length ?? 0;
      if (run > longest) longest = run;
    }
  return longest + 1;
}

// Whether `after` replaced most of `before`, so line-by-line reconciliation no longer has a referent.
export function rewrites(before: Uint8Array, after: Uint8Array): boolean {
  const kept = new Set(linesOf(after));
  const significant = linesOf(before).filter((line) => line.trim());
  return (
    significant.length >= rewriteMinimumLines &&
    significant.filter((line) => kept.has(line)).length / significant.length <
      rewriteKeptRatio
  );
}

const terminated = (bytes: Uint8Array) =>
  !bytes.length || bytes[bytes.length - 1] === 0x0a;

// Moves an adapted file from the old source onto the new source with a three-way merge. Conflict
// markers force a newline after an unterminated last line, so the final newline is reconciled apart
// from the lines: the adapted file's choice stays where it differs from the old source, and
// upstream's applies otherwise.
export async function moveOntoSource(
  adapted: Uint8Array,
  old: Uint8Array,
  next: Uint8Array,
): Promise<{ bytes: Buffer; conflicts: number }> {
  const ends =
    terminated(adapted) === terminated(old)
      ? terminated(next)
      : terminated(adapted);
  const [closedAdapted, closedOld, closedNext] = [adapted, old, next].map(
    (bytes) =>
      terminated(bytes) ? bytes : Buffer.concat([bytes, Buffer.from('\n')]),
  );
  const moved = await moveClosed(closedAdapted!, closedOld!, closedNext!);
  return {
    conflicts: moved.conflicts,
    bytes:
      ends || !moved.bytes.length
        ? moved.bytes
        : moved.bytes.subarray(0, moved.bytes.length - 1),
  };
}

async function moveClosed(
  adapted: Uint8Array,
  old: Uint8Array,
  next: Uint8Array,
): Promise<{ bytes: Buffer; conflicts: number }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pstack-transport-'));
  try {
    await writeFile(path.join(directory, 'adapted'), adapted);
    await writeFile(path.join(directory, 'old'), old);
    await writeFile(path.join(directory, 'new'), next);
    const marker = markerSize(adapted, old, next);
    const merged = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '--diff3',
        `--marker-size=${marker}`,
        'adapted',
        'old',
        'new',
      ],
      { cwd: directory, timeout: 30000, maxBuffer: 256 * 1024 * 1024 },
    );
    if (merged.error) throw merged.error;
    if (merged.status === null || merged.status > 127)
      throw new Error(
        `git merge-file failed: ${merged.stderr.toString('utf8') || merged.signal || merged.status}`,
      );
    if (merged.status === 0) return { bytes: merged.stdout, conflicts: 0 };
    const resolved: string[] = [];
    let conflicts = 0;
    let side: 'adapted' | 'old' | 'new' | undefined;
    let region = {
      adapted: [] as string[],
      old: [] as string[],
      new: [] as string[],
    };
    for (const line of linesOf(merged.stdout)) {
      if (!side && line.startsWith('<'.repeat(marker))) {
        side = 'adapted';
        region = { adapted: [], old: [], new: [] };
      } else if (side === 'adapted' && line.startsWith('|'.repeat(marker)))
        side = 'old';
      else if (side === 'old' && line.startsWith('='.repeat(marker)))
        side = 'new';
      else if (side === 'new' && line.startsWith('>'.repeat(marker))) {
        resolved.push(
          ...resolveConflict(region.old, region.adapted, region.new),
        );
        conflicts++;
        side = undefined;
      } else if (side) region[side].push(line);
      else resolved.push(line);
    }
    if (side) throw new Error('git merge-file left an unterminated conflict.');
    return { bytes: Buffer.from(resolved.join('\n'), 'latin1'), conflicts };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
