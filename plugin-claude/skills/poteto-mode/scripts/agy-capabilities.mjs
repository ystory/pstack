import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGY_MINIMUM_VERSION = '1.5.8';
export const agyEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

const aliases = new Set([
  'auto',
  'inherit-parent',
  'default',
  'latest',
  'best',
  'inherit',
  'gemini',
  'claude',
  'opus',
  'sonnet',
  'haiku',
]);

export function agyEntry(value) {
  if (
    value?.executor !== 'antigravity' ||
    Object.keys(value).some((key) =>
      /^(?:provider|auth|credential|apiKey)/i.test(key),
    ) ||
    typeof value.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.model) ||
    aliases.has(value.model.toLowerCase())
  )
    throw new Error(
      'Antigravity requires an exact CLI model ID without aliases or a provider field.',
    );
  if (!agyEfforts.includes(value.reasoningEffort))
    throw new Error(
      `Antigravity requires an explicit effort: ${agyEfforts.join(', ')}.`,
    );
  return {
    executor: 'antigravity',
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function agyCapability(value) {
  const efforts = value?.supportedReasoningEfforts;
  if (
    !Array.isArray(efforts) ||
    !efforts.length ||
    efforts.some((level) => !agyEfforts.includes(level))
  )
    throw new Error(
      'Antigravity capabilities require reported per-model efforts.',
    );
  const entry = agyEntry({ ...value, reasoningEffort: efforts[0] });
  if (
    !['host', 'configuration', 'manual-confirmation'].includes(
      value.source?.kind,
    ) ||
    typeof value.source.description !== 'string' ||
    !value.source.description.trim()
  )
    throw new Error(
      'Antigravity capabilities require a labeled per-model source.',
    );
  if (value.source.kind === 'host' && new Set(efforts).size !== 1)
    throw new Error('Antigravity host evidence covers one fixed variant effort.');
  return {
    executor: entry.executor,
    model: entry.model,
    supportedReasoningEfforts: [...new Set(efforts)],
    source: { kind: value.source.kind, description: value.source.description },
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.runtimeVersion === 'string'
      ? { runtimeVersion: value.runtimeVersion }
      : {}),
  };
}

const authMethods = [
  ['gemini-api-key', ({ modelProvider }) => modelProvider === 'gemini'],
  ['adc', () => process.env.AGY_ADC_AUTH === 'true'],
  ['inherited-default', () => true],
];

export async function inheritedAgyAuth() {
  let modelProvider = null;
  try {
    const settings = JSON.parse(
      await readFile(
        path.join(os.homedir(), '.gemini/antigravity-cli/settings.json'),
        'utf8',
      ),
    );
    if (typeof settings?.modelProvider === 'string')
      modelProvider = settings.modelProvider;
  } catch {}
  const [method] = authMethods.find(([, applies]) =>
    applies({ modelProvider }),
  );
  return {
    method,
    modelProvider,
    geminiApiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    verified: false,
  };
}

export function supportedAgyVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    return false;
  const current = version.split('.').map(Number);
  const minimum = AGY_MINIMUM_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (current[index] !== minimum[index])
      return current[index] > minimum[index];
  }
  return true;
}

export function parseAgyModels(text, runtimeVersion) {
  const rawModels = [],
    models = [],
    candidates = [];
  const seen = new Set();
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of clean.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length !== 2 || /[\p{Cc}\p{Cf}]/u.test(fields.join('')))
      throw new Error(
        'agy models must return exact tab-separated model ID and label rows.',
      );
    const [model, label] = fields;
    if (!label.trim())
      throw new Error('agy models returned an empty model label.');
    agyEntry({ executor: 'antigravity', model, reasoningEffort: 'low' });
    if (seen.has(model))
      throw new Error(`agy models returned duplicate ID ${model}.`);
    seen.add(model);
    rawModels.push({ model, label });
    const variants = [
      ...label.matchAll(/\((XHigh|High|Medium|Low|Max)\)$/gi),
    ].map((match) => match[1].toLowerCase());
    if (new Set(variants).size === 1) {
      models.push(
        agyCapability({
          executor: 'antigravity',
          model,
          label,
          runtimeVersion,
          supportedReasoningEfforts: [variants[0]],
          source: {
            kind: 'host',
            description: `agy models label ${JSON.stringify(label)} reports only the fixed ${variants[0]} variant; configured availability, not inference or adjustable effort evidence.`,
          },
        }),
      );
    } else {
      candidates.push({
        executor: 'antigravity',
        model,
        label,
        source: {
          kind: 'host',
          description:
            'agy models lists this exact ID; its label does not establish a single supported effort. Additional per-model evidence is required.',
        },
      });
    }
  }
  if (!rawModels.length) throw new Error('agy models returned no model rows.');
  return { models, candidates, rawModels };
}
