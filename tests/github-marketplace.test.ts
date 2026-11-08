import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('native Codex manifest exposes hooks and preserves packaged plugin metadata', async () => {
  const pluginRoot = path.join(projectRoot, 'plugin');
  const [metadata, nativeManifest] = await Promise.all(
    ['plugin.json', '.codex-plugin/plugin.json'].map(async (manifestPath) =>
      JSON.parse(await readFile(path.join(pluginRoot, manifestPath), 'utf8')),
    ),
  );
  assert.equal(
    metadata.$schema,
    undefined,
    'a root Agent Plugins schema selects the Codex format that omits hooks',
  );
  const { extensions, ...identity } = metadata;
  const { interface: pluginInterface, ...openaiExtension } =
    extensions['com.openai'];
  assert.deepEqual(nativeManifest, {
    ...identity,
    skills: './skills',
    hooks: './hooks/hooks.json',
    extensions: { ...extensions, 'com.openai': openaiExtension },
    interface: pluginInterface,
  });
  const hooks = JSON.parse(
    await readFile(path.join(pluginRoot, nativeManifest.hooks), 'utf8'),
  );
  assert.equal(hooks.hooks.PreToolUse[0].matcher, '^Bash$');
  assert.ok(
    hooks.hooks.PreToolUse[0].hooks.some(
      ({ type, command }: { type: string; command: string }) =>
        type === 'command' && command.includes('/shell-boundary.mjs'),
    ),
  );
});
