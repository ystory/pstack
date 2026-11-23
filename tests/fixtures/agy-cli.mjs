#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

const args = process.argv.slice(2);
const mode = process.env.AGY_FIXTURE ?? 'normal';
const trace = (value) => {
  if (process.env.AGY_TRACE)
    appendFileSync(process.env.AGY_TRACE, `${JSON.stringify(value)}\n`);
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name) => args[args.indexOf(name) + 1];
const leaveDescendant = () => {
  if (!['draining-descendant', 'lingering-descendant'].includes(mode)) return;
  const descendant = spawn(
    process.execPath,
    [
      '-e',
      mode === 'draining-descendant'
        ? 'setTimeout(() => {}, 400)'
        : 'setInterval(() => {}, 1000)',
    ],
    { stdio: 'ignore' },
  );
  descendant.unref();
  writeFileSync(process.env.AGY_CHILD_PID, String(descendant.pid));
};
trace({
  args,
  cwd: process.cwd(),
  inheritedMarker: process.env.AGY_INHERITED_MARKER,
});
if (['--version', '--help', 'models'].includes(args[0])) {
  if (mode === 'readless' && !fstatSync(0).isCharacterDevice())
    throw new Error('This prompt-free command requires disconnected stdin.');
  if (mode === 'readless' || mode === 'closed-stdin') closeSync(0);
}
if (args[0] === '--version') {
  const write = mode === 'stderr-probes' ? console.error : console.log;
  write(
    mode === 'old-version'
      ? '1.5.7'
      : mode === 'bad-version'
        ? 'unrecognized'
        : '1.5.9',
  );
} else if (args[0] === '--help') {
  const write = mode.startsWith('stderr-') ? console.error : console.log;
  write(
    [
      'Usage: agy [options] [command]',
      '  --model <id>',
      '  --effort <level> low, medium, high, xhigh, max',
      '  --input-format <format> text, stream-json',
      '  --output-format <format> text, json, stream-json',
      '  --conversation <id>',
      ...(mode === 'missing-syntax'
        ? []
        : [
            '  --dangerously-skip-permissions  Auto-approve all tool permission requests',
          ]),
      'Commands:',
      '  models  Show available models',
    ].join('\n'),
  );
  if (mode === 'stderr-help-nonzero') process.exitCode = 7;
  if (mode === 'stderr-help-bad-utf8')
    process.stderr.write(Buffer.from([0xf0, 0x9f]));
} else if (args[0] === 'models') {
  trace({ operation: 'catalog-no-model-prompt' });
  process.stderr.write('native model catalog diagnostic\n');
  if (mode === 'bad-catalog') console.log('invented model table');
  else if (mode === 'duplicate-catalog')
    console.log('model-a\tA (Low)\nmodel-a\tA (Low)');
  else
    console.log(
      '\x1b[32mgemini-4-hydrogen-xhigh\x1b[0m\tGemini 4 Hydrogen (XHigh)\nclaude-fixture-20261115\tClaude Fixture (High)\nunclassified-model\tUnclassified Label\nfixed-standard\tFixed Nonadjustable',
    );
  leaveDescendant();
} else {
  const nativeId = args.includes('--conversation')
    ? option('--conversation')
    : '917f82bf-4fe5-46b9-8c4a-58663982aa01';
  const conversationId =
    mode === 'wrong-resume' ? '11111111-2222-3333-4444-555555555555' : nativeId;
  const init = {
    event: 'init',
    conversation_id: conversationId,
    init: {
      model: mode === 'wrong-model' ? 'gemini-other' : option('--model'),
      cwd: mode === 'wrong-cwd' ? '/wrong-cwd' : process.cwd(),
      tools: ['view_file', 'run_command'],
      permission_mode: 'request-review',
    },
  };
  if (mode === 'closed-task-stdin') {
    closeSync(0);
    emit(init);
    await new Promise(() => setInterval(() => {}, 1000));
  }
  let received = '';
  process.stdin.on('data', (bytes) => {
    received += bytes;
    trace({ received: bytes.toString() });
  });
  if (mode === 'no-init') process.exit(0);
  else if (mode !== 'init-hang') {
    if (mode === 'delayed-init')
      await new Promise((resolve) => setTimeout(resolve, 700));
    emit(init);
  }
  const ending = once(process.stdin, 'end');
  await ending;
  trace({ input: received });
  const event = JSON.parse(received);
  if (event.event !== 'user' || typeof event.message?.content !== 'string')
    throw new Error('Incorrect official user input shape');
  if (mode === 'missing-result') process.exit(0);
  if (mode === 'malformed') {
    process.stdout.write('not-json\n');
    process.exit(0);
  }
  if (mode === 'bad-utf8') {
    process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    process.exit(0);
  }
  if (mode === 'truncated-utf8') {
    process.stdout.write(Buffer.from([0xf0, 0x9f]));
    process.exit(0);
  }
  const update = {
    event: 'step_update',
    step_update: {
      conversation_id: mode === 'wrong-step-id' ? 'wrong' : conversationId,
      step_index: args.includes('--conversation') ? 2 : 0,
      state: 'DONE',
      step_type: 'user_input',
    },
  };
  if (mode !== 'missing-current-input') emit(update);
  if (mode === 'tool-error')
    for (const state of ['ACTIVE', 'ERROR'])
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state,
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: {
            name: 'read_file',
            parameters: { Path: 'app/layout.tsx' },
          },
        },
      });
  const responses = {
    empty: ' \n ',
    'retry-notice':
      '⚠ Model produced invalid output.\n⚠ Model produced invalid output.\nfresh answer 한글 🥔',
    'retry-only': '⚠ Model produced invalid output.\n',
    'failure-notice': '⚠ agent executor error: model request failed\n',
    'rebuild-notice':
      'Agent connection was lost and could not be re-established: Failed to rebuild agent: no session\nretry later',
  };
  const result = {
    event: 'result',
    result: {
      conversation_id: mode === 'wrong-result-id' ? 'wrong' : conversationId,
      status: 'SUCCESS',
      response: responses[mode] ?? 'fresh answer 한글 🥔',
      num_turns: args.includes('--conversation') && mode !== 'stale' ? 2 : 1,
      usage: { input_tokens: 22, output_tokens: 4, total_tokens: 26 },
    },
  };
  if (mode === 'failure') {
    emit({
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: 'DONE',
        step_type: 'error_message',
      },
    });
    Object.assign(result.result, {
      status: 'ERROR',
      response: '',
      error: 'Resource exhausted. Please try again later.',
      finished_reason: 'error',
      usage: {
        input_tokens: 13417,
        output_tokens: 1084,
        thinking_tokens: 725,
        cache_read_tokens: 0,
        total_tokens: 14501,
      },
    });
  }
  if (['recovered-error', 'recovered-error-nonzero'].includes(mode)) {
    emit({
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: 'DONE',
        step_type: 'error_message',
      },
    });
    Object.assign(result.result, {
      status: 'ERROR',
      error: 'API error (attempt 1): Error 429, Status: RESOURCE_EXHAUSTED',
      finished_reason: 'error',
    });
    if (mode === 'recovered-error-nonzero') process.exitCode = 3;
  }
  if (mode === 'error-then-success')
    emit({ event: 'error', error: 'original native failure' });
  if (
    [
      'hang',
      'late-success',
      'descendant',
      'pipe-descendant',
      'slow-cancel',
    ].includes(mode)
  ) {
    let descendant;
    if (mode === 'descendant' || mode === 'pipe-descendant') {
      descendant = spawn(
        process.execPath,
        ['-e', `setInterval(() => process.stdout.write(''), 50)`],
        {
          stdio:
            mode === 'pipe-descendant'
              ? ['ignore', 'inherit', 'inherit']
              : 'ignore',
        },
      );
      writeFileSync(process.env.AGY_CHILD_PID, String(descendant.pid));
    }
    const stop = async (signal) => {
      trace({ stopped: signal, at: Date.now() });
      if (mode === 'slow-cancel' && signal === 'SIGINT') return;
      if (mode === 'late-success') emit(result);
      if (descendant) {
        descendant.kill('SIGTERM');
        await once(descendant, 'close');
      }
      if (mode !== 'late-success') process.exit(0);
    };
    if (mode === 'pipe-descendant') process.exit(0);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    setInterval(() => {}, 1000);
  } else {
    const bytes = Buffer.from(
      `${JSON.stringify(result)}${mode === 'no-newline' ? '' : '\n'}`,
    );
    if (mode === 'split') {
      const split = bytes.indexOf(Buffer.from('🥔')) + 2;
      process.stdout.write(bytes.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(bytes.subarray(split));
    } else process.stdout.write(bytes);
    if (mode === 'duplicate-result') emit(result);
    if (mode === 'late-error')
      emit({ event: 'error', error: 'failure after apparent success' });
    process.stderr.write('native harness diagnostic\n');
    if (mode === 'nonzero') process.exitCode = 7;
    leaveDescendant();
  }
}
