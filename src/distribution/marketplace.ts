import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { localMarketplace } from './artifact.ts';
import { claudeMarketplace } from './claude-artifact.ts';
import { artifactTarget, verifyDistributionArtifact } from './products.ts';
import { distributionTarget } from './targets.ts';
import { assertPhysicalDirectory } from './tree.ts';
import type { DistributionArtifact } from './products.ts';

export interface MarketplaceSelection {
  artifact: DistributionArtifact;
  artifactRoot: string;
  marketplaceRoot: string;
}

export async function promotePluginArtifact(
  artifactRoot: string,
  marketplaceRoot: string,
): Promise<MarketplaceSelection> {
  if (!path.isAbsolute(artifactRoot) || !path.isAbsolute(marketplaceRoot))
    throw new Error('Artifact and marketplace must be absolute paths.');
  for (const directory of [artifactRoot, marketplaceRoot]) {
    await assertPhysicalDirectory(directory);
    const stat = await lstat(path.resolve(directory));
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `Artifact and marketplace must be physical directories, not symlinks: ${directory}`,
      );
  }
  const sourceRoot = await realpath(artifactRoot);
  const targetRoot = await realpath(marketplaceRoot);
  try {
    await lstat(path.join(targetRoot, 'artifact.json'));
    throw new Error(
      'An artifact directory cannot be used as a marketplace root.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const relative = path.relative(targetRoot, sourceRoot);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  )
    throw new Error(
      'Artifact must be an immutable child of the marketplace root.',
    );
  if (['.agents', '.claude-plugin'].includes(relative.split(path.sep)[0]!))
    throw new Error(
      'The marketplace native metadata directory is reserved and cannot contain artifacts.',
    );
  const artifact = await verifyDistributionArtifact(sourceRoot);
  const target = distributionTarget(artifactTarget(artifact));
  const pluginPath = `./${relative.split(path.sep).join('/')}/plugin`;
  const manifest =
    target.id === 'codex'
      ? {
          ...localMarketplace,
          plugins: [
            {
              name: artifact.name,
              source: { source: 'local', path: pluginPath },
            },
          ],
        }
      : {
          ...claudeMarketplace,
          plugins: [{ name: artifact.name, source: pluginPath }],
        };
  let directory = targetRoot;
  for (const component of target.marketplaceDirectory.split('/')) {
    directory = path.join(directory, component);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `Marketplace metadata must use physical directories, not symlinks: ${directory}`,
      );
  }
  const temporary = await mkdtemp(path.join(directory, '.promote-'));
  try {
    const next = path.join(temporary, 'marketplace.json');
    await writeFile(next, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    await rename(next, path.join(directory, 'marketplace.json'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { artifact, artifactRoot: sourceRoot, marketplaceRoot: targetRoot };
}
