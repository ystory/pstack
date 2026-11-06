import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

interface Entry {
  executor?: 'codex' | 'claude-code';
  model: string;
  reasoningEffort?: string;
}
interface Config {
  schemaVersion: number;
  budget: string;
  roles: Record<string, Entry[]>;
}
interface Result {
  file: string;
  exists: boolean;
  sha256: string | null;
  config: Config;
  proposal: Config;
  changed: boolean;
  needsChoice: unknown[];
  entries: Entry[];
  source: string;
  models: {
    executor?: string;
    model: string;
    supportedReasoningEfforts: string[];
    source?: { kind: string; description: string };
  }[];
  targetReasoningEffort: string;
  runtimes?: { modelExecutionVerified: boolean }[];
}

const claudeRuntime = {
  executor: 'claude-code',
  executable: '/existing/claude',
  version: '2.1.287',
  minimumVersion: '2.1.280',
  requiredOptions: {
    print: true,
    model: true,
    effort: true,
    outputFormat: true,
    verbose: true,
    resume: true,
  },
  effortSyntax: ['low', 'medium', 'high', 'xhigh', 'max'],
  modelExecutionVerified: false,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = path.join(root, 'unrelated consumer');
  await mkdir(consumer);
  const bundledSkills = path.join(root, 'standalone plugin with spaces/skills');
  for (const skill of ['setup-pstack', 'poteto-mode'])
    await cp(
      path.join(projectRoot, 'plugin/skills', skill, 'scripts'),
      path.join(bundledSkills, skill, 'scripts'),
      { recursive: true },
    );
  const references = path.join(bundledSkills, 'poteto-mode/references');
  await mkdir(references, { recursive: true });
  await cp(
    path.join(
      projectRoot,
      'plugin/skills/poteto-mode/references/worker-context.md',
    ),
    path.join(references, 'worker-context.md'),
  );
  const bundledScript = path.join(
    bundledSkills,
    'setup-pstack/scripts/models.mjs',
  );
  const codexHome = path.join(root, 'isolated-codex');
  const file = path.join(codexHome, 'pstack-codex/models.json');
  const catalog = path.join(root, 'catalog.json');
  await writeFile(
    catalog,
    JSON.stringify({
      data: [
        {
          id: 'display-id',
          model: 'gpt-6.1-sol',
          supportedReasoningEfforts: [
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          ].map((reasoningEffort) => ({ reasoningEffort })),
        },
        {
          model: 'gpt-6-sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
          ],
        },
      ],
      nextCursor: null,
      runtimes: [claudeRuntime],
    }),
  );
  const input = path.join(root, 'proposal.json');
  const invoke = (command: string, ...flags: string[]) =>
    spawnSync(
      process.execPath,
      [bundledScript, command, '--codex-home', codexHome, ...flags],
      { cwd: consumer, encoding: 'utf8', timeout: 10_000 },
    );
  const run = (command: string, ...flags: string[]): Result => {
    const result = invoke(command, ...flags);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout) as Result;
  };
  const save = async (
    proposal: object,
    expected = run('read').sha256 ?? 'absent',
    ...flags: string[]
  ) => {
    await writeFile(input, JSON.stringify(proposal));
    return run(
      'write',
      '--input',
      input,
      '--catalog',
      catalog,
      '--expected-hash',
      expected,
      ...flags,
    );
  };
  return {
    root,
    bundledSkills,
    codexHome,
    file,
    input,
    catalog,
    invoke,
    run,
    save,
  };
}

test('fresh config stays empty while proposal and parent resolution preserve every role count', async (t) => {
  const f = await fixture(t);
  const result = f.run('read');
  assert.deepEqual(result.config.roles, {});
  const upstream = await readFile(
    path.join(projectRoot, 'upstream/pstack/skills/setup-pstack/SKILL.md'),
    'utf8',
  );
  const original = upstream
    .split('\n')
    .filter((line) => /^[^#\s][^:]*: (?:grok|claude)-/.test(line));
  assert.equal(original.length, 17);
  assert.deepEqual(
    Object.keys(result.proposal.roles),
    original.map((line) => line.slice(0, line.indexOf(': '))),
  );
  for (const line of original) {
    const [role, models] = line.split(': ');
    assert.ok(role && models);
    const count = models.split(', ').length;
    const slots = result.proposal.roles[role]!;
    assert.equal(slots.length, count);
    assert.ok(slots.every((entry) => entry.model === undefined));
    const resolved = f.run('resolve', '--role', role);
    assert.equal(resolved.source, 'unconfigured');
    assert.deepEqual(
      resolved.entries,
      Array.from({ length: count }, () => ({ model: 'inherit-parent' })),
    );
  }
  assert.equal(result.needsChoice.length, 21);
  assert.equal(result.config.budget, 'large');
  assert.equal(result.sha256, null);
  await assert.rejects(stat(f.codexHome), { code: 'ENOENT' });
});

test('native catalog normalization uses executable model IDs and exact supported effort values', async (t) => {
  const f = await fixture(t);
  const result = f.run('catalog', '--input', f.catalog);
  assert.equal(result.models[0]?.model, 'gpt-6.1-sol');
  assert.deepEqual(result.models[1]?.supportedReasoningEfforts, [
    'medium',
    'high',
  ]);
  assert.ok(!result.models.some(({ model }) => model === 'display-id'));
  await writeFile(
    f.catalog,
    JSON.stringify({
      data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }],
      nextCursor: 'more',
    }),
  );
  const incomplete = f.invoke('catalog', '--input', f.catalog);
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /another page/i);
});

test('all original budgets map to separate native efforts without changing model IDs', async (t) => {
  const f = await fixture(t);
  await f.save({
    roles: { 'bug-fix': [{ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }] },
  });
  for (const [budget, effort] of Object.entries({
    unlimited: 'max',
    large: 'xhigh',
    medium: 'high',
    small: 'medium',
  })) {
    const result = f.run('budget', '--budget', budget, '--catalog', f.catalog);
    assert.equal(result.targetReasoningEffort, effort);
    assert.equal(result.config.budget, budget);
    assert.deepEqual(result.needsChoice, []);
    assert.ok(
      Object.values(result.config.roles)
        .flat()
        .every(
          (entry) =>
            ['gpt-6.1-sol', 'claude-opus-5-5'].includes(entry.model) &&
            entry.reasoningEffort === effort,
        ),
    );
  }
  assert.deepEqual(f.run('read').config.roles['bug-fix'], [
    { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
  ]);
});

test('reconfiguration retains chosen model, ordered panel lists, duplicates, aliases and supported fallback effort', async (t) => {
  const f = await fixture(t);
  await f.save({
    roles: {
      'bug-fix': [{ model: 'gpt-6-sol', reasoningEffort: 'high' }],
      'arena runners': [
        { model: 'auto' },
        { model: 'inherit-parent' },
        { model: 'auto' },
      ],
    },
  });
  const result = f.run(
    'budget',
    '--budget',
    'unlimited',
    '--catalog',
    f.catalog,
  );
  assert.deepEqual(result.config.roles['bug-fix'], [
    { model: 'gpt-6-sol', reasoningEffort: 'high' },
  ]);
  assert.deepEqual(result.config.roles['arena runners'], [
    { model: 'auto' },
    { model: 'inherit-parent' },
    { model: 'auto' },
  ]);
  await f.save(result);
  assert.deepEqual(
    f.run('resolve', '--role', 'arena runners').entries,
    result.config.roles['arena runners'],
  );
  assert.equal(f.run('resolve', '--role', 'bug-fix').source, 'saved');
});

test('partial preference saves preserve existing user choices and unrelated Codex files', async (t) => {
  const f = await fixture(t);
  await f.save({ roles: { 'bug-fix': [{ model: 'auto' }] } });
  const unrelated = path.join(f.codexHome, 'config.toml');
  await writeFile(unrelated, 'model = "user-choice"\n');
  await f.save({ roles: { hillclimb: [{ model: 'inherit-parent' }] } });
  assert.deepEqual(f.run('resolve', '--role', 'bug-fix').entries, [
    { model: 'auto' },
  ]);
  assert.deepEqual(f.run('resolve', '--role', 'hillclimb').entries, [
    { model: 'inherit-parent' },
  ]);
  assert.equal(await readFile(unrelated, 'utf8'), 'model = "user-choice"\n');
});

test('unknown role keys fail without dropping them or changing saved choices', async (t) => {
  const f = await fixture(t);
  const saved = await f.save({ roles: { 'bug-fix': [{ model: 'auto' }] } });
  const before = await readFile(f.file);
  await writeFile(
    f.input,
    JSON.stringify({ roles: { 'unknown role': [{ model: 'auto' }] } }),
  );
  const rejected = f.invoke(
    'write',
    '--input',
    f.input,
    '--catalog',
    f.catalog,
    '--expected-hash',
    saved.sha256!,
  );
  assert.equal(rejected.status, 1);
  assert.deepEqual(await readFile(f.file), before);
});

test('identical preference saves leave bytes and timestamp untouched', async (t) => {
  const f = await fixture(t);
  const first = await f.save(f.run('read').config);
  const before = await readFile(f.file);
  const fixed = new Date('2020-01-01T00:00:00Z');
  await utimes(f.file, fixed, fixed);
  const repeated = await f.save(first.config);
  assert.equal(repeated.changed, false);
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await stat(f.file)).mtimeMs, fixed.getTime());
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});

test('dry-run validates preferences without creating a destination', async (t) => {
  const f = await fixture(t);
  const result = await f.save(f.run('read').config, 'absent', '--dry-run');
  assert.equal(result.changed, true);
  await assert.rejects(stat(f.codexHome), { code: 'ENOENT' });
});

test('inherit aliases remain valid even when no real model is detected', async (t) => {
  const f = await fixture(t);
  const config: Config = {
    ...f.run('read').config,
    roles: {
      'bug-fix': [{ model: 'auto' }],
      'arena runners': [{ model: 'auto' }, { model: 'auto' }],
    },
  };
  for (const entries of Object.values(config.roles)) {
    for (const entry of entries) {
      entry.model = 'auto';
      delete entry.reasoningEffort;
      delete entry.executor;
    }
  }
  await writeFile(f.catalog, JSON.stringify({ models: [] }));
  await f.save(config);
  const proposal = f.run('budget', '--budget', 'small', '--catalog', f.catalog);
  assert.deepEqual(proposal.needsChoice, []);
  assert.ok(
    Object.values(proposal.config.roles)
      .flat()
      .every(
        (entry) =>
          entry.model === 'auto' && entry.reasoningEffort === undefined,
      ),
  );
});

test('unknown IDs, model suffix IDs, unsupported efforts and invalid aliases cannot write', async (t) => {
  const f = await fixture(t);
  await f.save(f.run('read').config);
  const before = await readFile(f.file);
  for (const entry of [
    { model: 'unconfirmed', reasoningEffort: 'high' },
    { model: 'gpt-6.1-sol-xhigh', reasoningEffort: 'xhigh' },
    { model: 'gpt-6-sol', reasoningEffort: 'max' },
    { model: 'auto', reasoningEffort: 'high' },
  ]) {
    await writeFile(f.input, JSON.stringify({ roles: { 'bug-fix': [entry] } }));
    const result = f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      f.run('read').sha256!,
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(f.file), before);
  }
});

test('scalar roles reject multiple entries instead of silently selecting one', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.input,
    JSON.stringify({
      roles: { 'bug-fix': [{ model: 'auto' }, { model: 'inherit-parent' }] },
    }),
  );
  const result = f.invoke(
    'write',
    '--input',
    f.input,
    '--catalog',
    f.catalog,
    '--expected-hash',
    'absent',
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one/i);
  await assert.rejects(stat(f.codexHome), { code: 'ENOENT' });
});

test('unresolved budget entries cannot be saved as if valid', async (t) => {
  const f = await fixture(t);
  await f.save({
    roles: { 'bug-fix': [{ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }] },
  });
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['ultra'] }],
    }),
  );
  const result = f.run('budget', '--budget', 'large', '--catalog', f.catalog);
  assert.equal(result.needsChoice.length, 1);
  await writeFile(f.input, JSON.stringify(result));
  const save = f.invoke(
    'write',
    '--input',
    f.input,
    '--catalog',
    f.catalog,
    '--expected-hash',
    result.sha256!,
  );
  assert.notEqual(save.status, 0);
  assert.match(save.stderr, /needsChoice/i);
});

test('stale confirmation hashes prevent overwriting user reconfiguration', async (t) => {
  const f = await fixture(t);
  const first = await f.save(f.run('read').config);
  await f.save({ roles: { 'bug-fix': [{ model: 'auto' }] } });
  const before = await readFile(f.file);
  await writeFile(f.input, JSON.stringify(first.config));
  const stale = f.invoke(
    'write',
    '--input',
    f.input,
    '--catalog',
    f.catalog,
    '--expected-hash',
    first.sha256!,
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /changed since/i);
  assert.deepEqual(await readFile(f.file), before);
});

test('malformed preferences and symlink destinations fail without mutating their targets', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.file), { recursive: true });
  await writeFile(f.file, 'invalid user configuration\n');
  const bad = f.invoke('read');
  assert.notEqual(bad.status, 0);
  assert.equal(await readFile(f.file, 'utf8'), 'invalid user configuration\n');
  await rm(f.file);
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, 'outside contents\n');
  await symlink(outside, f.file);
  const link = f.invoke('read');
  assert.notEqual(link.status, 0);
  assert.match(link.stderr, /symbolic link/i);
  assert.equal(await readFile(outside, 'utf8'), 'outside contents\n');
});

test('the new identity uses one schema for sparse native and mixed choices', async (t) => {
  const f = await fixture(t);
  await f.save({ schemaVersion: 1, roles: { 'bug-fix': [{ model: 'auto' }] } });
  const catalog = JSON.parse(await readFile(f.catalog, 'utf8'));
  catalog.data.push(sonnetCapability);
  await writeFile(f.catalog, JSON.stringify(catalog));
  const saved = await f.save({
    roles: {
      'hardest tasks': [
        {
          executor: 'claude-code',
          model: sonnetCapability.model,
          reasoningEffort: 'high',
        },
      ],
    },
  });
  assert.equal(saved.config.schemaVersion, 1);
  assert.deepEqual(Object.keys(saved.config.roles), [
    'bug-fix',
    'hardest tasks',
  ]);
  assert.equal(
    f.run('resolve', '--role', 'hardest tasks').entries[0]?.model,
    sonnetCapability.model,
  );
  const before = await readFile(f.file);
  await writeFile(
    f.input,
    JSON.stringify({ ...saved.config, schemaVersion: 2 }),
  );
  assert.notEqual(
    f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      saved.sha256!,
    ).status,
    0,
  );
  assert.deepEqual(await readFile(f.file), before);
});

test('independent user choices survive sparse saves and budget previews', async (t) => {
  const f = await fixture(t);
  const chosen: Entry[] = [
    { model: 'inherit-parent' },
    { executor: 'codex', model: 'gpt-6-sol', reasoningEffort: 'high' },
    { model: 'inherit-parent' },
  ];
  await f.save({
    roles: {
      'hardest tasks': [{ model: 'auto' }],
      'arena runners': chosen,
    },
  });
  const read = f.run('read');
  assert.deepEqual(read.config.roles['arena runners'], chosen);
  const budget = f.run(
    'budget',
    '--budget',
    'unlimited',
    '--catalog',
    f.catalog,
  );
  assert.deepEqual(budget.config.roles['arena runners'], chosen);
  assert.deepEqual(budget.config.roles['hardest tasks'], [{ model: 'auto' }]);
  await f.save({ roles: { 'bug-fix': [{ model: 'inherit-parent' }] } });
  assert.deepEqual(f.run('resolve', '--role', 'arena runners').entries, chosen);
});

test('runtime syntax adds no model capability or executable proposal default', async (t) => {
  const f = await fixture(t);
  const native = {
    data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] }],
  };
  await writeFile(f.catalog, JSON.stringify(native));
  const receipt = path.join(f.root, 'claude-runtime.json');
  await writeFile(receipt, JSON.stringify(claudeRuntime));
  const combined = f.run(
    'catalog',
    '--input',
    f.catalog,
    '--claude-runtime',
    receipt,
  );
  assert.deepEqual(combined.models, native.data);
  assert.equal(combined.runtimes?.[0]?.modelExecutionVerified, false);
  await writeFile(f.catalog, JSON.stringify(combined));
  await f.save({ roles: { 'bug-fix': [{ model: 'auto' }] } });
  assert.equal(
    f.run('resolve', '--role', 'hardest tasks').source,
    'unconfigured',
  );
  assert.deepEqual(f.run('resolve', '--role', 'hardest tasks').entries, [
    { model: 'inherit-parent' },
  ]);
});

test('Claude catalog rejects absent capabilities, obsolete CLI, unsupported options and drifting aliases', async (t) => {
  const f = await fixture(t);
  const external = {
    executor: 'claude-code',
    model: 'claude-opus-5-5',
    supportedReasoningEfforts: ['xhigh'],
    source: {
      kind: 'manual-confirmation',
      description: 'Fixture confirms exact model and efforts.',
    },
  };
  const cases = [
    { models: [external] },
    {
      models: [external],
      runtimes: [{ ...claudeRuntime, version: '2.1.279' }],
    },
    {
      models: [external],
      runtimes: [{ ...claudeRuntime, requiredOptions: { print: true } }],
    },
    { models: [{ ...external, model: 'opus' }], runtimes: [claudeRuntime] },
    {
      models: [{ ...external, supportedReasoningEfforts: ['ultra'] }],
      runtimes: [claudeRuntime],
    },
  ];
  for (const catalog of cases) {
    await writeFile(f.catalog, JSON.stringify(catalog));
    assert.notEqual(f.invoke('catalog', '--input', f.catalog).status, 0);
  }
  await assert.rejects(stat(f.codexHome), { code: 'ENOENT' });
});

test('executor identity prevents native catalog entries from validating external choices and aliases remain native', async (t) => {
  const f = await fixture(t);
  const combined = JSON.parse(await readFile(f.catalog, 'utf8'));
  combined.data.push(sonnetCapability);
  await writeFile(f.catalog, JSON.stringify(combined));
  const initial = await f.save({
    roles: {
      'hardest tasks': [
        {
          executor: 'claude-code',
          model: sonnetCapability.model,
          reasoningEffort: 'high',
        },
      ],
    },
  });
  const before = await readFile(f.file);
  for (const entry of [
    { executor: 'claude-code', model: 'auto' },
    { executor: 'claude-code', model: 'inherit-parent' },
    { executor: 'claude-code', model: 'opus', reasoningEffort: 'xhigh' },
    { executor: 'other', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
  ]) {
    await writeFile(
      f.input,
      JSON.stringify({ roles: { 'hardest tasks': [entry] } }),
    );
    const result = f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      initial.sha256!,
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(f.file), before);
  }
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [
        { model: 'gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] },
        { model: 'claude-opus-5-5', supportedReasoningEfforts: ['xhigh'] },
      ],
    }),
  );
  const preview = f.run('budget', '--budget', 'large', '--catalog', f.catalog);
  assert.equal(preview.needsChoice.length, 1);
  await writeFile(f.input, JSON.stringify(initial.config));
  const result = f.invoke(
    'write',
    '--input',
    f.input,
    '--catalog',
    f.catalog,
    '--expected-hash',
    initial.sha256!,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /detected claude-code catalog/);
  assert.deepEqual(await readFile(f.file), before);
});

const sonnetCapability = {
  executor: 'claude-code',
  model: 'claude-sonnet-fixture-20300101',
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  source: {
    kind: 'manual-confirmation',
    description:
      'Fixture user confirmed this exact model and its three efforts.',
  },
};
const providerCapability = {
  executor: 'claude-code',
  model: 'provider.anthropic.model-fixture-v1:0',
  supportedReasoningEfforts: ['medium', 'max'],
  source: {
    kind: 'configuration',
    description:
      'Fixture configuration records this exact provider ID and two efforts.',
  },
};

test('confirmed external models preserve provenance through catalog normalization and same-ID native entries', async (t) => {
  const f = await fixture(t);
  const input = {
    models: [
      sonnetCapability,
      providerCapability,
      { ...sonnetCapability, model: 'claude-opus-4-6[1m]' },
      {
        ...providerCapability,
        model: 'provider.anthropic.model-fixture-v1:0[1m]',
      },
      { model: sonnetCapability.model, supportedReasoningEfforts: ['xhigh'] },
    ],
    runtimes: [claudeRuntime],
  };
  await writeFile(f.catalog, JSON.stringify(input));
  const normalized = f.run('catalog', '--input', f.catalog);
  assert.deepEqual(
    normalized.models.slice(0, input.models.length),
    input.models,
  );
  await writeFile(f.catalog, JSON.stringify(normalized));
  assert.deepEqual(f.run('catalog', '--input', f.catalog), normalized);
  const explicitDefault = {
    ...sonnetCapability,
    model: 'claude-opus-5-5',
    supportedReasoningEfforts: ['medium'],
  };
  await writeFile(
    f.catalog,
    JSON.stringify({ ...input, models: [explicitDefault] }),
  );
  assert.deepEqual(f.run('catalog', '--input', f.catalog).models, [
    explicitDefault,
  ]);
});

test('nondefault selections round-trip offline and budgets retain ordered duplicate seats and user state', async (t) => {
  const f = await fixture(t);
  const catalog = JSON.parse(await readFile(f.catalog, 'utf8'));
  catalog.data.push(sonnetCapability, providerCapability);
  await writeFile(f.catalog, JSON.stringify(catalog));
  const sonnet = {
    executor: 'claude-code' as const,
    model: sonnetCapability.model,
    reasoningEffort: 'high',
  };
  const provider = {
    executor: 'claude-code' as const,
    model: providerCapability.model,
    reasoningEffort: 'medium',
  };
  const proposal = {
    roles: {
      'hardest tasks': [sonnet],
      'architect runners': [
        sonnet,
        provider,
        sonnet,
        { model: 'inherit-parent' },
      ],
    },
  };
  await f.save(proposal, 'absent', '--dry-run');
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
  await f.save(proposal);
  const before = await readFile(f.file);
  for (const [budget, sonnetEffort, providerEffort] of [
    ['unlimited', 'high', 'max'],
    ['large', 'high', 'medium'],
    ['medium', 'high', 'medium'],
    ['small', 'medium', 'medium'],
  ]) {
    const mapped = f.run('budget', '--budget', budget!, '--catalog', f.catalog);
    assert.deepEqual(mapped.needsChoice, []);
    assert.deepEqual(mapped.config.roles['architect runners'], [
      { ...sonnet, reasoningEffort: sonnetEffort },
      { ...provider, reasoningEffort: providerEffort },
      { ...sonnet, reasoningEffort: sonnetEffort },
      { model: 'inherit-parent' },
    ]);
  }
  await rm(f.catalog);
  assert.deepEqual(f.run('resolve', '--role', 'hardest tasks').entries, [
    sonnet,
  ]);
  assert.deepEqual(
    f.run('read').config.roles['architect runners'],
    proposal.roles['architect runners'],
  );
  assert.deepEqual(await readFile(f.file), before);
  await writeFile(f.catalog, JSON.stringify(catalog));
  catalog.data = catalog.data.filter(
    (entry: { model: string }) => entry.model !== sonnet.model,
  );
  await writeFile(f.catalog, JSON.stringify(catalog));
  const unavailable = f.run(
    'budget',
    '--budget',
    'large',
    '--catalog',
    f.catalog,
  );
  assert.equal(unavailable.needsChoice.length, 3);
  await writeFile(f.input, JSON.stringify(unavailable));
  assert.notEqual(
    f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      f.run('read').sha256!,
    ).status,
    0,
  );
  assert.deepEqual(await readFile(f.file), before);
});

test('external capabilities need per-model provenance and cannot borrow runtime candidates or native effort support', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { ...sonnetCapability, source: undefined },
    {
      ...sonnetCapability,
      source: { kind: 'manual-confirmation', description: ' ' },
    },
    {
      ...sonnetCapability,
      source: {
        kind: 'bundled-default',
        description: 'Not a bundled default.',
      },
    },
    { ...sonnetCapability, supportedReasoningEfforts: ['ultra'] },
    ...[
      'opus',
      'sonnet',
      'haiku',
      'sonnet[1m]',
      'opus[1m]',
      'auto',
      'inherit-parent',
      '',
      ' leading',
      '--flag',
      'embedded\nnewline',
    ].map((model) => ({ ...sonnetCapability, model })),
  ]) {
    await writeFile(
      f.catalog,
      JSON.stringify({ models: [invalid], runtimes: [claudeRuntime] }),
    );
    assert.notEqual(
      f.invoke('catalog', '--input', f.catalog).status,
      0,
      JSON.stringify(invalid),
    );
  }
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [{ ...sonnetCapability, source: undefined }],
      runtimes: [{ ...claudeRuntime, models: [sonnetCapability] }],
    }),
  );
  assert.notEqual(f.invoke('catalog', '--input', f.catalog).status, 0);
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [],
      runtimes: [{ ...claudeRuntime, models: [sonnetCapability] }],
    }),
  );
  assert.deepEqual(
    f.run('catalog', '--input', f.catalog).models.map((entry) => entry.model),
    [],
  );
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [sonnetCapability, sonnetCapability],
      runtimes: [claudeRuntime],
    }),
  );
  assert.notEqual(f.invoke('catalog', '--input', f.catalog).status, 0);
  const catalog = {
    models: [
      { model: 'gpt-6.1-sol', supportedReasoningEfforts: ['xhigh'] },
      { model: sonnetCapability.model, supportedReasoningEfforts: ['xhigh'] },
      sonnetCapability,
    ],
    runtimes: [claudeRuntime],
  };
  await writeFile(f.catalog, JSON.stringify(catalog));
  await writeFile(
    f.input,
    JSON.stringify({
      roles: {
        'hardest tasks': [
          {
            executor: 'claude-code',
            model: sonnetCapability.model,
            reasoningEffort: 'xhigh',
          },
        ],
      },
    }),
  );
  assert.notEqual(
    f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      'absent',
    ).status,
    0,
  );
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
});

test('detected transport, confirmed catalog, budgeted saved role and runner forward one nondefault selection', async (t) => {
  const f = await fixture(t);
  const runner = path.join(
    f.bundledSkills,
    'poteto-mode/scripts/run-claude.mjs',
  );
  const executable = path.join(f.root, 'existing claude fixture');
  const capture = path.join(f.root, 'received argv.json');
  await writeFile(
    executable,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('2.1.300 (Claude Code)');
else if (args[0] === '--help') console.log('--print --model --effort low medium high xhigh max --output-format stream-json --verbose --resume');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
    const modelIndex = args.indexOf('--model');
    const model = modelIndex < 0 ? null : args[modelIndex + 1];
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model }));
    console.log(JSON.stringify({ type: 'result', result: 'Fixture received ' + model }));
  });
}
`,
    { mode: 0o755 },
  );
  const execute = (args: string[], input?: string) => {
    const result = spawnSync(
      process.execPath,
      [runner, ...args, '--executable', executable],
      { cwd: f.root, encoding: 'utf8', input, timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const runtime = execute(['detect']);
  await assert.rejects(stat(capture), { code: 'ENOENT' });
  const runtimeFile = path.join(f.root, 'detected-runtime.json');
  await writeFile(runtimeFile, JSON.stringify(runtime));
  const combined = JSON.parse(await readFile(f.catalog, 'utf8'));
  delete combined.runtimes;
  combined.data.push(sonnetCapability);
  await writeFile(f.catalog, JSON.stringify(combined));
  const normalized = f.run(
    'catalog',
    '--input',
    f.catalog,
    '--claude-runtime',
    runtimeFile,
  );
  await writeFile(f.catalog, JSON.stringify(normalized));
  await f.save({
    roles: {
      'how explainer': [
        {
          executor: 'claude-code',
          model: sonnetCapability.model,
          reasoningEffort: 'high',
        },
      ],
    },
  });
  const budget = f.run('budget', '--budget', 'small', '--catalog', f.catalog);
  await f.save(budget);
  assert.equal(f.run('read').config.budget, 'small');
  const entry = f.run('resolve', '--role', 'how explainer').entries[0]!;
  assert.deepEqual(entry, {
    executor: 'claude-code',
    model: sonnetCapability.model,
    reasoningEffort: 'medium',
  });
  const instruction = path.join(f.root, 'AGENTS.md');
  await writeFile(instruction, 'Apply the fixture task only.\n');
  const receipt = execute(
    [
      'run',
      '--cwd',
      f.root,
      '--run-dir',
      path.join(f.root, 'run'),
      '--model',
      entry.model,
      '--effort',
      entry.reasoningEffort!,
      '--instruction',
      instruction,
      '--skill',
      path.join(projectRoot, 'plugin/skills/how/SKILL.md'),
    ],
    'Report the received fixture model.\n',
  );
  const argv = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(argv[argv.indexOf('--model') + 1], sonnetCapability.model);
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium');
  assert.equal(receipt.model, sonnetCapability.model);
  assert.equal(receipt.observedModel, sonnetCapability.model);
  assert.equal(receipt.result, `Fixture received ${sonnetCapability.model}`);
});

test('native-only sparse setup saves without an external runtime or CLI and rejects unresolved proposal slots', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [
        { model: 'native-fixture', supportedReasoningEfforts: ['high'] },
      ],
    }),
  );
  const accepted = await f.save({
    budget: 'medium',
    roles: {
      'how explainer': [
        { executor: 'codex', model: 'native-fixture', reasoningEffort: 'high' },
      ],
    },
  });
  assert.equal(accepted.config.schemaVersion, 1);
  assert.deepEqual(
    f.run('resolve', '--role', 'how explainer').entries,
    accepted.config.roles['how explainer'],
  );
  assert.deepEqual(f.run('resolve', '--role', 'arena runners').entries, [
    { model: 'inherit-parent' },
    { model: 'inherit-parent' },
  ]);
  const before = await readFile(f.file);
  await writeFile(f.input, JSON.stringify(f.run('read').proposal));
  assert.notEqual(
    f.invoke(
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      accepted.sha256!,
    ).status,
    0,
  );
  assert.deepEqual(await readFile(f.file), before);
});

test('the new state identity never imports an old installation preference file', async (t) => {
  const f = await fixture(t);
  const oldState = path.join(f.codexHome, 'pstack-for-codex');
  await mkdir(oldState, { recursive: true });
  const bytes = JSON.stringify({
    schemaVersion: 2,
    roles: { 'bug-fix': [{ model: 'old-choice' }] },
  });
  await writeFile(path.join(oldState, 'models.json'), bytes);
  assert.deepEqual(f.run('read').config.roles, {});
  assert.equal(f.run('resolve', '--role', 'bug-fix').source, 'unconfigured');
  assert.equal(
    await readFile(path.join(oldState, 'models.json'), 'utf8'),
    bytes,
  );
});
