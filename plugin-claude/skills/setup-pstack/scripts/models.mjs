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
  unchanged,
} from './state.mjs';
import {
  agentType,
  aliases,
  budgets,
  efforts,
  entriesFor,
  modelFor,
  roles,
  kinds,
} from './roles.mjs';

const nativeAliases = new Set([
  'default',
  'best',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'opusplan',
  'inherit',
]);
const judgmentRoles = new Set([
  'judgment and prose',
  'hardest tasks',
  'how explainer',
  'why synthesizer',
  'reflect judgment, divergent, synthesizer',
]);
const keyFor = (entry) => `${entry.executor}\0${entry.model}`;

function isNativeAlias(model) {
  const base = model.split('[')[0];
  return nativeAliases.has(base) || aliases.has(base);
}

function entryFor(value, role) {
  if (typeof value === 'string' && aliases.has(value)) return value;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.trim() !== value.model
  )
    throw new Error(`Invalid model entry for ${role}.`);
  const executor = value.executor ?? 'claude-code';
  if (!['claude-code', 'codex'].includes(executor))
    throw new Error(`Unknown executor for ${role}.`);
  if (aliases.has(value.model)) {
    if (executor !== 'claude-code' || value.reasoningEffort !== undefined)
      throw new Error(
        `Parent alias for ${role} must select native Claude and omit reasoningEffort.`,
      );
    return { executor, model: value.model };
  }
  if (executor === 'claude-code' && isNativeAlias(value.model))
    throw new Error(
      `Role ${role} requires an exact Claude model ID, not ${value.model}.`,
    );
  if (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort)
    throw new Error(`Role ${role} must declare a separate reasoningEffort.`);
  return {
    executor,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function normalizeConfig(input, previous) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.schemaVersion !== undefined && input.schemaVersion !== 1) ||
    (input.host !== undefined && input.host !== 'claude-code')
  )
    throw new Error('Expected Claude model configuration schemaVersion 1.');
  const budget = input.budget ?? previous?.budget ?? 'large';
  if (!Object.hasOwn(budgets, budget))
    throw new Error('Unknown pstack budget.');
  const selected = input.roles ?? {};
  if (!selected || typeof selected !== 'object' || Array.isArray(selected))
    throw new Error('Model configuration roles must be an object.');
  const normalized = { ...(previous?.roles ?? {}) };
  const droppedRoles = [];
  for (const [role, value] of Object.entries(selected)) {
    if (!Object.hasOwn(roles, role)) {
      droppedRoles.push(role);
      continue;
    }
    if (roles[role] === 'scalar') {
      if (Array.isArray(value))
        throw new Error(
          `Scalar role ${role} requires one entry or parent alias, not a list.`,
        );
      normalized[role] = entryFor(value, role);
    } else {
      if (!Array.isArray(value) || !value.length)
        throw new Error(`List role ${role} requires a nonempty ordered list.`);
      normalized[role] = value.map((entry) => entryFor(entry, role));
    }
  }
  return {
    config: {
      schemaVersion: 1,
      host: 'claude-code',
      budget,
      roles: normalized,
    },
    droppedRoles,
  };
}

function suggestions(config) {
  const claude = {
    executor: 'claude-code',
    model: 'claude-opus-5-5',
    reasoningEffort: budgets[config.budget],
  };
  const grok = {
    upstreamModel: 'grok-4.7',
    upstreamSpeed: 'fast',
    reasoningEffort: budgets[config.budget],
  };
  return Object.fromEntries(
    Object.entries(roles).map(([role, kind]) => [
      role,
      Object.hasOwn(config.roles, role)
        ? config.roles[role]
        : kind === 'scalar'
          ? judgmentRoles.has(role)
            ? claude
            : grok
          : [claude, grok],
    ]),
  );
}

function executionDefault(entry, kind) {
  const inherited = Boolean(entry.upstreamModel);
  return {
    executor: 'claude-code',
    model: inherited ? 'inherit-parent' : 'opus',
    ...(inherited ? {} : { modelKind: 'native-alias' }),
    upstreamModel: entry.upstreamModel ?? entry.model,
    ...(inherited ? {} : { reasoningEffort: entry.reasoningEffort }),
    ...(kind ? { agentType: agentType(kind, 'inherit-parent') } : {}),
  };
}

export function normalizeCatalog(input, native) {
  const response = input?.codex?.models
    ? input.codex
    : (input?.result ?? input ?? { models: [] });
  if (response.nextCursor || response.next_cursor)
    throw new Error(
      'Model catalog has another page; collect all model/list pages before configuring.',
    );
  const data = Array.isArray(response)
    ? response
    : (response.models ?? response.data);
  if (!Array.isArray(data))
    throw new Error(
      'Model catalog must contain a models or model/list data array.',
    );
  const nativeResponse = native?.result ?? native;
  const nativeModels = nativeResponse
    ? (nativeResponse.models ?? nativeResponse.data)
    : [];
  if (!Array.isArray(nativeModels))
    throw new Error('Native catalog must contain a models array.');
  if (nativeResponse?.nextCursor || nativeResponse?.next_cursor)
    throw new Error('Native catalog is incomplete.');
  const seen = new Set();
  const models = [
    ...data,
    ...nativeModels.map((entry) => ({
      ...entry,
      executor: 'claude-code',
      source: entry.source ?? nativeResponse.source,
    })),
  ].map((entry) => {
    const executor = entry.executor ?? 'codex';
    const model = entry.model ?? entry.id;
    const supported =
      entry.supportedReasoningEfforts ?? entry.supported_reasoning_efforts;
    const supportedReasoningEfforts = supported?.map((effort) =>
      typeof effort === 'string'
        ? effort
        : (effort.reasoningEffort ?? effort.reasoning_effort),
    );
    if (
      !['claude-code', 'codex'].includes(executor) ||
      typeof model !== 'string' ||
      !model ||
      model.trim() !== model ||
      aliases.has(model) ||
      !Array.isArray(supportedReasoningEfforts) ||
      !supportedReasoningEfforts.length ||
      supportedReasoningEfforts.some((effort) => !efforts.includes(effort))
    )
      throw new Error(
        'Catalog entries require an executor, exact model ID, and supported reasoning efforts.',
      );
    if (
      executor === 'claude-code' &&
      (isNativeAlias(model) ||
        !['host', 'configuration', 'manual-confirmation'].includes(
          entry.source?.kind,
        ) ||
        typeof entry.source?.description !== 'string' ||
        !entry.source.description.trim())
    )
      throw new Error(
        'Native Claude models require an exact ID and a labeled host, configuration, or manual-confirmation source.',
      );
    const key = keyFor({ executor, model });
    if (seen.has(key))
      throw new Error(`Duplicate catalog model: ${executor} ${model}`);
    seen.add(key);
    return {
      executor,
      model,
      supportedReasoningEfforts: [...new Set(supportedReasoningEfforts)],
      ...(entry.source
        ? {
            source: {
              kind: entry.source.kind,
              description: entry.source.description,
            },
          }
        : {}),
    };
  });
  return { models };
}

function choicesFor(proposal, catalog) {
  const needsChoice = [];
  const detected =
    catalog &&
    new Map(
      catalog.models.map((entry) => [
        keyFor(entry),
        entry.supportedReasoningEfforts,
      ]),
    );
  for (const [role, value] of Object.entries(proposal)) {
    entriesFor(value).forEach((entry, index) => {
      if (entry?.upstreamModel)
        needsChoice.push({
          role,
          ...(Array.isArray(value) ? { index } : {}),
          upstreamModel: entry.upstreamModel,
          reason:
            'Choose a detected executor and exact model for this upstream suggestion.',
        });
      else if (!aliases.has(modelFor(entry)) && detected) {
        const supported = detected.get(keyFor(entry));
        if (!supported?.includes(entry.reasoningEffort))
          needsChoice.push({
            role,
            ...(Array.isArray(value) ? { index } : {}),
            ...entry,
            reason: supported
              ? 'Unsupported reasoning effort.'
              : 'Model is absent from its executor catalog.',
          });
      }
    });
  }
  return needsChoice;
}

export async function loadConfig(home) {
  const directory = path.join(home, 'pstack-cc');
  const file = path.join(directory, 'models.json');
  await inspect(home, true);
  await inspect(directory, true);
  const existing = await snapshot(file);
  let saved;
  if (existing) {
    try {
      saved = JSON.parse(existing.bytes.toString('utf8'));
    } catch {
      throw new Error('Model configuration is not valid JSON.');
    }
  }
  return { file, directory, existing, ...normalizeConfig(saved ?? {}), saved };
}

async function main(options) {
  if (options.command === 'catalog')
    return normalizeCatalog(
      options.input
        ? await inputJson(options.input, '--input')
        : { models: [] },
      options.nativeCatalog
        ? await inputJson(options.nativeCatalog, '--native-catalog')
        : undefined,
    );
  const home = claudeHome(options.claudeHome);
  const loaded = await loadConfig(home);
  const info = {
    file: loaded.file,
    exists: Boolean(loaded.existing),
    sha256: loaded.existing?.sha256 ?? null,
  };
  const proposal = suggestions(
    options.defaults ? { ...loaded.config, roles: {} } : loaded.config,
  );
  if (options.command === 'read')
    return {
      ...info,
      config: loaded.config,
      proposal: { ...loaded.config, roles: proposal },
      droppedRoles: loaded.droppedRoles,
      needsChoice: choicesFor(proposal),
      targetReasoningEffort: budgets[loaded.config.budget],
    };
  if (options.command === 'resolve') {
    if (options.kind && !kinds.includes(options.kind))
      throw new Error(`Unknown worker kind: ${options.kind}`);
    if (!Object.hasOwn(roles, options.role))
      throw new Error(
        `Unknown pstack role: ${options.role ?? '(missing --role)'}`,
      );
    const saved =
      !options.defaults && Object.hasOwn(loaded.config.roles, options.role);
    const entries = entriesFor(proposal[options.role]).map((entry) => {
      if (!saved) return executionDefault(entry, options.kind);
      const normalized =
        typeof entry === 'string'
          ? { executor: 'claude-code', model: entry }
          : entry;
      return {
        ...normalized,
        ...(options.kind && normalized.executor === 'claude-code'
          ? { agentType: agentType(options.kind, normalized.model) }
          : {}),
      };
    });
    return {
      role: options.role,
      cardinality: roles[options.role],
      entries,
      needsChoice: [],
      source: saved ? 'saved' : 'upstream-default',
      file: loaded.file,
      budget: loaded.config.budget,
      targetReasoningEffort: budgets[loaded.config.budget],
    };
  }
  const catalog = normalizeCatalog(
    await inputJson(options.catalog, '--catalog'),
  );
  if (options.command === 'budget') {
    if (!Object.hasOwn(budgets, options.budget))
      throw new Error('Unknown pstack budget.');
    const config = {
      ...loaded.config,
      budget: options.budget,
      roles: structuredClone(proposal),
    };
    const target = budgets[options.budget];
    const unmapped = [];
    const detected = new Map(
      catalog.models.map((entry) => [
        keyFor(entry),
        entry.supportedReasoningEfforts,
      ]),
    );
    for (const [role, value] of Object.entries(config.roles))
      for (const [index, entry] of entriesFor(value).entries()) {
        if (typeof entry === 'string' || aliases.has(entry.model)) continue;
        const supported = detected.get(keyFor(entry)) ?? [];
        const resolved = efforts
          .slice(0, efforts.indexOf(target) + 1)
          .reverse()
          .find((effort) => supported.includes(effort));
        if (resolved) entry.reasoningEffort = resolved;
        else if (!entry.upstreamModel)
          unmapped.push({
            role,
            ...(Array.isArray(value) ? { index } : {}),
            ...entry,
            targetReasoningEffort: target,
            reason: 'No supported reasoning effort is at or below this budget.',
          });
      }
    return {
      ...info,
      config,
      targetReasoningEffort: target,
      droppedRoles: loaded.droppedRoles,
      needsChoice: [...choicesFor(config.roles, catalog), ...unmapped],
    };
  }
  const supplied = await inputJson(options.input, '--input');
  if (supplied.needsChoice?.length)
    throw new Error(
      'Resolve every needsChoice entry before saving model preferences.',
    );
  const normalized = normalizeConfig(
    supplied.config ?? supplied,
    loaded.config,
  );
  const missing = Object.keys(roles).filter(
    (role) => !Object.hasOwn(normalized.config.roles, role),
  );
  if (missing.length)
    throw new Error(
      `Choose every role before saving. Missing: ${missing.join(', ')}`,
    );
  const needsChoice = choicesFor(normalized.config.roles, catalog);
  if (needsChoice.length)
    throw new Error(
      `Resolve unavailable models or efforts before saving: ${JSON.stringify(needsChoice)}`,
    );
  const expected = options.expectedHash;
  if (!expected || (expected !== 'absent' && !/^[a-f0-9]{64}$/.test(expected)))
    throw new Error('write requires --expected-hash from read, or absent.');
  if (expected !== (loaded.existing?.sha256 ?? 'absent'))
    throw new Error(
      'Model configuration changed since it was read; reload before saving.',
    );
  const bytes = jsonBytes(normalized.config);
  const changed = !loaded.existing || !bytes.equals(loaded.existing.bytes);
  const result = {
    ...info,
    ...normalized,
    changed,
    dryRun: Boolean(options.dryRun),
    sha256: hash(bytes),
  };
  if (options.dryRun || !changed) return result;
  await fs.mkdir(loaded.directory, { recursive: true });
  await inspect(home, true);
  await inspect(loaded.directory, true);
  await unchanged(loaded.file, loaded.existing);
  await atomicWrite(loaded.file, bytes, loaded.existing?.mode ?? 0o600);
  return { ...result, exists: true };
}

if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url)
)
  await run(async () => {
    const options = argumentsFor(
      process.argv.slice(2),
      ['read', 'resolve', 'budget', 'write', 'catalog'],
      [
        '--claude-home',
        '--role',
        '--kind',
        '--budget',
        '--catalog',
        '--native-catalog',
        '--input',
        '--expected-hash',
      ],
      ['--dry-run', '--defaults'],
    );
    if (options.help) {
      process.stdout.write(
        'Usage: node models.mjs read|resolve|budget|write|catalog\nread/resolve: [--claude-home ABS] [--role ROLE] [--kind KIND]\ncatalog: [--input ABS_CODEX_CATALOG] [--native-catalog ABS_CONFIRMED_NATIVE_CATALOG]\nbudget: --budget unlimited|large|medium|small --catalog ABS\nwrite: --input ABS --catalog ABS --expected-hash HASH|absent [--dry-run]\n',
      );
      return;
    }
    return main(options);
  });
