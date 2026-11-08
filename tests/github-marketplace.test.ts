import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localMarketplace } from '../src/distribution/artifact.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('GitHub marketplace resolves the committed plugin with the artifact marketplace identity', async () => {
  const marketplace = JSON.parse(
    await readFile(
      path.join(projectRoot, '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ),
  );
  assert.equal(marketplace.name, localMarketplace.name);
  assert.deepEqual(
    marketplace.plugins.map(
      ({ name, source }: { name: string; source: object }) => ({
        name,
        source,
      }),
    ),
    localMarketplace.plugins,
  );
  for (const entry of marketplace.plugins) {
    const manifest = JSON.parse(
      await readFile(
        path.join(projectRoot, entry.source.path, 'plugin.json'),
        'utf8',
      ),
    );
    assert.equal(manifest.name, entry.name);
  }
});

test('native Codex manifest preserves packaged metadata without a cache-bound hook', async () => {
  const pluginRoot = path.join(projectRoot, 'plugin');
  const [metadata, nativeManifest] = await Promise.all(
    ['plugin.json', '.codex-plugin/plugin.json'].map(async (manifestPath) =>
      JSON.parse(await readFile(path.join(pluginRoot, manifestPath), 'utf8')),
    ),
  );
  assert.equal(
    metadata.$schema,
    undefined,
    'keep the selected native manifest and portable metadata arrangement',
  );
  const { extensions, ...identity } = metadata;
  const { interface: pluginInterface, ...openaiExtension } =
    extensions['com.openai'];
  assert.deepEqual(nativeManifest, {
    ...identity,
    skills: './skills',
    extensions: { ...extensions, 'com.openai': openaiExtension },
    interface: pluginInterface,
  });
  await assert.rejects(stat(path.join(pluginRoot, 'hooks/hooks.json')), {
    code: 'ENOENT',
  });
});

test('neither host auto-declares the Codex allow-output guard as a Claude permission hook', async () => {
  for (const target of ['plugin', 'plugin-claude']) {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          projectRoot,
          target,
          target === 'plugin' ? 'plugin.json' : '.claude-plugin/plugin.json',
        ),
        'utf8',
      ),
    );
    assert.equal(manifest.hooks, undefined);
    await assert.rejects(
      stat(path.join(projectRoot, target, 'hooks/hooks.json')),
      {
        code: 'ENOENT',
      },
    );
  }
});
