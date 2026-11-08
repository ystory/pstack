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
