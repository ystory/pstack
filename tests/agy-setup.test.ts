import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const agyEntry = {
  executor: 'antigravity',
  model: 'gemini-fixture',
  reasoningEffort: 'xhigh',
};
const fixedEntry = { ...agyEntry, model: 'gemini-fixture-xhigh' };
const source = {
  kind: 'host',
  description: 'Synthetic agy catalog. Only the labeled variant is available.',
};
const capabilities = {
  models: [
    {
      executor: 'antigravity',
      model: agyEntry.model,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: {
        kind: 'manual-confirmation',
        description:
          'Synthetic per-model confirmation of the exact ID and efforts.',
      },
      runtimeVersion: '1.5.9',
      privateMetadata: 'discard this value',
    },
    {
      executor: 'antigravity',
      model: fixedEntry.model,
      supportedReasoningEfforts: ['xhigh'],
      source,
      runtimeVersion: '1.5.9',
    },
  ],
};

for (const host of ['codex', 'claude-code']) {
  test(`${host} saves exact agy routes and preserves native selection behavior`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-agy-setup-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugin = host === 'codex' ? 'plugin' : 'plugin-claude';
    const helper = path.resolve(
      plugin,
      'skills/setup-pstack/scripts/models.mjs',
    );
    const homeFlag = host === 'codex' ? '--codex-home' : '--claude-home';
    const call = (...args: string[]) => {
      const result = spawnSync(process.execPath, [helper, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const agyCatalog = path.join(root, 'agy-catalog.json');
    const combinedFile = path.join(root, 'combined.json');
    const input = path.join(root, 'input.json');
    await writeFile(agyCatalog, JSON.stringify(capabilities));
    const normalized = call('catalog', '--agy-catalog', agyCatalog);
    assert.deepEqual(
      normalized.models,
      capabilities.models.map(({ privateMetadata: _, ...entry }) => entry),
    );
    await writeFile(combinedFile, JSON.stringify(normalized));
    assert.deepEqual(call('catalog', '--input', combinedFile), normalized);
    const nativeEntry =
      host === 'codex'
        ? { model: 'gpt-fixture', reasoningEffort: 'high' }
        : {
            executor: 'claude-code',
            model: 'claude-fixture-20300101',
            reasoningEffort: 'high',
          };
    const nativeCatalog = path.join(root, 'native.json');
    const nativeCapability = {
      ...nativeEntry,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      ...(host === 'claude-code' ? { source } : {}),
    };
    await writeFile(
      nativeCatalog,
      JSON.stringify({ models: [nativeCapability] }),
    );
    const mixed = call(
      'catalog',
      host === 'codex' ? '--input' : '--native-catalog',
      nativeCatalog,
      '--agy-catalog',
      agyCatalog,
    );
    assert.equal(mixed.models.length, 3);
    await writeFile(combinedFile, JSON.stringify(mixed));
    assert.deepEqual(call('catalog', '--input', combinedFile), mixed);
    const roles = {
      'feature, refactoring': host === 'codex' ? [agyEntry] : agyEntry,
      'arena runners': [agyEntry, fixedEntry, agyEntry],
      'bug-fix':
        host === 'codex' ? [{ model: 'inherit-parent' }] : 'inherit-parent',
      hillclimb: host === 'codex' ? [nativeEntry] : nativeEntry,
    };
    await writeFile(input, JSON.stringify({ roles }));
    const written = call(
      'write',
      homeFlag,
      root,
      '--input',
      input,
      '--catalog',
      combinedFile,
      '--expected-hash',
      'absent',
    );
    assert.deepEqual(written.config.roles, roles);
    assert.equal(Object.keys(written.config.roles).length, 4);
    await writeFile(
      input,
      JSON.stringify({
        roles: { 'feature, refactoring': roles['feature, refactoring'] },
      }),
    );
    const partial = call(
      'write',
      homeFlag,
      root,
      '--input',
      input,
      '--catalog',
      combinedFile,
      '--expected-hash',
      written.sha256,
    );
    assert.deepEqual(partial.config.roles, roles);
    assert.equal(partial.changed, false);
    const resolved = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'arena runners',
      ...(host === 'claude-code' ? ['--kind', 'poteto-agent'] : []),
    );
    assert.deepEqual(resolved.entries, [agyEntry, fixedEntry, agyEntry]);
    const nativeResolved = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'hillclimb',
      ...(host === 'claude-code' ? ['--kind', 'read-only'] : []),
    );
    assert.equal(nativeResolved.entries[0].model, nativeEntry.model);
    if (host === 'claude-code')
      assert.match(
        nativeResolved.entries[0].agentType,
        /^pstack-cc-read-only-/,
      );
    const alias = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'bug-fix',
      ...(host === 'claude-code' ? ['--kind', 'poteto-agent'] : []),
    );
    assert.equal(alias.entries[0].model, 'inherit-parent');
    if (host === 'claude-code')
      assert.equal(alias.entries[0].agentType, 'pstack-cc:poteto-agent');
    const absent = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'interrogate reviewers',
    );
    assert.equal(absent.source, 'unconfigured');
    assert.equal(absent.entries.length, 3);
    assert.ok(
      absent.entries.every(
        (entry: { model: string }) => entry.model === 'inherit-parent',
      ),
    );
    const absentPool = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'arena cross-judge pool',
    );
    assert.equal(absentPool.source, 'unconfigured');
    assert.equal(absentPool.entries.length, 2);
    assert.ok(
      absentPool.entries.every(
        (entry: { model: string }) => entry.model === 'inherit-parent',
      ),
    );
    const preview = call(
      'budget',
      homeFlag,
      root,
      '--budget',
      'small',
      '--catalog',
      combinedFile,
    );
    const scalar = preview.config.roles['feature, refactoring'];
    assert.equal(
      (host === 'codex' ? scalar[0] : scalar).reasoningEffort,
      'medium',
    );
    assert.deepEqual(preview.config.roles['bug-fix'], roles['bug-fix']);
    assert.deepEqual(
      preview.config.roles['arena runners'].map(
        (entry: { model: string }) => entry.model,
      ),
      [agyEntry.model, fixedEntry.model, agyEntry.model],
    );
    assert.equal(
      preview.config.roles['arena runners'][1].reasoningEffort,
      'xhigh',
    );
    assert.equal(preview.needsChoice.length, 1);
    assert.equal(preview.needsChoice[0].model, fixedEntry.model);
    const file = path.join(
      root,
      host === 'codex' ? 'pstack-codex' : 'pstack-cc',
      'models.json',
    );
    const saved = await readFile(file);
    await writeFile(input, JSON.stringify(preview));
    const refused = spawnSync(
      process.execPath,
      [
        helper,
        'write',
        homeFlag,
        root,
        '--input',
        input,
        '--catalog',
        combinedFile,
        '--expected-hash',
        written.sha256,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(refused.status, 0);
    assert.deepEqual(await readFile(file), saved);
    await writeFile(
      input,
      JSON.stringify({
        roles: {
          'feature, refactoring': host === 'codex' ? [agyEntry] : agyEntry,
        },
      }),
    );
    const registrar = path.resolve(
      plugin,
      'skills/setup-pstack/scripts/register-agents.mjs',
    );
    const registered = spawnSync(
      process.execPath,
      [
        registrar,
        homeFlag,
        root,
        ...(host === 'claude-code' ? ['--input', input] : []),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(registered.status, 0, registered.stderr);
    if (host === 'claude-code')
      assert.deepEqual(JSON.parse(registered.stdout).agents, []);
    else assert.equal(registered.stdout.includes(agyEntry.model), false);
    assert.deepEqual(await readFile(file), saved);
    await Promise.all(
      [agyCatalog, combinedFile, nativeCatalog].map((file) => rm(file)),
    );
    const spyDirectory = path.join(root, 'spy-bin');
    await mkdir(spyDirectory);
    const spyLog = path.join(root, 'cli-invoked');
    for (const executable of ['agy', 'codex', 'codex-app-server', 'claude'])
      await writeFile(
        path.join(spyDirectory, executable),
        `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PSTACK_SPY_LOG, '${executable}\\n');\nprocess.exit(81);\n`,
        { mode: 0o700 },
      );
    const spyEnvironment = {
      ...process.env,
      PATH: `${spyDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      PSTACK_SPY_LOG: spyLog,
    };
    assert.equal(
      spawnSync(path.join(spyDirectory, 'agy'), [], { env: spyEnvironment })
        .status,
      81,
    );
    assert.equal(await readFile(spyLog, 'utf8'), 'agy\n');
    await rm(spyLog);
    for (const args of [['read'], ['resolve', '--role', 'arena runners']]) {
      const offline = spawnSync(
        process.execPath,
        [helper, ...args, homeFlag, root],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${spyDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
            PSTACK_SPY_LOG: spyLog,
          },
        },
      );
      assert.equal(offline.status, 0, offline.stderr);
      if (args[0] === 'resolve')
        assert.deepEqual(JSON.parse(offline.stdout).entries, [
          agyEntry,
          fixedEntry,
          agyEntry,
        ]);
    }
    await assert.rejects(readFile(spyLog), { code: 'ENOENT' });
    assert.deepEqual(await readFile(file), saved);
  });

  test(`${host} rejects invalid agy capabilities and saved routes without changing preferences`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-agy-invalid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const helper = path.resolve(
      host === 'codex' ? 'plugin' : 'plugin-claude',
      'skills/setup-pstack/scripts/models.mjs',
    );
    const homeFlag = host === 'codex' ? '--codex-home' : '--claude-home';
    const catalog = path.join(root, 'catalog.json');
    const input = path.join(root, 'input.json');
    const call = (...args: string[]) =>
      spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
    for (const entry of [
      { ...capabilities.models[0], executor: 'codex' },
      { ...capabilities.models[0], source: undefined },
      {
        ...capabilities.models[0],
        source: { kind: 'unverified', description: 'Candidate only.' },
      },
      { ...capabilities.models[0], supportedReasoningEfforts: ['off'] },
      { ...capabilities.models[0], provider: 'foreign' },
      { ...capabilities.models[0], model: 'inherit-parent' },
      { ...capabilities.models[0], model: 'bad\nmodel' },
    ]) {
      await writeFile(catalog, JSON.stringify({ models: [entry] }));
      assert.notEqual(call('catalog', '--agy-catalog', catalog).status, 0);
    }
    await writeFile(
      catalog,
      JSON.stringify({
        models: [
          ...capabilities.models,
          {
            executor: 'antigravity',
            model: 'gemini-fixture-max',
            supportedReasoningEfforts: ['max'],
            source,
            runtimeVersion: '1.5.9',
          },
        ],
      }),
    );
    const normalized = call('catalog', '--agy-catalog', catalog);
    assert.equal(normalized.status, 0, normalized.stderr);
    await writeFile(catalog, normalized.stdout);
    for (const entry of [
      { ...agyEntry, model: 'inherit-parent' },
      { ...agyEntry, model: 'auto', reasoningEffort: undefined },
      { ...agyEntry, provider: 'foreign' },
      { ...agyEntry, auth: 'adc' },
      { ...agyEntry, reasoningEffort: 'off' },
      { ...agyEntry, reasoningEffort: undefined },
      { ...agyEntry, model: 'absent-exact-model' },
      { ...agyEntry, model: 'gemini-fixture-max', reasoningEffort: 'max' },
    ]) {
      await writeFile(
        input,
        JSON.stringify({
          roles: { 'feature, refactoring': host === 'codex' ? [entry] : entry },
        }),
      );
      assert.notEqual(
        call(
          'write',
          homeFlag,
          root,
          '--input',
          input,
          '--catalog',
          catalog,
          '--expected-hash',
          'absent',
        ).status,
        0,
      );
    }
    const file = path.join(
      root,
      host === 'codex' ? 'pstack-codex' : 'pstack-cc',
      'models.json',
    );
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  });
}

test('live agy verification requires explicit paid settings and a new evidence directory before CLI invocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-agy-live-gates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'cli-invoked');
  const executable = path.join(root, 'agy');
  await writeFile(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PSTACK_SPY_LOG, 'invoked');\nprocess.exit(81);\n`,
    { mode: 0o700 },
  );
  const evidence = path.join(root, 'new-evidence');
  const values = {
    '--evidence-dir': evidence,
    '--fresh-runner': path.resolve(
      'plugin/skills/poteto-mode/scripts/run-agy.mjs',
    ),
    '--resume-runner': path.resolve(
      'plugin-claude/skills/poteto-mode/scripts/run-agy.mjs',
    ),
    '--model': 'gemini-fixture',
    '--effort': 'xhigh',
    '--inherited-auth': 'adc',
    '--executable': executable,
  };
  const call = (selected: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        path.resolve('scripts/check-agy-live.ts'),
        ...Object.entries(selected).flat(),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          AGY_ADC_AUTH: 'true',
          PSTACK_SPY_LOG: log,
        },
      },
    );
  for (const flag of ['--model', '--effort', '--inherited-auth']) {
    const selected: Record<string, string> = { ...values };
    delete selected[flag];
    assert.notEqual(call(selected).status, 0);
    await assert.rejects(stat(evidence), { code: 'ENOENT' });
  }
  for (const method of ['inherited-default', 'gemini-api-key'])
    assert.notEqual(call({ ...values, '--inherited-auth': method }).status, 0);
  assert.notEqual(
    call({ ...values, '--evidence-dir': 'relative-evidence' }).status,
    0,
  );
  assert.notEqual(call({ ...values, '--evidence-dir': root }).status, 0);
  await assert.rejects(stat(evidence), { code: 'ENOENT' });
  await assert.rejects(readFile(log), { code: 'ENOENT' });
});
