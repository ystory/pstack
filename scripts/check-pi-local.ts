import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.local/pi-local-check');
const executable = process.argv[3];
await fs.mkdir(root, { recursive: false });
const cwd = await fs.realpath(root);
const agent = path.join(cwd, 'synthetic-agent');
await fs.mkdir(agent);
const evidence = {
  alpha: 'LOCAL_ALPHA_914',
  beta: 'LOCAL_BETA_427',
  gamma: 'LOCAL_GAMMA_836',
};
for (const [name, text] of Object.entries(evidence))
  await fs.writeFile(path.join(cwd, name), text);
let phase = 'fresh';
let calls = 0;
let toolsRequested = false;
const requests: unknown[] = [];
let readyToCancel: (() => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({
    phase,
    model: body.model,
    messages: body.messages,
    tools: body.tools?.map(
      (tool: { function?: { name?: string } }) => tool.function?.name,
    ),
  });
  calls += 1;
  if (phase === 'cancel') {
    readyToCancel?.();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta: unknown, finish_reason: string | null = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `local-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (!toolsRequested) {
    toolsRequested = true;
    const files = phase === 'fresh' ? ['alpha', 'beta'] : ['gamma'];
    send({
      role: 'assistant',
      tool_calls: files.map((file, index) => ({
        index,
        id: `read-${phase}-${index}`,
        type: 'function',
        function: {
          name: 'read',
          arguments: JSON.stringify({ path: path.join(cwd, file) }),
        },
      })),
    });
    send({}, 'tool_calls');
  } else {
    const messages = JSON.stringify(body.messages);
    for (const text of phase === 'fresh'
      ? [evidence.alpha, evidence.beta]
      : [evidence.gamma])
      assert.ok(
        messages.includes(text),
        'Pi delivers real read-tool output back to the provider',
      );
    send({
      role: 'assistant',
      content:
        phase === 'fresh'
          ? `LOCAL_RESULT ${evidence.alpha} ${evidence.beta}`
          : `RESUME_RESULT ${evidence.gamma}`,
    });
    send({}, 'stop');
  }
  response.write('data: [DONE]\n\n');
  response.end();
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
await fs.writeFile(
  path.join(agent, 'models.json'),
  JSON.stringify({
    providers: {
      'pstack-local': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'synthetic-local-only',
        models: [
          {
            id: 'synthetic',
            reasoning: false,
            contextWindow: 32768,
            maxTokens: 1024,
          },
        ],
      },
    },
  }),
);
const settings = JSON.stringify({});
await fs.writeFile(path.join(agent, 'settings.json'), settings);
async function run(
  target: string,
  name: string,
  extra: string[] = [],
  cancel = false,
) {
  const command = path.resolve(target, 'skills/poteto-mode/scripts/run-pi.mjs');
  const args = [
    command,
    'run',
    '--cwd',
    cwd,
    '--run-dir',
    path.join(cwd, name),
    ...(executable ? ['--executable', path.resolve(executable)] : []),
    '--provider',
    'pstack-local',
    '--model',
    'synthetic',
    '--effort',
    'off',
    '--tools',
    'read',
    '--timeout-ms',
    '15000',
    ...extra,
  ];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(
    `Use the assigned read tools for the ${phase} task and report the result.`,
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  if (cancel) readyToCancel = () => child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  assert.ok(stdout, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(
    receipt.status,
    cancel ? 'interrupted' : 'completed',
    JSON.stringify(receipt.rejection),
  );
  assert.equal(code, cancel ? 130 : 0, stderr);
  assert.equal(receipt.process.shutdown, 'orderly');
  assert.deepEqual(receipt.observedAssistant, {
    provider: 'pstack-local',
    model: 'synthetic',
  });
  assert.equal(
    await fs.readFile(path.join(agent, 'settings.json'), 'utf8'),
    settings,
    'RPC selection leaves startup defaults unchanged',
  );
  return receipt;
}
const receipts = [];
try {
  for (const target of ['plugin', 'plugin-claude']) {
    phase = 'fresh';
    toolsRequested = false;
    const fresh = await run(target, `${target}-fresh`);
    assert.equal(
      fresh.result,
      `LOCAL_RESULT ${evidence.alpha} ${evidence.beta}`,
    );
    phase = 'resume';
    toolsRequested = false;
    const resumed = await run(target, `${target}-resume`, [
      '--resume',
      fresh.artifacts.result,
    ]);
    assert.equal(resumed.session.id, fresh.session.id);
    assert.equal(resumed.result, `RESUME_RESULT ${evidence.gamma}`);
    receipts.push(fresh, resumed);
  }
  phase = 'cancel';
  const cancelled = await run('plugin', 'cancel', [], true);
  receipts.push(cancelled);
  assert.equal(cancelled.resumability.available, true);
  phase = 'resume';
  toolsRequested = false;
  receipts.push(
    await run('plugin', 'cancel-resume', [
      '--resume',
      cancelled.artifacts.result,
    ]),
  );
  await fs.writeFile(
    path.join(cwd, 'provider-requests.json'),
    `${JSON.stringify(requests, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(cwd, 'summary.json'),
    `${JSON.stringify({ synthetic: true, providerCompatibilityVerified: false, receipts: receipts.map((receipt) => ({ status: receipt.status, result: receipt.result, resultPath: receipt.artifacts.result, session: receipt.session, process: receipt.process })) }, null, 2)}\n`,
  );
  console.log(
    `Verified installed Pi against the local synthetic provider. Evidence ${cwd}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
