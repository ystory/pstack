#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  console.log(
    process.env.PI_FIXTURE === 'old-version'
      ? '1.5.1'
      : process.env.PI_FIXTURE === 'bad-version'
        ? 'unknown'
        : '1.5.2',
  );
  process.exit(0);
}
const mode = process.env.PI_FIXTURE ?? 'early';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const resumed = args.includes('--session');
const sessionFile = resumed
  ? value('--session')
  : args.includes('--session-dir')
    ? path.join(value('--session-dir'), 'fixture.jsonl')
    : null;
const saved = resumed
  ? JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\n')[0])
  : null;
let provider = saved?.provider ?? 'one';
let model = saved?.model ?? 'vendor/model';
let thinkingLevel = saved?.thinkingLevel ?? 'off';
const sessionId = saved?.id ?? 'fixture-session';
const state = () => ({
  model: {
    provider,
    id: model,
    apiKey: 'SECRET-MODEL-KEY',
    headers: { Authorization: 'SECRET-AUTH' },
  },
  thinkingLevel,
  sessionId: mode === 'wrong-session' ? 'wrong-id' : sessionId,
  sessionFile,
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
});
const output = (record) => {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (mode === 'split')
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
  else process.stdout.write(bytes);
};
const assistant = (
  stopReason = 'stop',
  text = 'fresh answer\u2028한글',
  extra = {},
) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    stopReason,
    provider: 'physical',
    model: 'actual/model',
    content: text ? [{ type: 'text', text }] : [],
    usage: { input: 2, output: 3, cost: { total: 0.001 } },
    ...extra,
  },
});
const events = () => {
  if (mode === 'premature-exit') process.exit(0);
  if (mode !== 'stale')
    output({
      type: 'message_start',
      message: { role: 'user', content: 'task' },
    });
  if (mode === 'retry') {
    output(assistant('error', '', { errorMessage: 'retry' }));
    output({ type: 'agent_end', willRetry: true });
  }
  if (mode === 'multi-tool') {
    output(assistant('toolUse', ''));
    output({ type: 'tool_execution_end', toolCallId: 'one' });
    output(assistant('toolUse', ''));
    output({ type: 'tool_execution_end', toolCallId: 'two' });
  }
  const reason = ['error', 'length', 'aborted', 'deferred', 'toolUse'].includes(
    mode,
  )
    ? mode
    : 'stop';
  output(
    assistant(
      reason,
      mode === 'empty' || mode === 'toolUse' ? '' : undefined,
      mode === 'error' ? { errorMessage: 'auth failure' } : {},
    ),
  );
  output({ type: 'agent_end', willRetry: false });
  if (mode !== 'no-settle')
    output({ type: 'agent_settled', aborted: mode === 'aborted' });
};
let count = 0;
let prompted = false;
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    const request = JSON.parse(line);
    if (process.env.PI_TRACE)
      fs.appendFileSync(process.env.PI_TRACE, `${JSON.stringify(request)}\n`);
    const respond = (data, success = true) =>
      output({
        type: 'response',
        id: request.id,
        command: request.type,
        success,
        ...(success ? { data } : { error: 'failure with SECRET-AUTH' }),
      });
    if (request.type === 'get_state') {
      if (mode === 'startup-hang' && count++ === 0) return;
      if (mode === 'malformed') {
        process.stdout.write('SECRET-AUTH invalid json\n');
        return;
      }
      if (mode === 'no-lf') {
        process.stdout.write('{"type":"agent_start"}');
        process.exit(0);
      }
      if (mode === 'wrong-id') {
        output({
          type: 'response',
          command: 'get_state',
          id: 'wrong',
          success: true,
          data: state(),
        });
        return;
      }
      if (prompted && mode === 'final-model-change') model = 'substituted';
      if (prompted && mode === 'final-effort-change') thinkingLevel = 'off';
      const observed = state();
      if (prompted && mode === 'final-busy') observed.isStreaming = true;
      respond(observed);
    } else if (request.type === 'get_available_models')
      respond({
        models: ['one', 'two'].map((provider) => ({
          provider,
          id: 'vendor/model',
          apiKey: 'SECRET-MODEL-KEY',
          headers: { Authorization: 'SECRET-AUTH' },
        })),
      });
    else if (request.type === 'set_model') {
      if (mode === 'reject-model') {
        output({
          type: 'response',
          id: request.id,
          command: request.type,
          success: false,
          error: 'Model not found: one/vendor/model',
        });
        return;
      }
      if (mode === 'missing-auth') {
        output({
          type: 'response',
          id: request.id,
          command: request.type,
          success: false,
          error: 'No API key configured for one SECRET-AUTH',
        });
        return;
      }
      provider = request.provider;
      model = mode === 'route-clamp' ? 'substitute' : request.modelId;
      respond(state().model);
    } else if (request.type === 'get_available_thinking_levels')
      respond({
        levels: mode === 'off-only' ? ['off'] : ['off', 'low', 'high'],
      });
    else if (request.type === 'set_thinking_level') {
      if (mode === 'effort-command-hang') return;
      thinkingLevel = mode === 'clamp' ? 'low' : request.level;
      if (mode === 'effort-route-clamp') provider = 'substitute';
      if (resumed)
        fs.appendFileSync(
          sessionFile,
          `${JSON.stringify({ type: 'thinking_level_change', thinkingLevel })}\n`,
        );
      respond();
    } else if (request.type === 'prompt') {
      prompted = true;
      if (sessionFile && mode !== 'lazy') {
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        if (!resumed)
          fs.writeFileSync(
            sessionFile,
            `${JSON.stringify({ type: 'session', id: sessionId, cwd: process.cwd(), provider, model, thinkingLevel })}\n`,
          );
        fs.appendFileSync(
          sessionFile,
          `${JSON.stringify({ type: 'message', message: { role: 'user', content: request.message } })}\n`,
        );
      }
      if (mode === 'handled' || mode === 'queued') {
        respond({ disposition: mode });
        return;
      }
      if (mode === 'ui') {
        respond({ disposition: 'started' });
        output({ type: 'extension_ui_request', id: 'ui', method: 'select' });
        return;
      }
      if (mode === 'hang' || mode === 'descendant' || mode === 'late-success') {
        respond({ disposition: 'started' });
        if (mode === 'descendant') {
          const child = spawn(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            { stdio: 'ignore' },
          );
          if (process.env.PI_CHILD_PID)
            fs.writeFileSync(process.env.PI_CHILD_PID, String(child.pid));
        }
        return;
      }
      if (mode === 'early' || mode === 'retry') {
        events();
        respond({ disposition: 'started' });
      } else {
        respond({ disposition: 'started' });
        setTimeout(events, 1);
      }
    } else if (request.type === 'abort') {
      if (mode === 'late-success') events();
      respond();
    } else respond();
  })
  .on('close', () => {
    if (mode === 'ignore-eof') setInterval(() => {}, 1000);
    else process.exit(0);
  });
