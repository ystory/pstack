import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkUpstream, compareRevision } from '../src/upstream/check.ts';
import { readLock, validateLock } from '../src/upstream/lock.ts';
import { computeSnapshotDigest } from '../src/upstream/snapshot.ts';
import { verifySnapshot } from '../src/upstream/verify.ts';

import type { FetchResponse, FetchUpstream } from '../src/upstream/check.ts';
import type { UpstreamLock } from '../src/upstream/lock.ts';

const pstackRevision = '1'.repeat(40);
const codexRevision = '2'.repeat(40);
const newRevision = '3'.repeat(40);

function makeLock(digest = '0'.repeat(64)): UpstreamLock {
  return {
    schemaVersion: 1,
    pstack: {
      repository: 'https://github.com/cursor/plugins',
      ref: 'main',
      path: 'pstack',
      revision: '4'.repeat(40),
      pathRevision: pstackRevision,
      version: '0.15.24',
      snapshotSha256: digest,
    },
    codex: {
      repository: 'https://github.com/openai/codex',
      ref: 'main',
      sourceRevision: codexRevision,
      testedVersions: [],
    },
  };
}

function rawLock(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(makeLock())) as Record<string, unknown>;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-for-codex-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotRoot = path.join(root, 'upstream', 'pstack');
  await mkdir(path.join(snapshotRoot, '.cursor-plugin'), { recursive: true });
  await writeFile(
    path.join(snapshotRoot, '.cursor-plugin', 'plugin.json'),
    JSON.stringify({ name: 'pstack', version: '0.15.24' }),
  );
  await writeFile(
    path.join(snapshotRoot, 'SKILL.md'),
    'Upstream instructions\n',
  );
  const lock = makeLock(await computeSnapshotDigest(snapshotRoot));
  await writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify(lock));
  return { root, snapshotRoot, lock };
}

test('snapshot digest uses sorted POSIX paths, NUL, file hashes, and newline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-digest-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'z.txt'), 'last');
  await writeFile(path.join(root, 'nested', 'a.txt'), 'first');
  const fileHash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const expected = createHash('sha256')
    .update(`nested/a.txt\0${fileHash('first')}\nz.txt\0${fileHash('last')}\n`)
    .digest('hex');
  assert.equal(await computeSnapshotDigest(root), expected);
});

test('unchanged snapshot verifies', async (t) => {
  const { root, lock } = await fixture(t);
  assert.deepEqual(await verifySnapshot(root), {
    version: '0.15.24',
    digest: lock.pstack.snapshotSha256,
  });
});

for (const mutation of ['changed', 'added', 'removed']) {
  test(`verification fails when an upstream file is ${mutation}`, async (t) => {
    const { root, snapshotRoot } = await fixture(t);
    const skillPath = path.join(snapshotRoot, 'SKILL.md');
    if (mutation === 'changed') await writeFile(skillPath, 'Changed bytes\n');
    if (mutation === 'added')
      await writeFile(path.join(snapshotRoot, 'NEW.md'), 'Added bytes\n');
    if (mutation === 'removed') await rm(skillPath);
    await assert.rejects(
      verifySnapshot(root),
      /snapshot integrity mismatch.*added, removed, or changed/,
    );
  });
}

test('matching bytes still fail when the pinned manifest version is inconsistent', async (t) => {
  const { root, lock } = await fixture(t);
  lock.pstack.version = '0.15.25';
  await writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify(lock));
  await assert.rejects(
    verifySnapshot(root),
    /manifest mismatch.*0\.15\.25.*0\.15\.24/,
  );
});

test('snapshot rejects nested symlinks and a symlink root', async (t) => {
  const { root, snapshotRoot } = await fixture(t);
  await symlink('SKILL.md', path.join(snapshotRoot, 'linked.md'));
  await assert.rejects(
    computeSnapshotDigest(snapshotRoot),
    /symlinks are not allowed: linked.md/,
  );
  await symlink(snapshotRoot, path.join(root, 'linked-snapshot'));
  await assert.rejects(
    computeSnapshotDigest(path.join(root, 'linked-snapshot')),
    /not a symlink/,
  );
});

test('every essential lock field is required', () => {
  const fields = [
    ['schemaVersion'],
    ...[
      'repository',
      'ref',
      'path',
      'revision',
      'pathRevision',
      'version',
      'snapshotSha256',
    ].map((field) => ['pstack', field]),
    ...['repository', 'ref', 'sourceRevision', 'testedVersions'].map(
      (field) => ['codex', field],
    ),
  ];
  for (const fieldsPath of fields) {
    const lock = rawLock();
    const first = fieldsPath[0];
    const last = fieldsPath.at(-1);
    assert.ok(first && last);
    const parent =
      fieldsPath.length === 1 ? lock : (lock[first] as Record<string, unknown>);
    delete parent[last];
    assert.throws(
      () => validateLock(lock),
      /Invalid upstream\.lock\.json field/,
      fieldsPath.join('.'),
    );
  }
});

test('malformed lock shapes, revisions, digests, and tested versions fail', () => {
  for (const value of [null, [], {}, { schemaVersion: 2 }]) {
    assert.throws(
      () => validateLock(value),
      /Invalid upstream\.lock\.json field/,
    );
  }
  for (const field of ['revision', 'pathRevision', 'snapshotSha256']) {
    const lock = rawLock();
    (lock.pstack as Record<string, unknown>)[field] = 'short';
    assert.throws(
      () => validateLock(lock),
      /Invalid upstream\.lock\.json field/,
    );
  }
  const lockWithArrayRevision = rawLock();
  (lockWithArrayRevision.pstack as Record<string, unknown>).revision = [
    pstackRevision,
  ];
  assert.throws(() => validateLock(lockWithArrayRevision), /pstack\.revision/);
  for (const testedVersions of [null, 'not-an-array', [null], ['']]) {
    const lock = rawLock();
    (lock.codex as Record<string, unknown>).testedVersions = testedVersions;
    assert.throws(() => validateLock(lock), /codex\.testedVersions/);
  }
});

test('missing and malformed lock files fail with clear diagnostics', async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'upstream.lock.json'), '{broken');
  await assert.rejects(readLock(root), /Cannot read upstream\.lock\.json/);
  await rm(path.join(root, 'upstream.lock.json'));
  await assert.rejects(readLock(root), /Cannot read upstream\.lock\.json/);
});

test('revision comparison distinguishes changes and rejects missing remote evidence', () => {
  assert.equal(
    compareRevision('pstack', pstackRevision, pstackRevision).changed,
    false,
  );
  assert.equal(
    compareRevision('pstack', pstackRevision, newRevision).changed,
    true,
  );
  assert.throws(
    () => compareRevision('pstack', pstackRevision, undefined),
    /expected a full commit SHA/,
  );
});

function response(payload: unknown, status = 200): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('upstream check uses pstack path revision and reports unchanged and changed sources', async () => {
  const calls: { url: string; options: Parameters<FetchUpstream>[1] }[] = [];
  const results = await checkUpstream(makeLock(), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.includes('cursor/plugins')
        ? response([{ sha: pstackRevision }])
        : response({ sha: newRevision });
    },
  });
  assert.deepEqual(results, [
    {
      status: 'checked',
      name: 'pstack',
      pinned: pstackRevision,
      remote: pstackRevision,
      changed: false,
    },
    {
      status: 'checked',
      name: 'codex',
      pinned: codexRevision,
      remote: newRevision,
      changed: true,
    },
  ]);
  assert.equal(
    calls[0]?.url,
    'https://api.github.com/repos/cursor/plugins/commits?sha=main&path=pstack&per_page=1',
  );
  assert.equal(
    calls[1]?.url,
    'https://api.github.com/repos/openai/codex/commits/main',
  );
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
  assert.ok(
    calls.every((call) => call.options.headers['User-Agent'] === 'pstack'),
  );
});

test('HTTP and payload errors are failures, not no-update results', async () => {
  const results = await checkUpstream(makeLock(), {
    fetchImpl: async (url) =>
      url.includes('cursor/plugins') ? response({}, 403) : response({}),
  });
  assert.ok(results[0]?.status === 'failed');
  assert.ok(results[1]?.status === 'failed');
  assert.match(results[0].error, /HTTP 403/);
  assert.match(results[1].error, /expected a full commit SHA/);
  assert.ok(results.every((result) => !Object.hasOwn(result, 'changed')));
});

test('network failures remain isolated per source', async () => {
  const results = await checkUpstream(makeLock(), {
    fetchImpl: async (url) => {
      if (url.includes('cursor/plugins'))
        throw new Error('Network unavailable');
      return response({ sha: codexRevision });
    },
  });
  assert.ok(results[0]?.status === 'failed');
  assert.ok(results[1]?.status === 'checked');
  assert.match(results[0].error, /Network unavailable/);
  assert.equal(results[1].changed, false);
});

test('upstream requests have a deadline and timeout fails the check', async () => {
  const timer = setTimeout(() => {}, 1000);
  try {
    const results = await checkUpstream(makeLock(), {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    assert.ok(
      results.every(
        (result) => result.status === 'failed' && /timeout/i.test(result.error),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
});

test('upstream check leaves the lock and snapshot unchanged', async (t) => {
  const { root, snapshotRoot, lock } = await fixture(t);
  const beforeLock = await readFile(
    path.join(root, 'upstream.lock.json'),
    'utf8',
  );
  const beforeDigest = await computeSnapshotDigest(snapshotRoot);
  await checkUpstream(lock, {
    fetchImpl: async (url) =>
      url.includes('cursor/plugins')
        ? response([{ sha: newRevision }])
        : response({ sha: newRevision }),
  });
  assert.equal(
    await readFile(path.join(root, 'upstream.lock.json'), 'utf8'),
    beforeLock,
  );
  assert.equal(await computeSnapshotDigest(snapshotRoot), beforeDigest);
});

test('maintainer CLI supports help and rejects unsupported commands', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^pstack maintainer CLI\n/);
  assert.match(help.stdout, /verify-upstream/);
  assert.match(help.stdout, /check-upstream/);
  const invalid = spawnSync(process.execPath, [cli, 'install'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown command: install/);
  const extra = spawnSync(process.execPath, [cli, 'verify-upstream', 'extra'], {
    encoding: 'utf8',
  });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Expected one command/);
});
