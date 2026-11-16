import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Entry = {
  executor: 'antigravity';
  model: string;
  reasoningEffort: string;
};
type Receipt = {
  status: string;
  error: string | null;
  requested: Entry;
  cwd: string;
  authMode: string;
  observedModel: string | null;
  effectiveEffort: null;
  result: string;
  conversationId: string;
  init: { conversation_id: string; init: { model: string; cwd: string } };
  terminalResult: {
    status: string;
    conversation_id: string;
    num_turns: number;
    response: string;
    usage: unknown;
  };
  usage: { scope: string; source: string; value: unknown };
  process: {
    exitCode: number | null;
    signal: string | null;
    closed: boolean;
    groupClosed: boolean;
    shutdown: string;
  };
  inputSent: boolean;
  identityBeforeInput: boolean;
  stdoutPath: string;
  resultPath: string;
  finalPath: string;
};
type ToolEvent = {
  event?: string;
  step_update?: {
    step_type?: string;
    state?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: unknown;
    };
  };
};

const usage = `Usage: node scripts/check-agy-live.ts --evidence-dir ABS_NEW --fresh-runner ABS --resume-runner ABS --model EXACT_ID --effort LEVEL --inherited-auth gemini-api-key|adc|inherited-default [--executable ABS] [--timeout-ms N]`;
const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const flags = new Set([
  '--evidence-dir',
  '--fresh-runner',
  '--resume-runner',
  '--model',
  '--effort',
  '--inherited-auth',
  '--executable',
  '--timeout-ms',
]);
const options: Record<string, string> = {};
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index];
  const value = argv[index + 1];
  assert.ok(
    flag &&
      flags.has(flag) &&
      value &&
      !value.startsWith('--') &&
      options[flag] === undefined,
    usage,
  );
  options[flag] = value;
}
for (const flag of [
  '--evidence-dir',
  '--fresh-runner',
  '--resume-runner',
  '--model',
  '--effort',
  '--inherited-auth',
])
  assert.ok(options[flag], `Required ${flag}. ${usage}`);
for (const flag of [
  '--evidence-dir',
  '--fresh-runner',
  '--resume-runner',
  '--executable',
])
  if (options[flag] !== undefined)
    assert.ok(path.isAbsolute(options[flag]!), `${flag} must be absolute.`);
assert.ok(
  ['gemini-api-key', 'adc', 'inherited-default'].includes(
    options['--inherited-auth']!,
  ),
  '--inherited-auth must acknowledge an already-authorized inherited method.',
);
const timeoutMs = Number(options['--timeout-ms'] ?? '120000');
assert.ok(
  Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000,
  '--timeout-ms must be between 1000 and 300000.',
);
const freshRunner = await fs.realpath(options['--fresh-runner']!);
const resumeRunner = await fs.realpath(options['--resume-runner']!);
for (const runner of [freshRunner, resumeRunner])
  assert.ok(
    (await fs.stat(runner)).isFile(),
    'Runner paths must identify files.',
  );
const runnerHashes = await Promise.all(
  [freshRunner, resumeRunner].map(async (file) => ({
    file,
    sha256: hash(await fs.readFile(file)),
  })),
);
assert.equal(
  runnerHashes[0]!.sha256,
  runnerHashes[1]!.sha256,
  'Both final runner copies must have identical bytes.',
);
const { agyEntry, inheritedAgyAuth } = await import(
  pathToFileURL(path.join(path.dirname(freshRunner), 'agy-capabilities.mjs'))
    .href
);
const auth = await inheritedAgyAuth();
const authMode: string = auth.method;
assert.equal(
  options['--inherited-auth'],
  authMode,
  'The inherited agy settings and environment must match the acknowledged method.',
);
const entry: Entry = agyEntry({
  executor: 'antigravity',
  model: options['--model'],
  reasoningEffort: options['--effort'],
});
const requestedEvidence = path.resolve(options['--evidence-dir']!);
const evidence = path.join(
  await fs.realpath(path.dirname(requestedEvidence)),
  path.basename(requestedEvidence),
);
await fs.mkdir(evidence, { mode: 0o700 });
const workspace = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'pstack-agy-live-')),
);
const pointer = path.join(workspace, 'pointer.txt');
const markerFile = path.join(
  workspace,
  `marker-${randomBytes(12).toString('hex')}.txt`,
);
const marker = `PSTACK_AGY_LIVE_${randomBytes(24).toString('hex')}`;
const pointerContents = `${markerFile}\n`;
await fs.writeFile(pointer, pointerContents, { mode: 0o600 });
await fs.writeFile(markerFile, marker, { mode: 0o600 });
const preferenceFiles = [
  ...new Set([
    path.join(os.homedir(), '.codex', 'pstack-codex', 'models.json'),
    path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      'pstack-codex',
      'models.json',
    ),
    path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
      'pstack-cc',
      'models.json',
    ),
  ]),
];
async function preferenceHashes() {
  return Promise.all(
    preferenceFiles.map(async (file) => {
      try {
        return { file, sha256: hash(await fs.readFile(file)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { file, sha256: null };
        throw error;
      }
    }),
  );
}
const preferencesBefore = await preferenceHashes();
const summary: Record<string, unknown> = {
  scope: 'direct-official-agy-runner',
  nativeHostVerified: false,
  workspace,
  pointer,
  markerFile,
  markerSha256: hash(marker),
  entry,
  auth,
  runnerHashes,
  preferencesBefore,
  timeoutMs,
};
await fs.writeFile(path.join(evidence, 'inputs.json'), json(summary), {
  mode: 0o600,
});

async function launch(runner: string, name: string, args: string[]) {
  const child = spawn(process.execPath, [runner, ...args], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let deadlineExceeded = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 8000);
  };
  const interrupt = () => stop();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    stop();
  }, timeoutMs + 45000);
  child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
  child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
  child.stdin.end();
  let outcome;
  try {
    outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await fs.writeFile(
      path.join(evidence, `${name}-launch.stdout.log`),
      Buffer.concat(stdout),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(evidence, `${name}-launch.stderr.log`),
      Buffer.concat(stderr),
      { mode: 0o600 },
    );
  }
  assert.equal(
    deadlineExceeded,
    false,
    `${name} exceeded the outer runner deadline.`,
  );
  assert.equal(outcome.signal, null, `${name} launcher terminated by signal.`);
  assert.equal(
    outcome.code,
    0,
    `${name} launcher failed. Inspect retained launch logs.`,
  );
  return JSON.parse(Buffer.concat(stdout).toString('utf8'));
}

async function completed(runDirectory: string, emitted: Receipt) {
  const receipt: Receipt = JSON.parse(
    await fs.readFile(path.join(runDirectory, 'result.json'), 'utf8'),
  );
  assert.deepEqual(emitted, receipt, 'Stdout and retained receipt must agree.');
  assert.equal(
    receipt.status,
    'completed',
    receipt.error ?? 'Worker did not complete.',
  );
  assert.equal(receipt.error, null);
  assert.deepEqual(receipt.requested, entry);
  assert.equal(receipt.cwd, workspace);
  assert.equal(receipt.authMode, authMode);
  assert.equal(receipt.observedModel, entry.model);
  assert.equal(receipt.init.init.model, entry.model);
  assert.equal(receipt.init.init.cwd, workspace);
  assert.equal(receipt.init.conversation_id, receipt.conversationId);
  assert.equal(receipt.terminalResult.conversation_id, receipt.conversationId);
  assert.equal(receipt.terminalResult.status, 'SUCCESS');
  assert.equal(
    receipt.effectiveEffort,
    null,
    'Unreported effective effort stays unknown.',
  );
  assert.equal(receipt.inputSent, true);
  assert.equal(receipt.identityBeforeInput, true);
  assert.equal(receipt.process.exitCode, 0);
  assert.equal(receipt.process.signal, null);
  assert.equal(receipt.process.closed, true);
  assert.equal(receipt.process.groupClosed, true);
  assert.equal(receipt.process.shutdown, 'orderly');
  assert.equal(receipt.usage.scope, 'conversation-cumulative');
  assert.equal(receipt.usage.source, 'native-agy-result');
  assert.deepEqual(receipt.usage.value, receipt.terminalResult.usage);
  assert.equal(receipt.terminalResult.response.trim(), marker);
  assert.equal(receipt.result, receipt.terminalResult.response);
  assert.equal(
    await fs.readFile(receipt.finalPath, 'utf8'),
    receipt.terminalResult.response,
  );
  return receipt;
}
async function completedTools(receipt: Receipt) {
  const lines = (await fs.readFile(receipt.stdoutPath, 'utf8'))
    .trim()
    .split('\n');
  return lines
    .map((line) => JSON.parse(line) as ToolEvent)
    .filter(
      (event) =>
        event.event === 'step_update' &&
        event.step_update?.step_type === 'tool' &&
        event.step_update.state === 'DONE',
    );
}
function readEvent(event: ToolEvent, file: string, contents: string) {
  const step = event.step_update!;
  const info = step.tool_info;
  const output =
    typeof info?.output === 'string'
      ? info.output
      : JSON.stringify(info?.output ?? '');
  const reportedBytes = /\b(\d+)\s+bytes?\b/.exec(output)?.[1];
  return (
    ['view_file', 'sed_file', 'read_file'].includes(
      step.tool_name ?? info?.name ?? '',
    ) &&
    !info?.error &&
    JSON.stringify(info?.parameters ?? '').includes(file) &&
    (output.includes(contents.trim()) ||
      (reportedBytes !== undefined &&
        Number(reportedBytes) === Buffer.byteLength(contents)))
  );
}
const executable = options['--executable']
  ? ['--executable', options['--executable']!]
  : [];
try {
  const detection = await launch(freshRunner, 'detect', [
    'detect',
    ...executable,
  ]);
  assert.equal(detection.executor, 'antigravity');
  assert.equal(detection.available, true);
  assert.equal(detection.compatible, true);
  assert.deepEqual(detection.auth, auth);
  assert.equal(detection.modelExecutionVerified, false);
  summary.detection = detection;
  const freshDirectory = path.join(evidence, 'fresh');
  const freshPrompt = path.join(evidence, 'fresh-task.txt');
  await fs.writeFile(
    freshPrompt,
    `Use the native file-read tool to read ${pointer}. Then use that tool to read the exact file named by the pointer. Reply with exactly that file's contents, with no markup or extra text. Do not use a shell command.`,
    { mode: 0o600 },
  );
  const baseArgs = [
    'run',
    '--cwd',
    workspace,
    '--model',
    entry.model,
    '--effort',
    entry.reasoningEffort,
    '--timeout-ms',
    String(timeoutMs),
    ...executable,
  ];
  const fresh = await completed(
    freshDirectory,
    await launch(freshRunner, 'fresh', [
      ...baseArgs,
      '--run-dir',
      freshDirectory,
      '--prompt-file',
      freshPrompt,
    ]),
  );
  summary.fresh = fresh.resultPath;
  const tools = await completedTools(fresh);
  const pointerIndex = tools.findIndex((event) =>
    readEvent(event, pointer, pointerContents),
  );
  const markerIndex = tools.findIndex((event) =>
    readEvent(event, markerFile, marker),
  );
  assert.ok(
    pointerIndex >= 0 && markerIndex > pointerIndex,
    'Completed native read events must prove the pointer read before the marker read.',
  );
  const resumeDirectory = path.join(evidence, 'resume');
  const resumePrompt = path.join(evidence, 'resume-task.txt');
  await fs.writeFile(
    resumePrompt,
    'Recall the exact marker you returned in the prior turn. Reply with exactly that marker and no extra text. Do not call tools or inspect files.',
    { mode: 0o600 },
  );
  const resumed = await completed(
    resumeDirectory,
    await launch(resumeRunner, 'resume', [
      ...baseArgs,
      '--run-dir',
      resumeDirectory,
      '--prompt-file',
      resumePrompt,
      '--resume',
      fresh.resultPath,
    ]),
  );
  summary.resume = resumed.resultPath;
  assert.equal(resumed.conversationId, fresh.conversationId);
  assert.ok(resumed.terminalResult.num_turns > fresh.terminalResult.num_turns);
  assert.equal(
    (await completedTools(resumed)).length,
    0,
    'Continuation must recall the marker without new tool output.',
  );
  const edge = JSON.parse(
    await fs.readFile(path.join(freshDirectory, 'continued-by.json'), 'utf8'),
  );
  assert.equal(edge.priorReceipt, fresh.resultPath);
  assert.equal(edge.resultPath, resumed.resultPath);
  summary.status = 'completed';
} catch (error) {
  summary.status = 'failed';
  summary.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const preferencesAfter = await preferenceHashes();
  summary.preferencesAfter = preferencesAfter;
  const unchanged =
    JSON.stringify(preferencesAfter) === JSON.stringify(preferencesBefore);
  summary.preferencesUnchanged = unchanged;
  if (!unchanged) summary.status = 'failed';
  await fs.writeFile(path.join(evidence, 'summary.json'), json(summary), {
    mode: 0o600,
  });
  assert.equal(
    unchanged,
    true,
    'Personal pstack preferences changed during direct execution.',
  );
}
console.log(
  json({
    status: summary.status,
    evidence,
    workspace,
    fresh: summary.fresh,
    resume: summary.resume,
    summary: path.join(evidence, 'summary.json'),
  }),
);
