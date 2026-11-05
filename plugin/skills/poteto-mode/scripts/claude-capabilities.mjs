import path from 'node:path';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const CLAUDE_MINIMUM_VERSION = '2.1.280';
export const CLAUDE_CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const aliases = new Set([
  'auto',
  'inherit-parent',
  'default',
  'best',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'opusplan',
  'inherit',
]);

export function exactClaudeModel(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^[\s-]|[\s\p{Cc}]/u.test(value) ||
    aliases.has(value.split('[')[0])
  )
    throw new Error(
      'Claude execution requires an exact model ID, not a parent or moving CLI alias.',
    );
  return value;
}

export function versionAtLeast(version, minimum) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) return false;
  const actual = version.split(/[.-]/).slice(0, 3).map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index])
      return actual[index] > required[index];
  }
  return true;
}

export function normalizeClaudeRuntime(runtime) {
  if (
    runtime?.executor !== 'claude-code' ||
    typeof runtime.executable !== 'string' ||
    !path.isAbsolute(runtime.executable) ||
    typeof runtime.version !== 'string' ||
    !versionAtLeast(runtime.version, CLAUDE_MINIMUM_VERSION) ||
    ['print', 'model', 'effort', 'outputFormat', 'verbose', 'resume'].some(
      (option) => runtime.requiredOptions?.[option] !== true,
    ) ||
    runtime.compatible === false ||
    typeof runtime.modelExecutionVerified !== 'boolean' ||
    !Array.isArray(runtime.effortSyntax) ||
    !runtime.effortSyntax.length ||
    runtime.effortSyntax.some((effort) => !CLAUDE_CLI_EFFORTS.includes(effort))
  )
    throw new Error(
      `Claude runtime requires a detected executable, CLI ${CLAUDE_MINIMUM_VERSION} or newer, required options, and global effort syntax. CLI detection does not verify model execution.`,
    );
  return {
    executor: 'claude-code',
    executable: runtime.executable,
    version: runtime.version,
    minimumVersion: CLAUDE_MINIMUM_VERSION,
    requiredOptions: Object.fromEntries(
      ['print', 'model', 'effort', 'outputFormat', 'verbose', 'resume'].map(
        (option) => [option, true],
      ),
    ),
    compatible: true,
    effortSyntax: [...new Set(runtime.effortSyntax)],
    modelExecutionVerified: runtime.modelExecutionVerified,
  };
}
