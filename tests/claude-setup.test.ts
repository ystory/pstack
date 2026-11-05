import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const roleNames = [
  'feature, refactoring',
  'bug-fix',
  'perf-issue',
  'hillclimb',
  'judgment and prose',
  'hardest tasks',
  'how explorer',
  'how explainer',
  'why investigators',
  'why synthesizer',
  'reflect tooling',
  'reflect judgment, divergent, synthesizer',
  'arena runners',
  'arena cross-judge pool',
  'swarm workers',
  'architect runners',
  'interrogate reviewers',
];
const workerKinds = [
  'general-purpose',
  'poteto-agent',
  'comment-sicko',
  'read-only',
];
const lists = new Set([
  'arena runners',
  'arena cross-judge pool',
  'architect runners',
  'interrogate reviewers',
]);
type Entry =
  | string
  | {
      executor: string;
      model: string;
      reasoningEffort?: string;
      agentType?: string;
      modelKind?: string;
      upstreamModel?: string;
    };
type Config = {
  schemaVersion: number;
  host: string;
  budget: string;
  roles: Record<string, Entry | Entry[]>;
};
type Models = {
  file: string;
  exists: boolean;
  sha256: string | null;
  config: Config;
  proposal: Config;
  changed: boolean;
  entries: Exclude<Entry, string>[];
  needsChoice: { role: string; reason: string }[];
  source: string;
  cardinality: string;
  models: {
    executor: string;
    model: string;
    supportedReasoningEfforts: string[];
  }[];
};
type Agents = {
  changed: boolean;
  recovered: boolean;
  agents: { file: string; agentType: string; kind: string; model: string }[];
  registry: string;
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack Claude setup '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin with spaces');
  const setup = path.join(plugin, 'skills/setup-pstack');
  await cp(path.join(project, 'plugin-claude/skills/setup-pstack'), setup, {
    recursive: true,
  });
  await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(plugin, 'agents'), { recursive: true });
  await writeFile(
    path.join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'pstack-cc', version: '0.1.0' }),
  );
  for (const kind of workerKinds)
    await writeFile(
      path.join(plugin, 'agents', `${kind}.md`),
      `---\nname: ${kind}\ndescription: ${kind} fixture\n${kind === 'read-only' ? 'disallowedTools: Write, Edit, NotebookEdit\n' : ''}model: inherit\n---\n\nOriginal ${kind} body.\nRead the assigned skills in full.\n`,
    );
  await mkdir(path.join(plugin, 'skills/poteto-mode/scripts'), {
    recursive: true,
  });
  await writeFile(
    path.join(plugin, 'skills/poteto-mode/scripts/run-codex.mjs'),
    'process.stdout.write(JSON.stringify(JSON.parse(process.env.PSTACK_FIXTURE_CODEX)));\n',
  );
  const home = path.join(root, 'Claude home');
  const codex = path.join(root, 'Codex home');
  const catalog = path.join(root, 'catalog.json');
  const input = path.join(root, 'proposal.json');
  const model = 'claude-fixture-exact-20300101';
  const catalogValue = {
    models: [
      {
        executor: 'claude-code',
        model,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        source: {
          kind: 'manual-confirmation',
          description:
            'Fixture account confirms this exact model and its effort options.',
        },
      },
      {
        executor: 'codex',
        model: 'gpt-fixture',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
        ],
      },
      { executor: 'codex', model, supportedReasoningEfforts: ['medium'] },
    ],
  };
  await writeFile(catalog, JSON.stringify(catalogValue));
  const invoke = (
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync(
      process.execPath,
      [path.join(setup, 'scripts', script), ...args],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          CODEX_HOME: codex,
          CLAUDE_CONFIG_DIR: home,
          ...env,
        },
      },
    );
  function run<T = Models>(script: string, ...args: string[]): T {
    const result = invoke(script, args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as T;
  }
  const models = (...args: string[]) => run('models.mjs', ...args);
  const config = (nativeModel = model): Config => ({
    schemaVersion: 1,
    host: 'claude-code',
    budget: 'large',
    roles: Object.fromEntries(
      roleNames.map((role) => [
        role,
        lists.has(role)
          ? [
              {
                executor: 'claude-code',
                model: nativeModel,
                reasoningEffort: 'xhigh',
              },
              {
                executor: 'codex',
                model: 'gpt-fixture',
                reasoningEffort: 'high',
              },
            ]
          : {
              executor: 'claude-code',
              model: nativeModel,
              reasoningEffort: 'xhigh',
            },
      ]),
    ),
  });
  const save = async (value: unknown, ...extra: string[]) => {
    await writeFile(input, JSON.stringify(value));
    return models(
      'write',
      '--input',
      input,
      '--catalog',
      catalog,
      '--expected-hash',
      models('read').sha256 ?? 'absent',
      ...extra,
    );
  };
  return {
    root,
    plugin,
    setup,
    home,
    codex,
    catalog,
    catalogValue,
    input,
    model,
    invoke,
    run,
    models,
    config,
    save,
  };
}

test('new Claude setup preserves upstream proposals without assigning Sol or persisting unresolved suggestions', async (t) => {
  const f = await fixture(t);
  const read = f.models('read');
  assert.equal(read.exists, false);
  assert.deepEqual(read.config.roles, {});
  assert.deepEqual(Object.keys(read.proposal.roles), roleNames);
  assert.ok(read.needsChoice.some((entry) => entry.role === 'bug-fix'));
  const unresolved = f.models(
    'resolve',
    '--role',
    'bug-fix',
    '--kind',
    'poteto-agent',
  );
  assert.equal(unresolved.entries.length, 1);
  assert.equal(unresolved.needsChoice.length, 0);
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('execution defaults work without setup or registration while setup proposals still need choices', async (t) => {
  const f = await fixture(t);
  const explorer = f.models(
    'resolve',
    '--role',
    'how explorer',
    '--kind',
    'general-purpose',
  );
  assert.equal(explorer.source, 'upstream-default');
  assert.deepEqual(explorer.entries, [
    {
      executor: 'claude-code',
      model: 'inherit-parent',
      upstreamModel: 'grok-4.7',
      agentType: 'pstack-cc:general-purpose',
    },
  ]);
  const explainer = f.models(
    'resolve',
    '--role',
    'how explainer',
    '--kind',
    'general-purpose',
  );
  assert.deepEqual(explainer.entries, [
    {
      executor: 'claude-code',
      model: 'opus',
      modelKind: 'native-alias',
      upstreamModel: 'claude-opus-5-5',
      reasoningEffort: 'xhigh',
      agentType: 'pstack-cc:general-purpose',
    },
  ]);
  assert.deepEqual(explorer.needsChoice, []);
  assert.deepEqual(explainer.needsChoice, []);
  for (const role of lists) {
    const resolved = f.models(
      'resolve',
      '--role',
      role,
      '--kind',
      'general-purpose',
    );
    assert.deepEqual(
      resolved.entries.map((entry) => entry.model),
      ['opus', 'inherit-parent'],
    );
    assert.ok(
      resolved.entries.every(
        (entry) => entry.agentType === 'pstack-cc:general-purpose',
      ),
    );
    assert.deepEqual(resolved.needsChoice, []);
  }
  assert.ok(
    f.models('read').needsChoice.some((entry) => entry.role === 'how explorer'),
  );
  for (const kind of workerKinds) {
    const resolved = f.models(
      'resolve',
      '--role',
      'how explorer',
      '--kind',
      kind,
    );
    assert.equal(resolved.entries[0]?.agentType, `pstack-cc:${kind}`);
    assert.equal(resolved.entries[0]?.model, 'inherit-parent');
  }
  assert.equal(
    f.run<Agents>('register-agents.mjs', '--dry-run').agents.length,
    0,
  );
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('missing roles in partial preferences use native defaults and explicit defaults leave exact selections intact', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, 'pstack-cc'), { recursive: true });
  const selected = {
    executor: 'claude-code',
    model: f.model,
    reasoningEffort: 'high',
  };
  const saved = {
    schemaVersion: 1,
    host: 'claude-code',
    budget: 'small',
    roles: { 'how explorer': selected },
  };
  const file = path.join(f.home, 'pstack-cc/models.json');
  await writeFile(file, JSON.stringify(saved));
  const before = await readFile(file);
  const exact = f.models(
    'resolve',
    '--role',
    'how explorer',
    '--kind',
    'read-only',
  );
  assert.equal(exact.source, 'saved');
  assert.deepEqual(exact.entries[0], {
    ...selected,
    agentType: `pstack-cc-read-only-${createHash('sha256').update(f.model).digest('hex').slice(0, 16)}`,
  });
  assert.equal(
    f.models(
      'resolve',
      '--role',
      'how explorer',
      '--kind',
      'read-only',
      '--defaults',
    ).entries[0]?.model,
    'inherit-parent',
  );
  const missing = f.models(
    'resolve',
    '--role',
    'how explainer',
    '--kind',
    'read-only',
  );
  assert.equal(missing.entries[0]?.model, 'opus');
  assert.equal(missing.entries[0]?.reasoningEffort, 'medium');
  assert.equal(missing.entries[0]?.agentType, 'pstack-cc:read-only');
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(f.models('read').config.roles, saved.roles);
});

test('read-only registration preserves exact models and denies file mutation tools without restricting other kinds', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  const registered = f.run<Agents>('register-agents.mjs');
  const resolved = f.models(
    'resolve',
    '--role',
    'how explorer',
    '--kind',
    'read-only',
  );
  const readonly = registered.agents.find(
    (entry) => entry.kind === 'read-only',
  );
  assert.ok(readonly);
  assert.equal(readonly.agentType, resolved.entries[0]?.agentType);
  assert.equal(readonly.model, f.model);
  const definition = await readFile(readonly.file, 'utf8');
  assert.match(definition, /disallowedTools: Write, Edit, NotebookEdit\n/);
  assert.ok(definition.includes(`model: "${f.model}"\n`));
  for (const agent of registered.agents.filter(
    (entry) => entry.kind !== 'read-only',
  ))
    assert.ok(
      !(await readFile(agent.file, 'utf8')).includes('disallowedTools:'),
    );
});

test('scalar shapes, panel duplicates, pool order and aliases survive actual write read and resolve', async (t) => {
  const f = await fixture(t);
  const config = f.config();
  config.roles['bug-fix'] = 'auto';
  config.roles['hillclimb'] = {
    executor: 'claude-code',
    model: 'inherit-parent',
  };
  const panel: Entry[] = [
    'auto',
    { executor: 'codex', model: 'gpt-fixture', reasoningEffort: 'high' },
    'auto',
  ];
  config.roles['arena runners'] = panel;
  config.roles['arena cross-judge pool'] = [...panel].reverse();
  await f.save(config);
  const read = f.models('read');
  assert.equal(Object.keys(read.config.roles).length, 17);
  assert.equal(read.config.roles['bug-fix'], 'auto');
  assert.deepEqual(read.config.roles['arena runners'], panel);
  const resolved = f.models(
    'resolve',
    '--role',
    'arena runners',
    '--kind',
    'general-purpose',
  );
  assert.equal(resolved.cardinality, 'panel');
  assert.equal(resolved.entries.length, 3);
  assert.equal(resolved.entries[0]?.agentType, 'pstack-cc:general-purpose');
  assert.equal(resolved.entries[1]?.executor, 'codex');
  assert.equal(resolved.entries[2]?.agentType, resolved.entries[0]?.agentType);
  assert.deepEqual(
    f
      .models('resolve', '--role', 'arena cross-judge pool')
      .entries.map((entry) => entry.model),
    ['auto', 'gpt-fixture', 'auto'],
  );
});

test('saving Claude choices leaves independent Codex preferences and unrelated Claude files byte-identical', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.codex, 'pstack-for-codex'), { recursive: true });
  const codexFile = path.join(f.codex, 'pstack-for-codex/models.json');
  await writeFile(codexFile, 'Codex-owned fixture bytes\n');
  await mkdir(f.home, { recursive: true });
  const settings = path.join(f.home, 'settings.json');
  await writeFile(settings, '{ "model": "user-choice", "unknown": true }\n');
  await f.save(f.config());
  assert.equal(
    await readFile(codexFile, 'utf8'),
    'Codex-owned fixture bytes\n',
  );
  assert.equal(
    await readFile(settings, 'utf8'),
    '{ "model": "user-choice", "unknown": true }\n',
  );
  const override = path.join(f.root, 'explicit Claude home');
  const result = f.models('read', '--claude-home', override);
  assert.equal(result.file, path.join(override, 'pstack-cc/models.json'));
  assert.equal(result.exists, false);
});

test('partial reconfiguration preserves chosen roles and idempotent saves preserve timestamps and mode', async (t) => {
  const f = await fixture(t);
  const first = await f.save(f.config());
  const before = await readFile(first.file);
  const fixed = new Date('2020-01-01T00:00:00Z');
  await utimes(first.file, fixed, fixed);
  const same = await f.save(first.config);
  assert.equal(same.changed, false);
  assert.equal((await stat(first.file)).mtimeMs, fixed.getTime());
  assert.equal((await stat(first.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(first.file), before);
  await f.save({ roles: { 'bug-fix': 'inherit-parent' } });
  assert.equal(f.models('read').config.roles['bug-fix'], 'inherit-parent');
  assert.deepEqual(
    f.models('read').config.roles['hardest tasks'],
    first.config.roles['hardest tasks'],
  );
});

test('budgets retain executor and exact ID with effort fallback and parent aliases unchanged', async (t) => {
  const f = await fixture(t);
  const config = f.config();
  config.roles['bug-fix'] = 'inherit-parent';
  await f.save(config);
  const budget = f.models(
    'budget',
    '--budget',
    'unlimited',
    '--catalog',
    f.catalog,
  );
  assert.equal(budget.config.roles['bug-fix'], 'inherit-parent');
  assert.deepEqual(budget.config.roles['arena runners'], [
    { executor: 'claude-code', model: f.model, reasoningEffort: 'max' },
    { executor: 'codex', model: 'gpt-fixture', reasoningEffort: 'high' },
  ]);
  assert.deepEqual(budget.needsChoice, []);
  await f.save(budget);
});

test('executor-specific catalogs validate supported efforts and reject native aliases, unconfirmed native IDs and incomplete pages', async (t) => {
  const f = await fixture(t);
  const normalized = f.models('catalog', '--input', f.catalog);
  assert.equal(normalized.models.length, 3);
  assert.deepEqual(normalized.models[1]?.supportedReasoningEfforts, [
    'medium',
    'high',
  ]);
  for (const value of [
    {
      models: [
        {
          executor: 'claude-code',
          model: f.model,
          supportedReasoningEfforts: ['high'],
        },
      ],
    },
    { models: [{ ...f.catalogValue.models[0], model: 'opus' }] },
    { ...f.catalogValue, nextCursor: 'next-page' },
  ]) {
    await writeFile(f.catalog, JSON.stringify(value));
    assert.notEqual(
      f.invoke('models.mjs', ['catalog', '--input', f.catalog]).status,
      0,
    );
  }
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [
        {
          executor: 'codex',
          model: f.model,
          supportedReasoningEfforts: ['xhigh'],
        },
      ],
    }),
  );
  await writeFile(f.input, JSON.stringify(f.config()));
  assert.notEqual(
    f.invoke('models.mjs', [
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      'absent',
    ]).status,
    0,
  );
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('malformed cardinalities, external aliases and unsupported efforts cannot alter saved preferences', async (t) => {
  const f = await fixture(t);
  const saved = await f.save(f.config());
  const before = await readFile(saved.file);
  for (const roles of [
    { 'bug-fix': ['auto'] },
    { 'arena runners': 'auto' },
    { 'arena cross-judge pool': [] },
    { 'bug-fix': { executor: 'codex', model: 'auto' } },
    {
      'bug-fix': {
        executor: 'claude-code',
        model: 'auto',
        reasoningEffort: 'high',
      },
    },
    {
      'bug-fix': {
        executor: 'codex',
        model: 'gpt-fixture',
        reasoningEffort: 'max',
      },
    },
  ]) {
    await writeFile(f.input, JSON.stringify({ roles }));
    assert.notEqual(
      f.invoke('models.mjs', [
        'write',
        '--input',
        f.input,
        '--catalog',
        f.catalog,
        '--expected-hash',
        saved.sha256!,
      ]).status,
      0,
    );
    assert.deepEqual(await readFile(saved.file), before);
  }
});

test('hash checks and symlink guards prevent overwriting changed or unrelated data', async (t) => {
  const f = await fixture(t);
  const first = await f.save(f.config());
  await f.save({ roles: { 'bug-fix': 'auto' } });
  const before = await readFile(first.file);
  await writeFile(f.input, JSON.stringify(first.config));
  assert.notEqual(
    f.invoke('models.mjs', [
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      first.sha256!,
    ]).status,
    0,
  );
  assert.deepEqual(await readFile(first.file), before);
  await rm(first.file);
  const target = path.join(f.root, 'unrelated.json');
  await writeFile(target, 'unrelated\n');
  await symlink(target, first.file);
  assert.notEqual(f.invoke('models.mjs', ['read']).status, 0);
  assert.equal(await readFile(target, 'utf8'), 'unrelated\n');
});

test('registrar binds exact model in frontmatter, preserves bodies, and leaves other host settings and agents intact', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  await mkdir(path.join(f.home, 'agents'), { recursive: true });
  await writeFile(
    path.join(f.home, 'settings.json'),
    '{ "model": "original" }\n',
  );
  await writeFile(
    path.join(f.home, 'agents/unrelated.md'),
    'unrelated agent\n',
  );
  const registered = f.run<Agents>('register-agents.mjs');
  assert.equal(registered.agents.length, 4);
  const resolve = f.models(
    'resolve',
    '--role',
    'bug-fix',
    '--kind',
    'poteto-agent',
  );
  const poteto = registered.agents.find(
    (entry) => entry.kind === 'poteto-agent',
  )!;
  assert.equal(resolve.entries[0]?.agentType, poteto.agentType);
  const text = await readFile(poteto.file, 'utf8');
  assert.ok(text.includes(`model: "${f.model}"\n`));
  assert.ok(
    text.endsWith(
      '\nOriginal poteto-agent body.\nRead the assigned skills in full.\n',
    ),
  );
  assert.ok(!text.includes('model: inherit'));
  assert.equal(
    await readFile(path.join(f.home, 'settings.json'), 'utf8'),
    '{ "model": "original" }\n',
  );
  assert.equal(
    await readFile(path.join(f.home, 'agents/unrelated.md'), 'utf8'),
    'unrelated agent\n',
  );
  assert.equal(f.run<Agents>('register-agents.mjs').changed, false);
});

for (const failure of ['interruption', 'stale preference save']) {
  test(`staged registration preserves saved native selections after ${failure}`, async (t) => {
    const f = await fixture(t);
    const saved = await f.save(f.config());
    const original = f.run<Agents>('register-agents.mjs');
    const savedBytes = await readFile(saved.file);
    const originalBytes = await Promise.all(
      original.agents.map((agent) => readFile(agent.file)),
    );
    const replacement = 'claude-replacement-exact-20300101';
    await writeFile(
      f.catalog,
      JSON.stringify({
        models: [
          ...f.catalogValue.models,
          { ...f.catalogValue.models[0], model: replacement },
        ],
      }),
    );
    await f.save(f.config(replacement), '--dry-run');
    const proposal = path.join(f.root, 'validated proposal.json');
    await cp(f.input, proposal);
    f.run<Agents>('register-agents.mjs', '--input', proposal);
    if (failure === 'stale preference save')
      await f.save({ roles: { hillclimb: 'auto' } });
    const committed = await readFile(saved.file);
    if (failure === 'interruption') assert.deepEqual(committed, savedBytes);
    if (failure === 'stale preference save') {
      const rejected = f.invoke('models.mjs', [
        'write',
        '--input',
        proposal,
        '--catalog',
        f.catalog,
        '--expected-hash',
        saved.sha256!,
      ]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /changed since it was read/);
    }
    assert.deepEqual(await readFile(saved.file), committed);
    for (const [index, agent] of original.agents.entries()) {
      const resolved = f.models(
        'resolve',
        '--role',
        'bug-fix',
        '--kind',
        agent.kind,
      );
      assert.equal(resolved.entries[0]?.model, f.model);
      assert.equal(resolved.entries[0]?.agentType, agent.agentType);
      assert.deepEqual(await readFile(agent.file), originalBytes[index]);
    }
  });
}

test('overlapping proposals retain each staged definition through successful saves and unregister removes every owned variant', async (t) => {
  const f = await fixture(t);
  const saved = await f.save(f.config());
  const original = f.run<Agents>('register-agents.mjs');
  const replacements = [
    'claude-second-exact-20300101',
    'claude-third-exact-20300101',
  ];
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [
        ...f.catalogValue.models,
        ...replacements.map((model) => ({
          ...f.catalogValue.models[0],
          model,
        })),
      ],
    }),
  );
  const staged = [];
  for (const model of replacements) {
    await f.save(f.config(model), '--dry-run');
    const proposal = path.join(f.root, `${model}.json`);
    await cp(f.input, proposal);
    const registered = f.run<Agents>(
      'register-agents.mjs',
      '--input',
      proposal,
    );
    staged.push({ model, proposal, agents: registered.agents });
  }
  const allAgents = [
    ...original.agents,
    ...staged.flatMap((entry) => entry.agents),
  ];
  assert.equal(allAgents.length, 12);
  let expectedHash = saved.sha256!;
  for (const { model, proposal } of staged) {
    const committed = f.models(
      'write',
      '--input',
      proposal,
      '--catalog',
      f.catalog,
      '--expected-hash',
      expectedHash,
    );
    expectedHash = committed.sha256!;
    f.run<Agents>('register-agents.mjs');
    for (const kind of workerKinds) {
      const resolved = f.models('resolve', '--role', 'bug-fix', '--kind', kind);
      assert.equal(resolved.entries[0]?.model, model);
      const file = path.join(
        f.home,
        'agents/pstack-cc',
        `${resolved.entries[0]!.agentType}.md`,
      );
      assert.ok((await readFile(file, 'utf8')).includes(`model: "${model}"`));
    }
    for (const agent of allAgents) await stat(agent.file);
  }
  const preferences = await readFile(saved.file);
  f.run('register-agents.mjs', '--unregister');
  for (const agent of allAgents)
    await assert.rejects(stat(agent.file), { code: 'ENOENT' });
  await assert.rejects(stat(original.registry), { code: 'ENOENT' });
  assert.deepEqual(await readFile(saved.file), preferences);
});

test('registration upgrades an existing three-kind ownership record without changing existing exact definitions', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  const initial = f.run<Agents>('register-agents.mjs');
  const record = JSON.parse(await readFile(initial.registry, 'utf8'));
  const readonly = initial.agents.find((entry) => entry.kind === 'read-only')!;
  await rm(readonly.file);
  delete record.agents[path.relative(f.home, readonly.file)];
  await writeFile(initial.registry, JSON.stringify(record));
  const previous = await Promise.all(
    initial.agents
      .filter((entry) => entry.kind !== 'read-only')
      .map(async (entry) => ({ ...entry, bytes: await readFile(entry.file) })),
  );
  const upgraded = f.run<Agents>('register-agents.mjs');
  assert.equal(upgraded.agents.length, 4);
  assert.ok(
    (await readFile(readonly.file, 'utf8')).includes(`model: "${f.model}"`),
  );
  for (const entry of previous)
    assert.deepEqual(await readFile(entry.file), entry.bytes);
  assert.equal(f.run<Agents>('register-agents.mjs').changed, false);
});

test('owned source updates, older source restoration and unregister preserve model preferences', async (t) => {
  const f = await fixture(t);
  const saved = await f.save(f.config());
  const initial = f.run<Agents>('register-agents.mjs');
  const agent = initial.agents.find((entry) => entry.kind === 'poteto-agent')!;
  const original = await readFile(agent.file);
  const source = path.join(f.plugin, 'agents/poteto-agent.md');
  const oldSource = await readFile(source, 'utf8');
  await writeFile(
    source,
    oldSource.replace(
      'Original poteto-agent body.',
      'Updated poteto-agent body.',
    ),
  );
  assert.equal(f.run<Agents>('register-agents.mjs').changed, true);
  assert.match(await readFile(agent.file, 'utf8'), /Updated poteto-agent body/);
  await writeFile(source, oldSource);
  f.run<Agents>('register-agents.mjs');
  assert.deepEqual(await readFile(agent.file), original);
  const preferences = await readFile(saved.file);
  f.run('register-agents.mjs', '--unregister');
  await assert.rejects(stat(agent.file), { code: 'ENOENT' });
  await assert.rejects(stat(initial.registry), { code: 'ENOENT' });
  assert.deepEqual(await readFile(saved.file), preferences);
});

test('user modifications or unowned deterministic agent files block registration without changing other files', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  const initial = f.run<Agents>('register-agents.mjs');
  const edited = initial.agents[0]!;
  await writeFile(edited.file, 'user changed this agent\n');
  const other = await readFile(initial.agents[1]!.file);
  for (const args of [[], ['--unregister']])
    assert.notEqual(f.invoke('register-agents.mjs', args).status, 0);
  assert.equal(
    await readFile(edited.file, 'utf8'),
    'user changed this agent\n',
  );
  assert.deepEqual(await readFile(initial.agents[1]!.file), other);
});

test('registration recovers an interrupted owned transaction before applying the requested state', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  const initial = f.run<Agents>('register-agents.mjs');
  const agent = initial.agents[0]!;
  const previous = await readFile(agent.file);
  const previousMode = (await stat(agent.file)).mode & 0o777;
  const partial = Buffer.from('Interrupted prior update\n');
  const state = (bytes: Buffer) => ({
    bytes: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: previousMode,
  });
  const pending = path.join(
    f.home,
    'pstack-cc/.agent-registration.pending.json',
  );
  await writeFile(
    pending,
    JSON.stringify({
      schemaVersion: 1,
      plans: [
        {
          relative: path.relative(f.home, agent.file),
          previous: state(partial),
          next: state(previous),
        },
      ],
    }),
  );
  await writeFile(agent.file, partial);
  const recovered = f.run<Agents>('register-agents.mjs');
  assert.equal(recovered.recovered, true);
  assert.deepEqual(await readFile(agent.file), previous);
  await assert.rejects(stat(pending), { code: 'ENOENT' });
  assert.equal(f.run<Agents>('register-agents.mjs').changed, false);
});

test('dry-run registration and preference validation leave absent homes absent', async (t) => {
  const f = await fixture(t);
  const result = await f.save(f.config(), '--dry-run');
  assert.equal(result.changed, true);
  await f.run<Agents>('register-agents.mjs', '--input', f.input, '--dry-run');
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('detect reports missing optional Codex and logged-out Claude guidance without installation or credential output', async (t) => {
  const f = await fixture(t);
  const fake = path.join(f.root, 'fake claude');
  await writeFile(
    fake,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('2.1.292 (Claude Code)');else if(process.argv.includes('--help'))console.log('--agents --effort');else {console.log(JSON.stringify({loggedIn:false,authMethod:'none',email:'private@example.invalid',apiKey:'secret-fixture'}));process.exitCode=1;}\n`,
  );
  await chmod(fake, 0o755);
  const result = f.invoke(
    'detect.mjs',
    ['detect', '--claude-executable', fake],
    {
      PSTACK_FIXTURE_CODEX: JSON.stringify({
        cli: { available: false },
        auth: { verified: false, loggedIn: null, method: null },
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const detection = JSON.parse(result.stdout);
  assert.equal(detection.claude.cli.perCallEffort, true);
  assert.equal(detection.claude.auth.loggedIn, false);
  assert.ok(
    detection.guidance.some(
      (entry: { action: string }) => entry.action === 'optional-install',
    ),
  );
  assert.ok(
    detection.guidance.some(
      (entry: { command: string }) => entry.command === 'claude auth login',
    ),
  );
  assert.ok(!result.stdout.includes('secret-fixture'));
  assert.ok(!result.stdout.includes('private@example'));
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

for (const configuredProfile of [true, false]) {
  for (const loggedIn of [true, false]) {
    test(`detect uses the inherited ${configuredProfile ? 'configured' : 'default'} CLI profile when the preferences target differs and login is ${loggedIn}`, async (t) => {
      const f = await fixture(t);
      const hostHome = path.join(f.root, 'existing CLI profile');
      const targetHome = path.join(f.root, 'empty preferences target');
      const credentialFile = path.join(hostHome, '.credentials.json');
      const credentials = JSON.stringify({
        loggedIn,
        token: 'private-fixture-credential',
      });
      await mkdir(hostHome);
      await writeFile(credentialFile, credentials, { mode: 0o600 });
      const fake = path.join(f.root, 'profile-aware claude');
      await writeFile(
        fake,
        `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nimport path from 'node:path';\nconst home = process.env.CLAUDE_CONFIG_DIR ?? process.env.PSTACK_FIXTURE_AUTH_HOME;\nconst inherited = home === process.env.PSTACK_FIXTURE_AUTH_HOME;\nif (process.argv.includes('--version')) console.log(inherited ? '2.1.292' : '0.0.0');\nelse if (process.argv.includes('--help')) console.log(inherited ? '--agents --effort' : '');\nelse {\n  const loggedIn = inherited && JSON.parse(readFileSync(path.join(home, '.credentials.json'), 'utf8')).loggedIn;\n  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'oauth_token' : 'none', apiKey: 'private-fixture-credential' }));\n  process.exitCode = loggedIn ? 0 : 1;\n}\n`,
      );
      await chmod(fake, 0o755);
      const env = {
        CLAUDE_CONFIG_DIR: configuredProfile ? hostHome : undefined,
        PSTACK_FIXTURE_AUTH_HOME: hostHome,
        PSTACK_FIXTURE_CODEX: JSON.stringify({
          cli: { available: false },
          auth: { verified: false, loggedIn: null, method: null },
        }),
      };
      const result = f.invoke(
        'detect.mjs',
        ['detect', '--claude-home', targetHome, '--claude-executable', fake],
        env,
      );
      assert.equal(result.status, 0, result.stderr);
      const detection = JSON.parse(result.stdout);
      assert.equal(detection.claude.auth.loggedIn, loggedIn);
      assert.equal(detection.claude.auth.verified, true);
      assert.equal(
        detection.claude.auth.method,
        loggedIn ? 'oauth_token' : 'none',
      );
      assert.equal(detection.claude.cli.version, '2.1.292');
      assert.equal(detection.claude.cli.agentDefinitions, true);
      assert.deepEqual(detection.claude.cli.environment, {
        source: 'inherited',
        claudeConfigDir: configuredProfile ? hostHome : null,
      });
      assert.equal(detection.configuration.claudeHome, targetHome);
      assert.equal(
        detection.guidance.some(
          (entry: { command?: string }) =>
            entry.command === 'claude auth login',
        ),
        !loggedIn,
      );
      assert.ok(!result.stdout.includes('private-fixture-credential'));
      const preferences = f.invoke(
        'models.mjs',
        ['read', '--claude-home', targetHome],
        env,
      );
      assert.equal(preferences.status, 0, preferences.stderr);
      assert.equal(
        JSON.parse(preferences.stdout).file,
        path.join(targetHome, 'pstack-cc/models.json'),
      );
      assert.equal(await readFile(credentialFile, 'utf8'), credentials);
      assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(hostHome), ['.credentials.json']);
      await assert.rejects(stat(targetHome), { code: 'ENOENT' });
    });
  }
}

test('detect retains subscription versus API status and delegates complete model collection without native entitlement claims', async (t) => {
  const f = await fixture(t);
  const fake = path.join(f.root, 'authenticated claude');
  await writeFile(
    fake,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('2.1.292');else if(process.argv.includes('--help'))console.log('--agents');else console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token'}));\n`,
  );
  await chmod(fake, 0o755);
  await mkdir(f.home, { recursive: true });
  const settingsBytes =
    '{"model":"claude-custom","availableModels":["sonnet"],"env":{"ANTHROPIC_API_KEY":"settings-secret"}}\n';
  await writeFile(path.join(f.home, 'settings.json'), settingsBytes);
  for (const method of ['chatgpt', 'apiKey']) {
    const receipt = {
      cli: { available: true, version: '1.2.3', appServer: true },
      auth: { verified: true, loggedIn: true, method },
      models: [{ model: 'page-one' }, { model: 'page-two' }],
      pages: [{ nextCursor: 'second' }, { nextCursor: null }],
    };
    const result = f.invoke(
      'detect.mjs',
      ['catalog', '--claude-executable', fake, '--cwd', f.root],
      { PSTACK_FIXTURE_CODEX: JSON.stringify(receipt) },
    );
    assert.equal(result.status, 0, result.stderr);
    const detection = JSON.parse(result.stdout);
    assert.equal(detection.codex.auth.method, method);
    assert.equal(detection.codex.models.length, 2);
    assert.equal(detection.claude.modelCatalog.confirmationRequired, true);
    assert.ok(!result.stdout.includes('settings-secret'));
  }
  assert.equal(
    await readFile(path.join(f.home, 'settings.json'), 'utf8'),
    settingsBytes,
  );
});

test('logged-out Codex detection guides normal and device login while Claude-only preferences remain writable', async (t) => {
  const f = await fixture(t);
  const result = f.invoke(
    'detect.mjs',
    ['detect', '--claude-executable', path.join(f.root, 'missing-claude')],
    {
      PSTACK_FIXTURE_CODEX: JSON.stringify({
        cli: { available: true },
        auth: { verified: true, loggedIn: false, method: null },
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const detection = JSON.parse(result.stdout);
  assert.ok(
    detection.guidance.some(
      (entry: { command: string; headlessCommand?: string }) =>
        entry.command === 'codex login' &&
        entry.headlessCommand === 'codex login --device-auth',
    ),
  );
  const config = f.config();
  for (const role of lists) config.roles[role] = ['auto', 'inherit-parent'];
  await f.save(config);
});

test('confirmed native catalog combines with collected Codex pages and parent-only setup needs no executor catalog', async (t) => {
  const f = await fixture(t);
  const native = path.join(f.root, 'native confirmed.json');
  await writeFile(
    native,
    JSON.stringify({
      source: {
        kind: 'host',
        description: 'Fixture host exposes this exact model and efforts.',
      },
      models: [{ model: f.model, supportedReasoningEfforts: ['high'] }],
    }),
  );
  await writeFile(
    f.catalog,
    JSON.stringify({
      codex: {
        models: [
          {
            model: 'codex-page-result',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
          },
        ],
        pages: [{ nextCursor: 'page-two' }, { nextCursor: null }],
      },
    }),
  );
  const catalog = f.models(
    'catalog',
    '--input',
    f.catalog,
    '--native-catalog',
    native,
  );
  assert.deepEqual(
    catalog.models.map((entry) => [entry.executor, entry.model]),
    [
      ['codex', 'codex-page-result'],
      ['claude-code', f.model],
    ],
  );
  const config = f.config();
  for (const role of roleNames)
    config.roles[role] = lists.has(role) ? ['auto', 'inherit-parent'] : 'auto';
  await writeFile(f.catalog, JSON.stringify({ models: [] }));
  await f.save(config);
  assert.equal(f.run<Agents>('register-agents.mjs').agents.length, 0);
});

test('an existing unowned exact-model destination is preserved on registration conflict', async (t) => {
  const f = await fixture(t);
  await f.save(f.config());
  const resolution = f.models(
    'resolve',
    '--role',
    'bug-fix',
    '--kind',
    'poteto-agent',
  );
  const file = path.join(
    f.home,
    'agents/pstack-cc',
    `${resolution.entries[0]!.agentType}.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'preexisting unowned bytes\n');
  assert.notEqual(f.invoke('register-agents.mjs', []).status, 0);
  assert.equal(await readFile(file, 'utf8'), 'preexisting unowned bytes\n');
  await assert.rejects(
    stat(path.join(f.home, 'pstack-cc/agent-registration.json')),
    { code: 'ENOENT' },
  );
});

test('budget preview marks a supported effort above the target as needing a choice', async (t) => {
  const f = await fixture(t);
  const config = f.config();
  for (const role of roleNames)
    config.roles[role] = lists.has(role) ? ['auto'] : 'auto';
  config.roles['bug-fix'] = {
    executor: 'codex',
    model: 'above-target',
    reasoningEffort: 'ultra',
  };
  await writeFile(
    f.catalog,
    JSON.stringify({
      models: [
        {
          executor: 'codex',
          model: 'above-target',
          supportedReasoningEfforts: ['ultra'],
        },
      ],
    }),
  );
  await f.save(config);
  const result = f.models(
    'budget',
    '--budget',
    'small',
    '--catalog',
    f.catalog,
  );
  assert.ok(result.needsChoice.some((entry) => entry.role === 'bug-fix'));
  await writeFile(f.input, JSON.stringify(result));
  assert.notEqual(
    f.invoke('models.mjs', [
      'write',
      '--input',
      f.input,
      '--catalog',
      f.catalog,
      '--expected-hash',
      f.models('read').sha256!,
    ]).status,
    0,
  );
});
