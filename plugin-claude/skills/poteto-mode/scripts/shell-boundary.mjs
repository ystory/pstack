export const SHELL_BOUNDARY_CONTEXT =
  'Pstack protects this macOS worker before every shell operation. CODEX_SANDBOX=seatbelt stops the command with exit 125 and PSTACK_REVIEW_REQUIRED before any child starts. Retry the same task operation through native reviewed escalation with the command unchanged. The native reviewer decides whether it runs. Keep verification in this delegate.';
export const SHELL_BOUNDARY_PREFIX =
  "if [ \"${CODEX_SANDBOX-}\" = seatbelt ]; then printf '%s\\n' 'PSTACK_REVIEW_REQUIRED: No command started. Retry the same task operation through native reviewed escalation with the command unchanged. The native reviewer decides whether it runs.' >&2; exit 125; fi\n";

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function classifyScope({
  platform,
  externalWorker = false,
  mode,
  nativeRoles = [],
  agentType,
}) {
  if (platform !== 'darwin') return 'out-of-scope';
  if (mode === 'native' && externalWorker) return 'out-of-scope';
  if (mode === 'external' || externalWorker) return 'external-worker';
  if (!agentType || !nativeRoles.includes(agentType))
    return 'out-of-scope';
  return 'registered-native-worker';
}

export function rewriteCommand(command) {
  return command.startsWith(SHELL_BOUNDARY_PREFIX)
    ? command
    : SHELL_BOUNDARY_PREFIX + command;
}

function validateInput(input) {
  if (!object(input)) throw new Error('Hook input must be an object.');
  if (
    input.hook_event_name !== undefined &&
    input.hook_event_name !== 'PreToolUse'
  )
    throw new Error('Hook input must describe PreToolUse.');
  if (input.tool_name !== 'Bash')
    throw new Error('Hook input tool_name must be Bash.');
  if (!object(input.tool_input) || typeof input.tool_input.command !== 'string')
    throw new Error('Hook input requires a string tool_input.command.');
  if (
    input.agent_type !== undefined &&
    input.agent_type !== null &&
    typeof input.agent_type !== 'string'
  )
    throw new Error('Hook input agent_type must be a string when supplied.');
}

export function shellBoundaryOutput(input, options = {}) {
  validateInput(input);
  const scope = classifyScope({
    platform: options.platform ?? process.platform,
    externalWorker: options.externalWorker,
    mode: options.mode,
    nativeRoles: options.nativeRoles,
    agentType: input.agent_type,
  });
  if (scope === 'out-of-scope') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input.tool_input,
        command: rewriteCommand(input.tool_input.command),
      },
      additionalContext: SHELL_BOUNDARY_CONTEXT,
    },
  };
}

export async function runShellBoundary(binding) {
  try {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    process.stdout.write(
      `${JSON.stringify(shellBoundaryOutput(input, {
        ...binding,
        externalWorker: process.env.PSTACK_CODEX_WORKER === '1',
      }))}\n`,
    );
  } catch (error) {
    process.stderr.write(`PSTACK_SHELL_BOUNDARY: ${error.message}\n`);
    process.exitCode = 2;
  }
}
