#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentNames = ['poteto-agent', 'comment-sicko'];
const genericRole = 'pstack-general-purpose';
const genericDescription =
  'General-purpose delegate for pstack workflows; follow the supplied task and model settings.';
const roleNames = [...agentNames, genericRole];
const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const parser = fileURLToPath(
  new URL('./parse-agent-config.py', import.meta.url),
);
const markerName = 'pstack-codex managed agents';
const blockStart = `# >>> ${markerName} v2\n`;
// Native writes preserve a value suffix but displace standalone EOF comments.
const blockClose = ` # <<< ${markerName} v2\n`;
const legacyStart = `# >>> ${markerName} v1\n`;
const legacyEnd = `# <<< ${markerName} v1\n`;
const anyMarker = /# (?:>>>|<<<) pstack-codex managed agents v\d+/;
const blockFormat = (block) =>
  block.startsWith(blockStart) && block.endsWith(blockClose)
    ? 'v2'
    : block.startsWith(legacyStart) && block.endsWith(legacyEnd)
      ? 'v1'
      : undefined;

function argumentsFor(argv) {
  const options = {
    dryRun: false,
    definitionsOnly: false,
    help: false,
    unregister: false,
    codexHome: undefined,
    python: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--definitions-only') options.definitionsOnly = true;
    else if (argument === '--unregister') options.unregister = true;
    else if (argument === '--codex-home' || argument === '--python') {
      const key = argument === '--python' ? 'python' : 'codexHome';
      const value = argv[++index];
      if (
        !value ||
        value.startsWith('--') ||
        options[key] !== undefined ||
        !path.isAbsolute(value)
      )
        throw new Error(`${argument} requires one absolute path.`);
      options[key] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes) =>
  new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);

async function inspect(file, kind) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${file}`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
    throw new Error(`Expected ${kind}: ${file}`);
  return stat;
}

async function fileSnapshot(file) {
  const stat = await inspect(file, 'file');
  if (!stat) return undefined;
  const bytes = await fs.readFile(file);
  return { bytes, sha256: sha256(bytes), mode: stat.mode & 0o777 };
}

function parseToml(python, mode, request) {
  const result = spawnSync(python ?? 'python3', [parser, mode], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `Agent registration requires a working Python 3.11+ TOML parser. ${result.stderr?.trim() || result.error?.message || 'Parser failed.'}`,
    );
  return JSON.parse(result.stdout);
}

function renderBlock(roles, format = 'v2') {
  const tables = roleNames
    .filter((name) => Object.hasOwn(roles, name))
    .map((name) => {
      const role = roles[name];
      const configFile =
        name === genericRole
          ? ''
          : `config_file = ${JSON.stringify(role.config_file)}\n`;
      return `[agents.${name}]\n${configFile}description = ${JSON.stringify(role.description)}\n`;
    })
    .join('\n');
  return format === 'v1'
    ? legacyStart + tables + legacyEnd
    : blockStart + tables.slice(0, -1) + blockClose;
}

function ownedSpan(text, block) {
  const legacy = blockFormat(block) === 'v1';
  const body = legacy ? block.slice(0, -legacyEnd.length) : block;
  const index = text.indexOf(body);
  if (index < 0) return undefined;
  const before = text.slice(0, index);
  const rest = text.slice(index + body.length);
  if (!legacy) return { before, after: rest };
  const end = rest.indexOf(legacyEnd);
  if (end < 0 || (end > 0 && rest[end - 1] !== '\n')) return undefined;
  const displacedForeignBytes = rest.slice(0, end);
  const afterClosingMarker = rest.slice(end + legacyEnd.length);
  return {
    before,
    after: displacedForeignBytes + afterClosingMarker,
  };
}

function parseRegistry(bytes, pluginName) {
  let registry;
  try {
    registry = JSON.parse(utf8(bytes));
  } catch {
    throw new Error('Agent registration record is not valid JSON.');
  }
  if (
    ![1, 2].includes(registry?.schemaVersion) ||
    registry.pluginName !== pluginName ||
    typeof registry.pluginVersion !== 'string' ||
    !registry.pluginVersion ||
    !registry.agents ||
    typeof registry.agents !== 'object' ||
    Array.isArray(registry.agents) ||
    Object.keys(registry.agents).length !== agentNames.length ||
    agentNames.some(
      (name) =>
        !/^[a-f0-9]{64}$/.test(registry.agents[name]?.sha256 ?? '') ||
        (registry.agents[name].mode !== undefined &&
          (!Number.isInteger(registry.agents[name].mode) ||
            registry.agents[name].mode < 0 ||
            registry.agents[name].mode > 0o777)),
    )
  ) {
    throw new Error(
      'Agent registration record is invalid or belongs to another plugin.',
    );
  }
  if (
    registry.schemaVersion === 2 &&
    (!registry.config ||
      typeof registry.config.block !== 'string' ||
      !blockFormat(registry.config.block) ||
      !['', '\n'].includes(registry.config.prefix) ||
      typeof registry.config.created !== 'boolean')
  )
    throw new Error('Agent registration config ownership record is invalid.');
  return registry;
}

async function assertUnchanged(file, snapshot) {
  const current = await fileSnapshot(file);
  if (
    Boolean(current) !== Boolean(snapshot) ||
    (current &&
      (current.sha256 !== snapshot.sha256 || current.mode !== snapshot.mode))
  )
    throw new Error(`File changed during registration: ${file}`);
}

function withoutOwnedConfig(text, ownership, python) {
  const declared = parseToml(python, 'inspect', { text });
  if (!ownership) {
    if (Object.keys(declared.roles).length)
      throw new Error(
        'Existing pstack agent declarations are not managed by this plugin; preserve or relocate those roles before registering.',
      );
    if (anyMarker.test(text))
      throw new Error(
        'Unowned pstack registration markers already exist in config.toml.',
      );
    return text;
  }
  const blockRoles = parseToml(python, 'inspect', {
    text: ownership.block,
  }).roles;
  const ownedNames = roleNames.filter((name) =>
    Object.hasOwn(blockRoles, name),
  );
  if (
    agentNames.some((name) => {
      const expected = blockRoles[name];
      const actual = declared.roles[name];
      return (
        !expected ||
        typeof expected.config_file !== 'string' ||
        typeof expected.description !== 'string' ||
        Object.keys(expected).length !== 2 ||
        !actual ||
        Object.keys(actual).length !== 2 ||
        actual.config_file !== expected.config_file ||
        actual.description !== expected.description
      );
    }) ||
    (blockRoles[genericRole] &&
      (typeof blockRoles[genericRole].description !== 'string' ||
        Object.keys(blockRoles[genericRole]).length !== 1 ||
        !declared.roles[genericRole] ||
        Object.keys(declared.roles[genericRole]).length !== 1 ||
        declared.roles[genericRole].description !==
          blockRoles[genericRole].description)) ||
    renderBlock(blockRoles, blockFormat(ownership.block)) !== ownership.block
  )
    throw new Error(
      'Managed agent declarations were modified; refusing to overwrite or remove them.',
    );
  const span = ownedSpan(text, ownership.block);
  if (!span || anyMarker.test(span.before + span.after))
    throw new Error(
      'Managed config block was modified or duplicated; refusing to overwrite or remove it.',
    );
  let before = span.before;
  const after = span.after;
  const addedSeparator = ownership.prefix;
  if (addedSeparator && before.endsWith(addedSeparator) && !after)
    before = before.slice(0, -addedSeparator.length);
  const base = before + after;
  parseToml(python, 'compare-remove', {
    text,
    afterText: base,
    names: ownedNames,
  });
  return base;
}

async function applyTransaction(plans, directories) {
  const changed = plans.filter(({ previous, next }) =>
    next
      ? !previous ||
        !next.bytes.equals(previous.bytes) ||
        next.mode !== previous.mode
      : Boolean(previous),
  );
  if (!changed.length) return;
  const temporaryFiles = new Set();
  const createdDirectories = [];
  const committed = [];
  async function ensureDirectory(directory) {
    const firstCreated = await fs.mkdir(directory, { recursive: true });
    if (!firstCreated) return;
    let current = firstCreated;
    createdDirectories.push(current);
    for (const part of path
      .relative(firstCreated, directory)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      createdDirectories.push(current);
    }
  }
  async function stage(file, bytes, mode) {
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    temporaryFiles.add(temporary);
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
    await fs.chmod(temporary, mode);
    return temporary;
  }
  try {
    for (const directory of directories) await ensureDirectory(directory);
    for (const directory of directories) await inspect(directory, 'directory');
    for (const plan of plans) await assertUnchanged(plan.file, plan.previous);
    for (const plan of changed) {
      if (plan.next)
        plan.staged = await stage(plan.file, plan.next.bytes, plan.next.mode);
      if (plan.previous)
        plan.backup = await stage(
          plan.file,
          plan.previous.bytes,
          plan.previous.mode,
        );
    }
    for (const plan of changed) {
      await assertUnchanged(plan.file, plan.previous);
      if (plan.next) {
        await fs.rename(plan.staged, plan.file);
        temporaryFiles.delete(plan.staged);
      } else await fs.unlink(plan.file);
      committed.push(plan);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of committed.reverse()) {
      try {
        const current = await fileSnapshot(plan.file);
        if (
          plan.next
            ? !current ||
              current.sha256 !== sha256(plan.next.bytes) ||
              current.mode !== plan.next.mode
            : Boolean(current)
        )
          throw new Error(
            `Cannot restore file changed during registration: ${plan.file}`,
          );
        if (plan.backup) {
          await fs.rename(plan.backup, plan.file);
          temporaryFiles.delete(plan.backup);
        } else await fs.unlink(plan.file);
      } catch (rollbackError) {
        if (plan.backup) temporaryFiles.delete(plan.backup);
        rollbackErrors.push(
          plan.backup
            ? `${rollbackError.message} Previous contents remain at ${plan.backup}`
            : rollbackError.message,
        );
      }
    }
    if (rollbackErrors.length)
      error.message += ` Restore failed: ${rollbackErrors.join('; ')}`;
    throw error;
  } finally {
    for (const temporary of temporaryFiles)
      await fs.unlink(temporary).catch(() => {});
    for (const directory of createdDirectories.reverse())
      await fs.rmdir(directory).catch(() => {});
  }
}

async function register(options) {
  const selectedHome =
    options.codexHome ??
    process.env.CODEX_HOME ??
    path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(selectedHome))
    throw new Error('Codex home must be an absolute path.');
  const codexHome = path.resolve(selectedHome);
  const agentsDirectory = path.join(codexHome, 'agents');
  const stateDirectory = path.join(codexHome, 'pstack-codex');
  const registryFile = path.join(stateDirectory, 'agent-registration.json');
  const configFile = path.join(codexHome, 'config.toml');
  for (const directory of [codexHome, agentsDirectory, stateDirectory])
    await inspect(directory, 'directory');
  const manifest = await fileSnapshot(path.join(pluginRoot, 'plugin.json'));
  if (!manifest) throw new Error('Bundled plugin.json is missing.');
  const plugin = JSON.parse(utf8(manifest.bytes));
  if (
    typeof plugin.name !== 'string' ||
    !plugin.name ||
    typeof plugin.version !== 'string' ||
    !plugin.version
  )
    throw new Error('Bundled plugin.json must declare a name and version.');
  const registrySnapshot = await fileSnapshot(registryFile);
  const registry = registrySnapshot
    ? parseRegistry(registrySnapshot.bytes, plugin.name)
    : undefined;
  let configSnapshot = await fileSnapshot(configFile);
  let configText = configSnapshot ? utf8(configSnapshot.bytes) : '';
  const parsedConfig = parseToml(options.python, 'inspect', {
    text: configText,
  });
  const ownership = registry?.schemaVersion === 2 ? registry.config : undefined;
  let baseConfig =
    options.unregister && !ownership
      ? configText
      : withoutOwnedConfig(configText, ownership, options.python);
  const ownedGeneric =
    ownership?.block.includes(`[agents.${genericRole}]\n`) ?? false;
  const priorGeneric = parsedConfig.roles[genericRole];
  if (!options.unregister && priorGeneric && !ownedGeneric)
    throw new Error(
      `Existing role ${genericRole} is not managed by this plugin; refusing to overwrite it.`,
    );
  const plans = [];
  const roles = {};
  for (const name of agentNames) {
    const file = path.join(agentsDirectory, `${name}.toml`);
    const previous = await fileSnapshot(file);
    if (
      previous &&
      registry &&
      (previous.sha256 !== registry.agents[name].sha256 ||
        (registry.agents[name].mode !== undefined &&
          previous.mode !== registry.agents[name].mode))
    )
      throw new Error(
        `Registered agent was modified; refusing to ${options.unregister ? 'remove' : 'overwrite'}: ${file}`,
      );
    if (options.unregister) {
      plans.push({
        name,
        file,
        previous,
        next: registry ? undefined : previous,
        status: previous ? (registry ? 'removed' : 'not-managed') : 'absent',
      });
      continue;
    }
    const sourceFile = path.join(pluginRoot, 'agents', `${name}.toml`);
    const source = await fileSnapshot(sourceFile);
    if (!source || !source.bytes.length)
      throw new Error(`Bundled agent is missing or empty: ${sourceFile}`);
    const metadata = parseToml(options.python, 'agent', {
      text: utf8(source.bytes),
    });
    if (metadata.name !== name)
      throw new Error(`Bundled agent does not declare ${name}: ${sourceFile}`);
    if (previous && !registry)
      throw new Error(`Existing agent is not managed by this plugin: ${file}`);
    const status = !previous
      ? 'installed'
      : previous.sha256 === source.sha256
        ? 'unchanged'
        : 'updated';
    const next = {
      bytes: source.bytes,
      mode: status === 'unchanged' ? previous.mode : source.mode,
    };
    plans.push({ name, file, previous, next, status });
    roles[name] = { config_file: file, description: metadata.description };
  }
  let commandBoundary;
  if (options.definitionsOnly || options.dryRun) {
    commandBoundary = {
      status: 'notChecked',
      reason: options.definitionsOnly
        ? 'Definition-only fixture operation.'
        : 'No active runtime change was requested.',
    };
  } else if (process.platform === 'darwin') {
    const { trustNativeBoundary, retireNativeBoundary } =
      await import('../../poteto-mode/scripts/codex-boundary.mjs');
    const reconcile = options.unregister
      ? retireNativeBoundary
      : trustNativeBoundary;
    commandBoundary = await reconcile({
      cwd: process.cwd(),
      codexHome,
      nativeRoles: roleNames,
      guardPath: path.join(
        pluginRoot,
        'skills/poteto-mode/scripts/shell-boundary.mjs',
      ),
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const expectedStatus = options.unregister ? 'retired' : 'active';
    if (commandBoundary.status !== expectedStatus)
      throw new Error(
        `Native command boundary did not become ${expectedStatus}: ${commandBoundary.status}. ${commandBoundary.reason ?? ''}`.trim(),
      );
    configSnapshot = await fileSnapshot(configFile);
    configText = configSnapshot ? utf8(configSnapshot.bytes) : '';
    baseConfig =
      options.unregister && !ownership
        ? configText
        : withoutOwnedConfig(configText, ownership, options.python);
  } else {
    commandBoundary = { status: 'notApplicable', reason: 'macOS only.' };
  }
  let configNext;
  let configOwnership;
  if (options.unregister) {
    configNext = ownership
      ? ownership.created && !baseConfig
        ? undefined
        : { bytes: Buffer.from(baseConfig), mode: configSnapshot.mode }
      : configSnapshot;
  } else {
    roles[genericRole] = { description: genericDescription };
    const block = renderBlock(roles);
    const prefix = baseConfig && !baseConfig.endsWith('\n') ? '\n' : '';
    const text = baseConfig + prefix + block;
    try {
      parseToml(options.python, 'inspect', { text });
    } catch (error) {
      throw new Error(
        `Cannot add explicit native agent declarations to this config.toml. Preserve existing settings and convert an inline agents table to normal tables before registering. ${error.message}`,
      );
    }
    configNext = {
      bytes: Buffer.from(text),
      mode: configSnapshot?.mode ?? 0o600,
    };
    configOwnership = {
      block,
      prefix,
      created: ownership?.created ?? !configSnapshot,
    };
  }
  const configStatus = !configNext
    ? configSnapshot
      ? 'removed'
      : 'absent'
    : !configSnapshot
      ? 'configured'
      : configNext.bytes.equals(configSnapshot.bytes)
        ? 'unchanged'
        : 'updated';
  plans.push({ file: configFile, previous: configSnapshot, next: configNext });
  const registryNext = options.unregister
    ? undefined
    : {
        bytes: Buffer.from(
          `${JSON.stringify({ schemaVersion: 2, pluginName: plugin.name, pluginVersion: plugin.version, agents: Object.fromEntries(plans.filter(({ name }) => name).map(({ name, next }) => [name, { sha256: sha256(next.bytes), mode: next.mode }])), config: configOwnership }, null, 2)}\n`,
        ),
        mode: registrySnapshot?.mode ?? 0o600,
      };
  plans.push({
    file: registryFile,
    previous: registrySnapshot,
    next: registryNext,
  });
  const result = {
    codexHome,
    pluginVersion: plugin.version,
    dryRun: options.dryRun,
    operation: options.unregister ? 'unregister' : 'register',
    agents: plans
      .filter(({ name }) => name)
      .map(({ name, file, status }) => ({ name, file, status })),
    config: { file: configFile, status: configStatus },
    metadataRoles: [
      {
        name: genericRole,
        status: options.unregister
          ? ownedGeneric
            ? 'removed'
            : priorGeneric
              ? 'not-managed'
              : 'absent'
          : !priorGeneric
            ? 'configured'
            : priorGeneric.description === genericDescription
              ? 'unchanged'
              : 'updated',
      },
    ],
  };
  result.commandBoundary = commandBoundary;
  if (!options.dryRun && !(options.unregister && !registry))
    await applyTransaction(plans, [codexHome, agentsDirectory, stateDirectory]);
  return result;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help)
    process.stdout.write(
      'Usage: node register-agents.mjs [--codex-home ABSOLUTE_PATH] [--python ABSOLUTE_PATH] [--dry-run] [--unregister] [--definitions-only]\nRequires Node.js and Python 3.11+ (standard-library tomllib).\nRegisters the two bundled agent files and explicit native config.toml declarations, plus the description-only pstack-general-purpose role.\n--unregister removes only unchanged owned registrations, preserving unrelated configuration and model settings.\n--definitions-only limits isolated fixture checks to owned agent definitions without activating a runtime boundary.\n',
    );
  else
    process.stdout.write(
      `${JSON.stringify(await register(options), null, 2)}\n`,
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
