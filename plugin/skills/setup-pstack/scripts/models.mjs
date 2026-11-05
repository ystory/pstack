#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CLAUDE_MODEL,
  exactClaudeModel,
  normalizeClaudeRuntime,
} from '../../poteto-mode/scripts/claude-capabilities.mjs';

const roles = {
  'feature, refactoring': 1,
  'bug-fix': 1,
  'perf-issue': 1,
  hillclimb: 1,
  'judgment and prose': 1,
  'hardest tasks': 1,
  'how explorer': 1,
  'how explainer': 1,
  'why investigators': 1,
  'why synthesizer': 1,
  'reflect tooling': 1,
  'reflect judgment, divergent, synthesizer': 1,
  'arena runners': 2,
  'arena cross-judge pool': 2,
  'swarm workers': 1,
  'architect runners': 2,
  'interrogate reviewers': 2,
};
const budgets = {
  unlimited: 'max',
  large: 'xhigh',
  medium: 'high',
  small: 'medium',
};
const efforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const aliases = new Set(['auto', 'inherit-parent']);
const commands = new Set(['read', 'resolve', 'budget', 'write', 'catalog']);

function argumentsFor(argv) {
  const options = { command: argv[0], dryRun: false, help: false };
  if (argv[0] === '--help') return { help: true };
  if (!commands.has(options.command))
    throw new Error('Choose read, resolve, budget, write, or catalog.');
  const flags = {
    '--codex-home': 'codexHome',
    '--role': 'role',
    '--budget': 'budget',
    '--catalog': 'catalog',
    '--claude-runtime': 'claudeRuntime',
    '--input': 'input',
    '--expected-hash': 'expectedHash',
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help') options.help = true;
    else if (flags[argument]) {
      const key = flags[argument];
      const value = argv[++index];
      if (!value || value.startsWith('--') || options[key] !== undefined)
        throw new Error(`${argument} requires one value.`);
      options[key] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function inspect(file, directory = false) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${file}`);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw new Error(`Expected ${directory ? 'directory' : 'file'}: ${file}`);
  return stat;
}

async function snapshot(file) {
  const stat = await inspect(file);
  if (!stat) return undefined;
  const bytes = await fs.readFile(file);
  return { bytes, sha256: hash(bytes), mode: stat.mode & 0o777 };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function inputJson(file, label) {
  if (!file || !path.isAbsolute(file))
    throw new Error(`${label} requires an absolute file path.`);
  const input = await snapshot(file);
  if (!input) throw new Error(`${label} file is missing: ${file}`);
  return parseJson(input.bytes, label);
}

const executorFor = (entry) =>
  entry.executor === undefined ? 'codex' : entry.executor;
const modelKey = (entry) => `${executorFor(entry)}\0${entry.model}`;

function normalizeCatalog(input, suppliedRuntime) {
  const response = input?.result ?? input;
  const data = Array.isArray(response)
    ? response
    : (response?.data ?? response?.models);
  if (!Array.isArray(data))
    throw new Error('Model catalog must contain a model/list data array.');
  if (response?.nextCursor)
    throw new Error(
      'Model catalog has another page; collect all model/list pages before configuring.',
    );
  if (!Array.isArray(response?.runtimes ?? []))
    throw new Error('Model catalog runtimes must be an array.');
  const runtimes = [...(response?.runtimes ?? [])];
  if (suppliedRuntime) runtimes.push(suppliedRuntime);
  if (runtimes.length > 1)
    throw new Error('Supply one detected Claude runtime.');
  const runtime = runtimes[0] && normalizeClaudeRuntime(runtimes[0]);
  const combined = [...data];
  if (
    runtime &&
    !combined.some(
      (entry) =>
        executorFor(entry) === 'claude-code' &&
        (entry.model ?? entry.id) === DEFAULT_CLAUDE_MODEL,
    )
  )
    combined.push({
      executor: 'claude-code',
      model: DEFAULT_CLAUDE_MODEL,
      supportedReasoningEfforts: runtime.effortSyntax,
      source: {
        kind: 'bundled-default',
        description:
          'Shipped default route using global CLI effort syntax, not proof of account access or model execution.',
      },
    });
  const seen = new Set();
  const models = combined.map((model) => {
    const id = model.model ?? model.id;
    const supported =
      model.supportedReasoningEfforts ?? model.supported_reasoning_efforts;
    const reasoningEfforts = supported?.map((entry) =>
      typeof entry === 'string'
        ? entry
        : (entry.reasoningEffort ?? entry.reasoning_effort),
    );
    if (
      typeof id !== 'string' ||
      !id ||
      !['codex', 'claude-code'].includes(executorFor(model)) ||
      seen.has(modelKey({ ...model, model: id })) ||
      !Array.isArray(reasoningEfforts) ||
      !reasoningEfforts.length ||
      reasoningEfforts.some((effort) => typeof effort !== 'string' || !effort)
    ) {
      throw new Error(
        'Model catalog entries need unique model IDs and supported reasoning efforts.',
      );
    }
    if (executorFor(model) === 'claude-code') {
      exactClaudeModel(id);
      if (
        !runtime ||
        reasoningEfforts.some(
          (effort) => !runtime.effortSyntax.includes(effort),
        )
      )
        throw new Error(
          'External catalog entries require efforts expressible by the detected Claude runtime.',
        );
      const source = model.source;
      if (
        ![
          'host',
          'configuration',
          'manual-confirmation',
          ...(id === DEFAULT_CLAUDE_MODEL ? ['bundled-default'] : []),
        ].includes(source?.kind) ||
        typeof source?.description !== 'string' ||
        !source.description.trim()
      )
        throw new Error(
          'External catalog entries require a labeled per-model source for the exact ID and supported efforts.',
        );
    }
    seen.add(modelKey({ ...model, model: id }));
    return {
      ...(model.executor !== undefined ? { executor: model.executor } : {}),
      model: id,
      supportedReasoningEfforts: [...new Set(reasoningEfforts)],
      ...(executorFor(model) === 'claude-code'
        ? {
            source: {
              kind: model.source.kind,
              description: model.source.description,
            },
          }
        : {}),
    };
  });
  return { models, ...(runtime ? { runtimes: [runtime] } : {}) };
}

function validateEntry(entry, role) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.model !== 'string' ||
    !entry.model.trim() ||
    entry.model !== entry.model.trim()
  )
    throw new Error(`Invalid model entry for ${role}.`);
  if (!['codex', 'claude-code'].includes(executorFor(entry)))
    throw new Error(`Unknown executor for ${role}.`);
  const executor =
    entry.executor === undefined ? {} : { executor: entry.executor };
  if (aliases.has(entry.model)) {
    if (executorFor(entry) !== 'codex')
      throw new Error(
        `Inherited role ${role} selects the native Codex parent.`,
      );
    if (entry.reasoningEffort !== undefined)
      throw new Error(`Inherited role ${role} must omit reasoningEffort.`);
    return { ...executor, model: entry.model };
  }
  if (typeof entry.reasoningEffort !== 'string' || !entry.reasoningEffort)
    throw new Error(`Role ${role} must declare a separate reasoningEffort.`);
  if (executorFor(entry) === 'claude-code') exactClaudeModel(entry.model);
  return {
    ...executor,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
  };
}

function defaultsFor(role, budget) {
  const sol = { model: 'gpt-6.1-sol', reasoningEffort: budgets[budget] };
  const opus = {
    executor: 'claude-code',
    model: DEFAULT_CLAUDE_MODEL,
    reasoningEffort: budgets[budget],
  };
  if (role === 'hardest tasks') return [opus];
  return roles[role] === 2 ? [sol, opus] : [sol];
}

function defaultChanges(saved, config) {
  return Object.entries(roles).flatMap(([role, count]) => {
    if (
      !Object.hasOwn(saved?.roles ?? {}, role) ||
      (role !== 'hardest tasks' && count !== 2)
    )
      return [];
    const current = config.roles[role];
    const proposed = defaultsFor(role, config.budget);
    if (JSON.stringify(current) === JSON.stringify(proposed)) return [];
    const previousDefault = Array.from({ length: count }, () => ({
      model: 'gpt-6.1-sol',
      reasoningEffort: budgets[config.budget],
    }));
    return [
      {
        role,
        current,
        proposed,
        matchesPreviousDefault:
          JSON.stringify(current) === JSON.stringify(previousDefault),
      },
    ];
  });
}

function normalizeConfig(input, previous) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.schemaVersion !== undefined && ![1, 2].includes(input.schemaVersion))
  )
    throw new Error('Model configuration schemaVersion must be 1 or 2.');
  const budget = input.budget ?? previous?.budget ?? 'large';
  if (!Object.hasOwn(budgets, budget))
    throw new Error('Unknown pstack budget.');
  const selected = input.roles ?? {};
  if (!selected || typeof selected !== 'object' || Array.isArray(selected))
    throw new Error('Model configuration roles must be an object.');
  const droppedRoles = Object.keys(selected).filter(
    (role) => !Object.hasOwn(roles, role),
  );
  const normalized = {};
  for (const [role, count] of Object.entries(roles)) {
    const entries = Object.hasOwn(selected, role)
      ? selected[role]
      : (previous?.roles[role] ?? defaultsFor(role, budget));
    if (!Array.isArray(entries) || !entries.length)
      throw new Error(`Role ${role} must contain at least one entry.`);
    if (count === 1 && entries.length !== 1)
      throw new Error(`Scalar role ${role} must contain exactly one entry.`);
    normalized[role] = entries.map((entry) => validateEntry(entry, role));
    if (
      input.schemaVersion === 1 &&
      Object.hasOwn(selected, role) &&
      normalized[role].some((entry) => executorFor(entry) === 'claude-code')
    )
      throw new Error(
        'Claude executor entries require model configuration schemaVersion 2; schemaVersion 1 is native-only.',
      );
  }
  const schemaVersion = Object.values(normalized).some((entries) =>
    entries.some((entry) => executorFor(entry) === 'claude-code'),
  )
    ? 2
    : 1;
  return {
    config: { schemaVersion, budget, roles: normalized },
    droppedRoles,
  };
}

function validateCatalog(config, catalog) {
  const detected = new Map(
    catalog.models.map((entry) => [
      modelKey(entry),
      entry.supportedReasoningEfforts,
    ]),
  );
  for (const [role, entries] of Object.entries(config.roles)) {
    for (const entry of entries) {
      if (aliases.has(entry.model)) continue;
      const supported = detected.get(modelKey(entry));
      if (!supported)
        throw new Error(
          `Model ${entry.model} for ${role} is not in the detected ${executorFor(entry)} catalog.`,
        );
      if (!supported.includes(entry.reasoningEffort))
        throw new Error(
          `Reasoning effort ${entry.reasoningEffort} is not supported by ${entry.model} for ${role}.`,
        );
    }
  }
}

function applyBudget(config, budget, catalog) {
  if (!Object.hasOwn(budgets, budget))
    throw new Error('Unknown pstack budget.');
  const target = budgets[budget];
  const detected = new Map(
    catalog.models.map((entry) => [
      modelKey(entry),
      entry.supportedReasoningEfforts,
    ]),
  );
  const needsChoice = [];
  const mapped = structuredClone(config);
  mapped.budget = budget;
  for (const [role, entries] of Object.entries(mapped.roles)) {
    entries.forEach((entry, index) => {
      if (aliases.has(entry.model)) return;
      const supported = detected.get(modelKey(entry)) ?? [];
      const resolved = efforts
        .slice(0, efforts.indexOf(target) + 1)
        .reverse()
        .find((effort) => supported.includes(effort));
      if (!resolved)
        needsChoice.push({
          role,
          index,
          ...(entry.executor !== undefined ? { executor: entry.executor } : {}),
          model: entry.model,
          targetReasoningEffort: target,
        });
      else entry.reasoningEffort = resolved;
    });
  }
  return { config: mapped, targetReasoningEffort: target, needsChoice };
}

async function main(options) {
  const runtime = options.claudeRuntime
    ? await inputJson(options.claudeRuntime, '--claude-runtime')
    : undefined;
  if (options.command === 'catalog')
    return normalizeCatalog(await inputJson(options.input, '--input'), runtime);
  const selectedHome =
    options.codexHome ??
    process.env.CODEX_HOME ??
    path.join(os.homedir(), '.codex');
  if (!path.isAbsolute(selectedHome))
    throw new Error('Codex home must be an absolute path.');
  const codexHome = path.resolve(selectedHome);
  const directory = path.join(codexHome, 'pstack-for-codex');
  const file = path.join(directory, 'models.json');
  await inspect(codexHome, true);
  await inspect(directory, true);
  const existing = await snapshot(file);
  const saved = existing
    ? parseJson(existing.bytes, 'Model configuration')
    : undefined;
  const loaded = normalizeConfig(saved ?? { schemaVersion: 1 });
  const info = {
    file,
    exists: Boolean(existing),
    sha256: existing?.sha256 ?? null,
  };
  if (options.command === 'read')
    return {
      ...info,
      ...loaded,
      defaultChanges: defaultChanges(saved, loaded.config),
      targetReasoningEffort: budgets[loaded.config.budget],
    };
  if (options.command === 'resolve') {
    if (!Object.hasOwn(roles, options.role))
      throw new Error(
        `Unknown pstack role: ${options.role ?? '(missing --role)'}`,
      );
    return {
      role: options.role,
      entries: loaded.config.roles[options.role],
      source: Object.hasOwn(saved?.roles ?? {}, options.role)
        ? 'saved'
        : 'default',
      file,
      budget: loaded.config.budget,
      targetReasoningEffort: budgets[loaded.config.budget],
    };
  }
  const catalog = normalizeCatalog(
    await inputJson(options.catalog, '--catalog'),
    runtime,
  );
  if (options.command === 'budget')
    return {
      ...info,
      droppedRoles: loaded.droppedRoles,
      ...applyBudget(loaded.config, options.budget, catalog),
    };
  const supplied = await inputJson(options.input, '--input');
  if (Array.isArray(supplied.needsChoice) && supplied.needsChoice.length)
    throw new Error(
      'Resolve every needsChoice entry before saving model preferences.',
    );
  const proposal = normalizeConfig(supplied.config ?? supplied, loaded.config);
  validateCatalog(proposal.config, catalog);
  const expected = options.expectedHash;
  if (!expected || (expected !== 'absent' && !/^[a-f0-9]{64}$/.test(expected)))
    throw new Error(
      'write requires --expected-hash from read (use absent when no file exists).',
    );
  if (expected !== (existing?.sha256 ?? 'absent'))
    throw new Error(
      'Model configuration changed since it was read; reload before saving.',
    );
  const bytes = jsonBytes(proposal.config);
  const changed = !existing || !bytes.equals(existing.bytes);
  const result = {
    ...info,
    ...proposal,
    changed,
    dryRun: options.dryRun,
    sha256: hash(bytes),
  };
  if (options.dryRun || !changed) return result;
  await fs.mkdir(directory, { recursive: true });
  await inspect(codexHome, true);
  await inspect(directory, true);
  const temporary = path.join(directory, `.models.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, {
      flag: 'wx',
      mode: existing?.mode ?? 0o600,
    });
    await fs.chmod(temporary, existing?.mode ?? 0o600);
    const current = await snapshot(file);
    if (
      (current?.sha256 ?? 'absent') !== expected ||
      (current && current.mode !== existing.mode)
    )
      throw new Error(
        'Model configuration changed during save; reload before saving.',
      );
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { ...result, exists: true };
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help)
    process.stdout.write(
      'Usage: node models.mjs read|resolve|budget|write|catalog [options]\nread/resolve: [--codex-home ABS] [--role ROLE]\nbudget: --budget unlimited|large|medium|small --catalog ABS\nwrite: --input ABS --catalog ABS --expected-hash HASH|absent [--dry-run]\ncatalog: --input ABS (native model/list or combined model capabilities) [--claude-runtime ABS]\nbudget/write also accept --claude-runtime ABS or a normalized catalog containing its runtime receipt.\n',
    );
  else
    process.stdout.write(`${JSON.stringify(await main(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
