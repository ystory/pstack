import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const host of ['codex', 'claude-code']) {
  test(`${host} preserves exact Pi routes, duplicate seats, aliases and off budgets`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-pi-setup-'));
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
    const entry = {
      executor: 'pi',
      provider: 'one',
      model: 'vendor/model',
      reasoningEffort: 'off',
    };
    const catalogFile = path.join(root, 'catalog.json');
    const catalog = {
      models: ['one', 'two'].map((provider) => ({
        ...entry,
        provider,
        supportedReasoningEfforts: ['off'],
        source: { kind: 'host', description: 'Pi synthetic RPC snapshot' },
      })),
    };
    await writeFile(catalogFile, JSON.stringify(catalog));
    const normalized = call('catalog', '--pi-catalog', catalogFile);
    await writeFile(catalogFile, JSON.stringify(normalized));
    assert.deepEqual(call('catalog', '--input', catalogFile), normalized);
    const input = path.join(root, 'input.json');
    await writeFile(
      input,
      JSON.stringify({
        roles: {
          'feature, refactoring': host === 'codex' ? [entry] : entry,
          'arena runners': [entry, entry, { ...entry, provider: 'two' }],
          'bug-fix':
            host === 'codex' ? [{ model: 'inherit-parent' }] : 'inherit-parent',
        },
      }),
    );
    call(
      'write',
      homeFlag,
      root,
      '--input',
      input,
      '--catalog',
      catalogFile,
      '--expected-hash',
      'absent',
    );
    const resolved = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'arena runners',
      ...(host === 'claude-code' ? ['--kind', 'poteto-agent'] : []),
    );
    assert.deepEqual(resolved.entries, [
      entry,
      entry,
      { ...entry, provider: 'two' },
    ]);
    assert.equal(
      resolved.entries.some((value: { agentType?: string }) => value.agentType),
      false,
    );
    const budget = call(
      'budget',
      homeFlag,
      root,
      '--budget',
      'small',
      '--catalog',
      catalogFile,
    );
    assert.deepEqual(budget.needsChoice, []);
    const scalar = budget.config.roles['feature, refactoring'];
    assert.equal(
      (host === 'codex' ? scalar[0] : scalar).reasoningEffort,
      'off',
    );
    const absent = call(
      'resolve',
      homeFlag,
      root,
      '--role',
      'interrogate reviewers',
    );
    assert.equal(absent.entries.length, 2);
    assert.ok(
      absent.entries.every(
        (value: { model: string }) => value.model === 'inherit-parent',
      ),
    );
    const file = path.join(
      root,
      host === 'codex' ? 'pstack-codex' : 'pstack-cc',
      'models.json',
    );
    const bytes = await readFile(file);
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
    assert.deepEqual(await readFile(file), bytes);
    await writeFile(
      input,
      JSON.stringify({
        roles: {
          'feature, refactoring':
            host === 'codex'
              ? [
                  {
                    executor: 'codex',
                    provider: 'one',
                    model: 'gpt-test',
                    reasoningEffort: 'high',
                  },
                ]
              : {
                  executor: 'codex',
                  provider: 'one',
                  model: 'gpt-test',
                  reasoningEffort: 'high',
                },
        },
      }),
    );
    const rejected = spawnSync(
      process.execPath,
      [
        helper,
        'write',
        homeFlag,
        root,
        '--input',
        input,
        '--catalog',
        catalogFile,
        '--expected-hash',
        budget.sha256,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(await readFile(file), bytes);
  });
}
