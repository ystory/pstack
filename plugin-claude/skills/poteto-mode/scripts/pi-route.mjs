export const piMinimumVersion = '1.5.2';

export function supportedPiVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  const minimum = piMinimumVersion.split('.').map(Number);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

export const piEfforts = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const aliases = new Set(['auto', 'inherit-parent']);

function exact(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`${label} must be an exact nonempty identifier.`);
  return value;
}

export function routeKey(entry, native = 'codex') {
  const executor = entry.executor ?? native;
  if (executor === 'pi')
    return `pi\0${exact(entry.provider, 'Pi provider')}\0${exact(entry.model, 'Pi model')}`;
  if (entry.provider !== undefined)
    throw new Error('provider is valid only for the Pi executor.');
  return `${executor}\0${entry.model}`;
}

export function piEntry(value) {
  const provider = exact(value.provider, 'Pi provider');
  const model = exact(value.model, 'Pi model');
  if (aliases.has(model))
    throw new Error('Pi requires an exact model, not a native parent alias.');
  if (!piEfforts.includes(value.reasoningEffort))
    throw new Error(
      'Pi requires an explicit supported reasoning effort, including off.',
    );
  return {
    executor: 'pi',
    provider,
    model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function piCapability(value) {
  const supportedReasoningEfforts = value.supportedReasoningEfforts;
  if (
    !Array.isArray(supportedReasoningEfforts) ||
    !supportedReasoningEfforts.length ||
    supportedReasoningEfforts.some((level) => !piEfforts.includes(level))
  )
    throw new Error('Pi capabilities require reported thinking levels.');
  const entry = piEntry({
    ...value,
    reasoningEffort: supportedReasoningEfforts[0],
  });
  if (
    !['host', 'configuration', 'manual-confirmation'].includes(
      value.source?.kind,
    ) ||
    typeof value.source?.description !== 'string' ||
    !value.source.description.trim()
  )
    throw new Error('Pi capabilities require a labeled per-model source.');
  return {
    executor: 'pi',
    provider: entry.provider,
    model: entry.model,
    supportedReasoningEfforts: [...new Set(supportedReasoningEfforts)],
    source: { kind: value.source.kind, description: value.source.description },
    ...(typeof value.runtimeVersion === 'string'
      ? { runtimeVersion: value.runtimeVersion }
      : {}),
  };
}
