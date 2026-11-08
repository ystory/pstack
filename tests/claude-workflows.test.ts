import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { inspectTree } from '../src/distribution/tree.ts';
import {
  readDistributionPolicy,
  verifyDistributionPolicy,
} from '../src/distribution/policy.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = path.join(root, 'plugin-claude');
const helper = path.join(plugin, 'skills/recall/scripts/claude-history.mjs');
interface Site {
  path: string;
  classification: string;
  roles: string[];
  workerKind: string | string[];
  binding: string;
}
interface Inventory {
  schemaVersion: number;
  roleShapes: Record<string, 'scalar' | 'list'>;
  sites: Site[];
  sourceAdaptations: { path: string; reason: string }[];
  omittedMetadata: string[];
  preservedExecutionAdaptations: string[];
}
const inventory: Inventory = JSON.parse(
  await readFile(
    path.join(plugin, 'skills/poteto-mode/references/delegation-sites.json'),
    'utf8',
  ),
);
const text = (relative: string) =>
  readFile(path.join(plugin, relative), 'utf8');

function frontmatter(source: string) {
  assert.ok(source.startsWith('---\n'));
  const end = source.indexOf('\n---', 4);
  assert.ok(end > 0);
  return Object.fromEntries(
    source
      .slice(4, end)
      .split('\n')
      .filter((line) => /^[a-z][\w-]*:/.test(line))
      .map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }),
  );
}

test('Claude plugin loads a unique skill catalog, native agents, and retained licenses', async () => {
  const manifest = JSON.parse(await text('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'pstack-cc');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.hooks, undefined);
  const tree = await inspectTree(plugin);
  assert.ok(!tree.some((entry) => entry.path === 'hooks/hooks.json'));
  const skills = tree.filter((entry) =>
    /^skills\/[^/]+\/SKILL\.md$/.test(entry.path),
  );
  const names = new Set<string>();
  for (const skill of skills) {
    const metadata = frontmatter(await text(skill.path));
    assert.equal(metadata.name, skill.path.split('/')[1]);
    assert.ok(metadata.description, skill.path);
    assert.ok(!names.has(metadata.name!), skill.path);
    names.add(metadata.name!);
  }
  assert.ok(names.has('poteto-mode'));
  assert.ok(names.has('setup-pstack'));
  for (const name of [
    'general-purpose',
    'poteto-agent',
    'comment-sicko',
    'read-only',
  ]) {
    const metadata = frontmatter(await text(`agents/${name}.md`));
    assert.equal(metadata.name, name);
    assert.equal(metadata.model, 'inherit');
  }
  for (const license of [
    'LICENSE',
    'licenses/cursor-team-kit/LICENSE',
    'licenses/pstack-cc/LICENSE',
  ]) {
    assert.match(await text(license), /MIT License/);
  }
  assert.ok(!tree.some((entry) => entry.path.startsWith('.cursor-plugin')));
  assert.ok(!tree.some((entry) => entry.path.startsWith('automations/benny')));
});

test('actual readonly callers retain native file-tool restrictions and Why and Reflect retain full access', async () => {
  const readonly = await text('agents/read-only.md');
  assert.equal(frontmatter(readonly).model, 'inherit');
  assert.equal(
    frontmatter(readonly).disallowedTools,
    'Write, Edit, NotebookEdit',
  );
  assert.equal(
    readonly.split('\n---\n')[1],
    (await text('agents/general-purpose.md')).split('\n---\n')[1],
  );
  for (const caller of [
    'skills/how/SKILL.md',
    'skills/arena/SKILL.md',
    'skills/maintain-verification-skill/SKILL.md',
  ]) {
    assert.ok((await text(caller)).includes('`read-only`'), caller);
    const site = inventory.sites.find((entry) => entry.path === caller);
    assert.ok(site);
    assert.ok([site.workerKind].flat().includes('read-only'));
  }
  for (const caller of ['skills/why/SKILL.md', 'skills/reflect/SKILL.md']) {
    assert.ok((await text(caller)).includes('`general-purpose`'), caller);
    assert.ok(!(await text(caller)).includes('kind `read-only`'), caller);
  }
  const binding = await text('skills/poteto-mode/references/execution.md');
  assert.match(binding, /git status/);
  assert.match(binding, /Bash/);
});

test('Claude target applies the repository distribution policy and retains general Slack research', async () => {
  const policy = await readDistributionPolicy(root);
  assert.ok(policy);
  await verifyDistributionPolicy(plugin, policy);
  const research = 'skills/why/references/sources/slack.md';
  assert.equal(
    await text(research),
    await readFile(path.join(root, 'upstream/pstack', research), 'utf8'),
  );
});

test('delegation inventory retains the upstream role shapes and covers every source delegation site', async () => {
  const source = await readFile(
    path.join(root, 'upstream/pstack/skills/setup-pstack/SKILL.md'),
    'utf8',
  );
  const block = source
    .split('# pstack model configuration.')[1]!
    .split('```')[0]!;
  const upstreamRoles = block
    .split('\n')
    .filter((line) => /^[^#\s].+: /.test(line))
    .map((line) => line.split(': ')[0]!);
  assert.equal(upstreamRoles.length, 17);
  assert.deepEqual(
    Object.keys(inventory.roleShapes).sort(),
    upstreamRoles.sort(),
  );
  assert.deepEqual(
    Object.entries(inventory.roleShapes)
      .filter(([, shape]) => shape === 'list')
      .map(([role]) => role)
      .sort(),
    [
      'arena runners',
      'arena cross-judge pool',
      'architect runners',
      'interrogate reviewers',
    ].sort(),
  );
  const sourceTree = await inspectTree(path.join(root, 'upstream/pstack'));
  const sites = new Map(inventory.sites.map((site) => [site.path, site]));
  assert.equal(sites.size, inventory.sites.length);
  for (const entry of sourceTree) {
    if (
      !entry.path.startsWith('skills/') ||
      !entry.path.endsWith('.md') ||
      entry.path.includes('/scripts/')
    )
      continue;
    const body = await readFile(
      path.join(root, 'upstream/pstack', entry.path),
      'utf8',
    );
    if (/\b(spawn\w*|subagents?|delegat\w*|workers?)\b/i.test(body))
      assert.ok(
        sites.has(entry.path),
        `Unreviewed delegation site ${entry.path}`,
      );
  }
  const consumed = new Set<string>();
  for (const site of sites.values()) {
    assert.ok((await lstat(path.join(plugin, site.path))).isFile());
    assert.ok((await lstat(path.join(plugin, site.binding))).isFile());
    for (const kind of [site.workerKind].flat())
      assert.ok(
        [
          'general-purpose',
          'poteto-agent',
          'comment-sicko',
          'read-only',
        ].includes(kind),
      );
    for (const role of site.roles) {
      assert.ok(
        Object.hasOwn(inventory.roleShapes, role),
        `${site.path}: ${role}`,
      );
      consumed.add(role);
    }
  }
  assert.deepEqual(
    [...consumed].sort(),
    Object.keys(inventory.roleShapes).sort(),
  );
});

test('Claude baseline preserves unadapted source bytes, types and modes', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pstack-claude-baseline-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await copyPristinePlugin(root, scratch);
  const target = new Map(
    (await inspectTree(plugin)).map((entry) => [entry.path, entry]),
  );
  const adaptations = new Set(
    inventory.sourceAdaptations.map((entry) => entry.path),
  );
  for (const entry of await inspectTree(scratch)) {
    if (
      entry.path === '.cursor-plugin' ||
      inventory.omittedMetadata.includes(entry.path)
    )
      continue;
    if (entry.path.startsWith('skills/setup-pstack')) continue;
    const actual = target.get(entry.path);
    assert.ok(actual, `Missing upstream file ${entry.path}`);
    if (!adaptations.has(entry.path))
      assert.deepEqual(
        actual,
        entry,
        `Unrecorded source adaptation ${entry.path}`,
      );
  }
  for (const entry of inventory.sourceAdaptations) {
    assert.ok(entry.reason.length > 20, entry.path);
    assert.ok(target.has(entry.path), entry.path);
  }
  for (const relative of inventory.preservedExecutionAdaptations) {
    if (
      relative.endsWith('bootstrap.ts') ||
      relative.endsWith('worktree-audit.sh')
    )
      continue;
    assert.equal(
      await readFile(path.join(plugin, relative), 'utf8'),
      (await readFile(path.join(root, 'plugin', relative), 'utf8')).replaceAll(
        'Codex heartbeat every 1h',
        'Claude heartbeat every 1h',
      ),
    );
  }
});

test('installed local Markdown references resolve within the target', async () => {
  const missing: string[] = [];
  for (const entry of await inspectTree(plugin)) {
    if (
      entry.kind !== 'file' ||
      !entry.path.endsWith('.md') ||
      entry.path.startsWith('vendor/')
    )
      continue;
    const source = await text(entry.path);
    for (const match of source.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const destination = match[1]!;
      if (
        destination === 'url' ||
        /^(?:[a-z]+:|#|<)/i.test(destination) ||
        destination.includes('<')
      )
        continue;
      const pathname = destination.split('#')[0]!.split(' ')[0]!;
      if (!pathname) continue;
      const resolved = path.resolve(plugin, path.dirname(entry.path), pathname);
      assert.ok(
        resolved.startsWith(`${plugin}${path.sep}`),
        `${entry.path}: ${destination}`,
      );
      try {
        await lstat(resolved);
      } catch {
        missing.push(`${entry.path}: ${destination}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

const slug = (directory: string) => directory.replace(/[^a-zA-Z0-9]/g, '-');
const session = (id: string, cwd: string, message: string) =>
  `${JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: message } })}\n`;
const history = (args: string[]) =>
  spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });

test('Claude history reads exact project sessions and children without exposing other projects or symlinks', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), 'pstack-claude-history-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'project with spaces');
  const other = path.join(scratch, 'other');
  const home = path.join(scratch, 'claude');
  await Promise.all([mkdir(project), mkdir(other)]);
  const directory = path.join(home, 'projects', slug(project));
  const otherDirectory = path.join(home, 'projects', slug(other));
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(otherDirectory, { recursive: true }),
  ]);
  await writeFile(
    path.join(directory, 'older.jsonl'),
    session('older', project, 'own earlier work'),
  );
  await writeFile(
    path.join(directory, 'newer.jsonl'),
    `${session('newer', project, 'own active prompt')}{\"incomplete\":`,
  );
  await writeFile(
    path.join(otherDirectory, 'secret.jsonl'),
    session('secret', other, 'unrelated secret'),
  );
  await writeFile(
    path.join(directory, 'foreign.jsonl'),
    session('foreign', other, `secret mentions ${project}`),
  );
  await symlink(
    path.join(otherDirectory, 'secret.jsonl'),
    path.join(directory, 'linked.jsonl'),
  );
  const children = path.join(directory, 'newer', 'subagents');
  await mkdir(children, { recursive: true });
  await writeFile(
    path.join(children, 'agent-worker.jsonl'),
    session('newer', project, 'Read full poteto-mode/SKILL.md'),
  );
  await writeFile(
    path.join(children, 'agent-other.jsonl'),
    session('newer', other, 'unrelated child secret'),
  );
  await utimes(
    path.join(directory, 'older.jsonl'),
    new Date('2026-11-03'),
    new Date('2026-11-03'),
  );
  await utimes(
    path.join(directory, 'newer.jsonl'),
    new Date('2026-11-05'),
    new Date('2026-11-05'),
  );
  const args = ['--project', project, '--claude-home', home];
  const listed = history(['list', ...args]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    listed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id),
    ['newer', 'older'],
  );
  assert.ok(!listed.stdout.includes('secret'));
  const read = history(['read', ...args, '--id', 'newer']);
  assert.equal(read.status, 0, read.stderr);
  const result = JSON.parse(read.stdout);
  assert.equal(result.records[0].message.content, 'own active prompt');
  assert.equal(result.records[1].type, 'unparsed-line');
  assert.equal(result.records[1].raw, '{\"incomplete\":');
  assert.equal(result.subagents.length, 1);
  assert.equal(
    result.subagents[0].records[0].message.content,
    'Read full poteto-mode/SKILL.md',
  );
  assert.ok(!read.stdout.includes('unrelated'));
  assert.notEqual(history(['read', ...args, '--id', 'secret']).status, 0);
  assert.notEqual(history(['read', ...args, '--id', '../secret']).status, 0);
  assert.notEqual(history(['list', ...args, '--touching', other]).status, 0);
  await rm(path.join(directory, 'newer'), { recursive: true });
  await symlink(otherDirectory, path.join(directory, 'newer'));
  assert.notEqual(history(['read', ...args, '--id', 'newer']).status, 0);
});

test('Claude history groups registered Git worktrees and supports a worktree-specific audit', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), 'pstack-claude-worktrees-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'project');
  const worktree = path.join(scratch, 'worker');
  const home = path.join(scratch, 'claude');
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '--quiet');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  const nestedProject = path.join(project, 'packages', 'api');
  const nestedWorktree = path.join(worktree, 'packages', 'api');
  await Promise.all([
    mkdir(nestedProject, { recursive: true }),
    mkdir(nestedWorktree, { recursive: true }),
  ]);
  for (const [id, cwd] of [
    ['root-session', project],
    ['worker-session', worktree],
    ['nested-project-session', nestedProject],
    ['nested-worker-session', nestedWorktree],
  ] as const) {
    const directory = path.join(home, 'projects', slug(cwd));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${id}.jsonl`),
      session(id, cwd, `worked in ${cwd}`),
    );
  }
  const args = ['--project', worktree, '--claude-home', home];
  const listed = history(['list', ...args]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim().split('\n').length, 2);
  const narrowed = history(['list', ...args, '--touching', worktree]);
  assert.equal(narrowed.status, 0, narrowed.stderr);
  assert.equal(JSON.parse(narrowed.stdout).id, 'worker-session');
  for (const [id, directory] of [
    ['nested-project-session', nestedProject],
    ['nested-worker-session', nestedWorktree],
  ] as const) {
    await t.test(`recalls an explicitly requested ${id}`, () => {
      const nestedArgs = ['--project', directory, '--claude-home', home];
      const listed = history(['list', ...nestedArgs]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.deepEqual(
        listed.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).id)
          .sort(),
        [id, 'root-session', 'worker-session'].sort(),
      );
      const read = history(['read', ...nestedArgs, '--id', id]);
      assert.equal(read.status, 0, read.stderr);
      assert.equal(
        JSON.parse(read.stdout).records[0].message.content,
        `worked in ${directory}`,
      );
      const narrowed = history([
        'list',
        ...nestedArgs,
        '--touching',
        directory,
      ]);
      assert.equal(narrowed.status, 0, narrowed.stderr);
      assert.equal(JSON.parse(narrowed.stdout).id, id);
    });
  }
});
