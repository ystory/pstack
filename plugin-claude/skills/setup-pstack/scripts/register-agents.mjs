#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  argumentsFor,
  atomicWrite,
  claudeHome,
  hash,
  inputJson,
  inspect,
  jsonBytes,
  run,
  snapshot,
} from './state.mjs';
import { agentType, aliases, entriesFor, kinds } from './roles.mjs';
import { loadConfig, normalizeConfig } from './models.mjs';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const registryName = 'pstack-cc/agent-registration.json';
const agentPrefix = 'agents/pstack-cc/';
const validAgentPath = (relative) =>
  /^agents\/pstack-cc\/pstack-cc-(general-purpose|poteto-agent|comment-sicko|read-only)-[a-f0-9]{16}\.md$/.test(
    relative,
  );
const encoded = (state) =>
  state
    ? {
        bytes: state.bytes.toString('base64'),
        sha256: state.sha256 ?? hash(state.bytes),
        mode: state.mode,
      }
    : null;
const matches = (state, expected) =>
  (state?.sha256 ?? null) === (expected?.sha256 ?? null) &&
  (state?.mode ?? null) === (expected?.mode ?? null);

function recordFor(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.pluginName !== 'pstack-cc' ||
    typeof value.pluginVersion !== 'string' ||
    !value.agents ||
    typeof value.agents !== 'object' ||
    Array.isArray(value.agents)
  )
    throw new Error('Agent ownership record is invalid.');
  for (const [relative, entry] of Object.entries(value.agents))
    if (
      !validAgentPath(relative) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new Error('Agent ownership entry is invalid.');
  return value;
}

function variant(bytes, kind, model) {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || !/^description:/m.test(match[1]))
    throw new Error(`Bundled ${kind} needs frontmatter with a description.`);
  const metadata = match[1]
    .split(/\r?\n/)
    .filter((line) => !/^(name|model|effort):/.test(line));
  return Buffer.from(
    `---\nname: ${JSON.stringify(agentType(kind, model))}\n${metadata.join('\n')}\nmodel: ${JSON.stringify(model)}\n---\n${text.slice(match[0].length)}`,
  );
}

async function checkParents(home) {
  for (const relative of ['', 'agents', 'agents/pstack-cc', 'pstack-cc'])
    await inspect(path.join(home, relative), true);
}

function journalFor(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.plans) ||
    !value.plans.length
  )
    throw new Error('Agent recovery journal is invalid.');
  const seen = new Set();
  for (const plan of value.plans) {
    if (
      (plan.relative !== registryName && !validAgentPath(plan.relative)) ||
      seen.has(plan.relative)
    )
      throw new Error('Agent recovery path is invalid.');
    seen.add(plan.relative);
    for (const state of [plan.previous, plan.next])
      if (
        state !== null &&
        (!state ||
          typeof state.bytes !== 'string' ||
          !/^[a-f0-9]{64}$/.test(state.sha256) ||
          hash(Buffer.from(state.bytes, 'base64')) !== state.sha256 ||
          !Number.isInteger(state.mode) ||
          state.mode < 0 ||
          state.mode > 0o777)
      )
        throw new Error('Agent recovery contents are invalid.');
  }
  return value;
}

async function finish(home, journal, journalFile) {
  await checkParents(home);
  for (const plan of journal.plans) {
    const state = await snapshot(path.join(home, plan.relative));
    if (!matches(state, plan.previous) && !matches(state, plan.next))
      throw new Error(
        `Agent changed during interrupted registration: ${path.join(home, plan.relative)}`,
      );
  }
  for (const plan of journal.plans) {
    const file = path.join(home, plan.relative);
    const current = await snapshot(file);
    if (matches(current, plan.next)) continue;
    if (!matches(current, plan.previous))
      throw new Error(`Agent changed during registration: ${file}`);
    if (plan.next) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await checkParents(home);
      await atomicWrite(
        file,
        Buffer.from(plan.next.bytes, 'base64'),
        plan.next.mode,
      );
    } else await fs.unlink(file);
  }
  await fs.unlink(journalFile);
}

async function withLock(directory, operation) {
  await fs.mkdir(directory, { recursive: true });
  await inspect(directory, true);
  const file = path.join(directory, '.agent-registration.lock');
  for (;;) {
    try {
      await fs.writeFile(file, jsonBytes({ pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const state = await snapshot(file);
      let lock;
      try {
        lock = JSON.parse(state.bytes);
      } catch {
        throw new Error('Agent registration lock is invalid.');
      }
      if (!Number.isInteger(lock.pid) || lock.pid <= 0)
        throw new Error(
          'Agent registration lock has no valid process identity.',
        );
      try {
        process.kill(lock.pid, 0);
        throw new Error('Another agent registration is running.');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await fs.unlink(file);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function register(options, home) {
  const directory = path.join(home, 'pstack-cc');
  const registryFile = path.join(home, registryName);
  const journalFile = path.join(directory, '.agent-registration.pending.json');
  await checkParents(home);
  const pending = await snapshot(journalFile);
  let recovered = false;
  if (pending) {
    const journal = journalFor(JSON.parse(pending.bytes));
    if (options.dryRun)
      return {
        dryRun: true,
        recoveryPending: true,
        files: journal.plans.map((plan) => path.join(home, plan.relative)),
      };
    await finish(home, journal, journalFile);
    recovered = true;
  }
  const manifest = await inputJson(
    path.join(pluginRoot, '.claude-plugin/plugin.json'),
    'Claude plugin manifest',
  );
  if (
    manifest.name !== 'pstack-cc' ||
    typeof manifest.version !== 'string' ||
    !manifest.version
  )
    throw new Error('Expected pstack-cc plugin manifest and version.');
  const previousRegistry = await snapshot(registryFile);
  const registry = previousRegistry
    ? recordFor(JSON.parse(previousRegistry.bytes))
    : undefined;
  const desired = new Map();
  if (!options.unregister) {
    const supplied = options.input
      ? await inputJson(options.input, '--input')
      : (await loadConfig(home)).config;
    const { config } = normalizeConfig(supplied.config ?? supplied);
    const models = [
      ...new Set(
        Object.values(config.roles)
          .flatMap(entriesFor)
          .filter(
            (entry) =>
              typeof entry === 'object' &&
              entry.executor === 'claude-code' &&
              !aliases.has(entry.model),
          )
          .map((entry) => entry.model),
      ),
    ];
    for (const kind of kinds) {
      const source = await snapshot(
        path.join(pluginRoot, 'agents', `${kind}.md`),
      );
      if (!source) throw new Error(`Bundled agent body is missing: ${kind}`);
      for (const model of models) {
        const name = agentType(kind, model);
        const relative = `${agentPrefix}${name}.md`;
        const bytes = variant(source.bytes, kind, model);
        desired.set(relative, {
          bytes,
          sha256: hash(bytes),
          mode: 0o600,
          agentType: name,
          model,
          kind,
        });
      }
    }
  }
  const plans = [];
  for (const relative of new Set([
    ...Object.keys(registry?.agents ?? {}),
    ...desired.keys(),
  ])) {
    const previous = await snapshot(path.join(home, relative));
    const owned = registry?.agents[relative];
    if (owned ? !matches(previous, owned) : Boolean(previous))
      throw new Error(
        `Agent is unowned or was modified: ${path.join(home, relative)}`,
      );
    const next =
      desired.get(relative) ?? (options.unregister ? null : previous);
    if (!matches(previous, next))
      plans.push({
        relative,
        previous: encoded(previous),
        next: encoded(next),
      });
  }
  const nextRegistry = options.unregister
    ? null
    : {
        schemaVersion: 1,
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        agents: {
          ...registry?.agents,
          ...Object.fromEntries(
            [...desired].map(([relative, entry]) => [
              relative,
              {
                sha256: entry.sha256,
                mode: entry.mode,
                kind: entry.kind,
                model: entry.model,
                agentType: entry.agentType,
              },
            ]),
          ),
        },
      };
  const nextRegistryState = nextRegistry
    ? { bytes: jsonBytes(nextRegistry), mode: previousRegistry?.mode ?? 0o600 }
    : null;
  if (
    !matches(
      previousRegistry,
      nextRegistryState
        ? { ...nextRegistryState, sha256: hash(nextRegistryState.bytes) }
        : null,
    )
  )
    plans.push({
      relative: registryName,
      previous: encoded(previousRegistry),
      next: encoded(nextRegistryState),
    });
  const result = {
    registered: !options.unregister,
    changed: Boolean(plans.length),
    dryRun: Boolean(options.dryRun),
    recovered,
    registry: registryFile,
    agents: [...desired].map(([relative, entry]) => ({
      file: path.join(home, relative),
      agentType: entry.agentType,
      model: entry.model,
      kind: entry.kind,
    })),
    retained: options.unregister
      ? []
      : Object.keys(registry?.agents ?? {})
          .filter((relative) => !desired.has(relative))
          .map((relative) => path.join(home, relative)),
    removed: plans
      .filter((plan) => !plan.next)
      .map((plan) => path.join(home, plan.relative)),
    modelPreferencesRetained: true,
  };
  if (options.dryRun || !plans.length) return result;
  const journal = { schemaVersion: 1, plans };
  await atomicWrite(journalFile, jsonBytes(journal));
  await finish(home, journal, journalFile);
  return result;
}

await run(async () => {
  const options = argumentsFor(
    process.argv.slice(2),
    null,
    ['--claude-home', '--input'],
    ['--dry-run', '--unregister'],
  );
  if (options.help) {
    process.stdout.write(
      'Usage: node register-agents.mjs [--claude-home ABS] [--input ABS_CONFIG] [--dry-run] [--unregister]\n',
    );
    return;
  }
  const home = claudeHome(options.claudeHome);
  if (options.dryRun) return register(options, home);
  await checkParents(home);
  return withLock(path.join(home, 'pstack-cc'), () => register(options, home));
});
