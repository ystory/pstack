import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));
const pluginDirectory = resolve(scriptsDirectory, '../../..');

function currentInstallKey(): string {
  return createHash('sha256')
    .update(readFileSync(join(scriptsDirectory, 'package.json')))
    .update('\0')
    .update(readFileSync(join(scriptsDirectory, 'bun.lock')))
    .digest('hex');
}

export function assertBunSupported(): void {
  if (typeof Bun === 'undefined' || typeof Bun.spawnSync !== 'function') {
    throw new Error('poteto-mode tools require Bun 1.2 or newer; run with bun');
  }
  const [major, minor] = Bun.version.split('.').map(Number);
  if (major < 1 || (major === 1 && minor < 2)) {
    throw new Error(
      `poteto-mode tools require Bun 1.2 or newer; found ${Bun.version}`,
    );
  }
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}

export function dependencyCacheDirectory(): string {
  const explicit = process.env.POTETO_MODE_CACHE_DIR;
  if (
    explicit !== undefined &&
    (!isAbsolute(explicit) || explicit.length === 0)
  ) {
    throw new Error(
      'POTETO_MODE_CACHE_DIR must be an absolute writable directory',
    );
  }
  const cacheRoot =
    explicit ??
    join(
      process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
      'pstack-codex',
      'poteto-mode',
    );
  const path = canonicalPath(resolve(cacheRoot, currentInstallKey()));
  const withinPlugin = relative(canonicalPath(pluginDirectory), path);
  const outsidePlugin =
    withinPlugin === '..' ||
    withinPlugin.startsWith(`..${sep}`) ||
    isAbsolute(withinPlugin);
  if (!outsidePlugin) {
    throw new Error(
      'poteto-mode dependency cache must be outside the plugin bundle',
    );
  }
  return path;
}

export function ensureDependenciesInstalled(): string {
  assertBunSupported();
  const installKey = currentInstallKey();
  const cacheDirectory = dependencyCacheDirectory();
  const nodeModulesDirectory = join(cacheDirectory, 'node_modules');
  const commanderDirectory = join(nodeModulesDirectory, 'commander');
  const commanderPackagePath = join(commanderDirectory, 'package.json');
  const commanderModulePath = join(commanderDirectory, 'esm.mjs');
  const installKeyPath = join(
    nodeModulesDirectory,
    '.poteto-mode-tools-install-key',
  );
  if (
    existsSync(commanderPackagePath) &&
    existsSync(commanderModulePath) &&
    existsSync(installKeyPath) &&
    readFileSync(installKeyPath, 'utf8').trim() === installKey
  ) {
    return commanderModulePath;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  for (const file of ['package.json', 'bun.lock']) {
    writeFileSync(
      join(cacheDirectory, file),
      readFileSync(join(scriptsDirectory, file)),
      { mode: 0o600 },
    );
  }
  const result = Bun.spawnSync(
    [
      process.execPath,
      'install',
      '--frozen-lockfile',
      '--production',
      '--ignore-scripts',
    ],
    {
      cwd: cacheDirectory,
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR:
          process.env.BUN_INSTALL_CACHE_DIR ||
          join(cacheDirectory, '.bun-cache'),
      },
    },
  );
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `poteto-mode dependency install in ${cacheDirectory} exited with status ${result.exitCode}`,
    );
  }
  if (!existsSync(commanderPackagePath) || !existsSync(commanderModulePath)) {
    throw new Error(
      'bun install --frozen-lockfile completed without installing commander',
    );
  }

  writeFileSync(installKeyPath, `${installKey}\n`);
  return commanderModulePath;
}

export async function loadCommander(): Promise<typeof import('commander')> {
  const modulePath = ensureDependenciesInstalled();
  return import(pathToFileURL(modulePath).href);
}
