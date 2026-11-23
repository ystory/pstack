// Shared worker runner runtime. Redaction, the child environment, and the
// supervised spawn follow Orca 84f67831; see each section for its source.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOP_KINDS = [
  'completed',
  'interrupted',
  'error',
  'permission',
  'not-started',
];
export const STOP_CODES = [
  'completed',
  'signal',
  'deadline',
  'usage-limit',
  'not-signed-in',
  'model-unavailable',
  'provider',
  'missing-session',
  'permission-mode',
  'permission-denied',
  'unsupported-auth',
  'failed',
];
export const EVENT_TYPES = ['started', 'activity', 'turn-completed', 'stopped'];

// Orca src/shared/observability/redactor.ts and credential-assignment-redaction.ts.
const PROVIDER_PATTERNS = [
  { tag: 'anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { tag: 'openai-key', re: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { tag: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: 'github-token', re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { tag: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  {
    tag: 'aws-secret-access-key',
    re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi,
  },
  {
    tag: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { tag: 'slack-token', re: /xox[baprsoe]-[A-Za-z0-9-]{10,}/g },
  {
    tag: 'pem',
    re: /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|(?![\s\S]))/g,
  },
];
const STANDALONE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g;
// A whole multiline .env value, including one that starts on the next line.
const ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/my;
const WHITESPACE_RUN = /\s*/y;
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const CREDENTIAL_ASSIGNMENT =
  /(?<![\w-])(?:\\?["'])?([\w-]+)(?:\\?["'])?\s*[:=]\s*/g;
const CREDENTIAL_NAME =
  /(?:apikey|token|secret|password|bearer|authorization|privkey|privatekey|secretkey)$/i;
const BARE_CREDENTIAL_NAME =
  /^(?:api[-_]?key|token|secret|password|bearer|authorization)$/i;
const AUTH_SCHEME = /(?:Basic|Bearer|Token)[^\S\r\n\u2028\u2029]+/iy;
const LINE_END = /[\r\n\u2028\u2029]/;
// Structured keys whose unlabeled values no string rule can classify.
const CREDENTIAL_KEYS = new Set([
  'env',
  'environment',
  'env_vars',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'bearer',
  'cookie',
  'password',
  'set-cookie',
  'secret',
  'token',
  'proxy-authorization',
  'headers.authorization',
]);
// Orca worker-terminal-redaction.ts: an Orca dispatch capability, which a
// worker started from an Orca terminal can echo.
const DISPATCH_CAPABILITY = /\bdcap_[A-Za-z0-9_-]{20,}\b/g;

function credentialValueSpan(input, start) {
  const escaped = input[start] === '\\' && /["']/.test(input[start + 1] ?? '');
  const quote = input[start + (escaped ? 1 : 0)];
  if (quote !== '"' && quote !== "'") {
    AUTH_SCHEME.lastIndex = start;
    let end = AUTH_SCHEME.test(input) ? AUTH_SCHEME.lastIndex : start;
    while (end < input.length && !/\s/.test(input[end])) end++;
    return { end, quoteSize: 0, closed: false };
  }
  const quoteSize = escaped ? 2 : 1;
  let end = start + quoteSize;
  while (end < input.length && !LINE_END.test(input[end])) {
    let slashes = 0;
    while (input[end] === '\\') {
      slashes++;
      end++;
    }
    if (
      input[end] === quote &&
      (escaped ? slashes % 4 === 1 : slashes % 2 === 0)
    )
      return { end: end + 1, quoteSize, closed: true };
    if (end < input.length && !LINE_END.test(input[end])) end++;
  }
  return { end, quoteSize, closed: false };
}

function redactCredentialAssignments(input) {
  const parts = [];
  let copiedThrough = 0;
  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (
    let match = CREDENTIAL_ASSIGNMENT.exec(input);
    match;
    match = CREDENTIAL_ASSIGNMENT.exec(input)
  ) {
    if (!CREDENTIAL_NAME.test(match[1].replace(/[-_]/g, ''))) continue;
    const start = CREDENTIAL_ASSIGNMENT.lastIndex;
    const span = credentialValueSpan(input, start);
    const quote = input.slice(start, start + span.quoteSize);
    const preserveLabel = !BARE_CREDENTIAL_NAME.test(match[1]);
    parts.push(
      input.slice(copiedThrough, match.index),
      preserveLabel ? input.slice(match.index, start) + quote : '',
      '[redacted:labeled-kv]',
      preserveLabel && span.closed ? quote : '',
    );
    copiedThrough = span.end;
    CREDENTIAL_ASSIGNMENT.lastIndex = span.end;
  }
  if (parts.length === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join('');
}

function skipWhitespace(input, index) {
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) index++;
    else if (code < 0x80) return index;
    else {
      WHITESPACE_RUN.lastIndex = index;
      WHITESPACE_RUN.test(input);
      if (WHITESPACE_RUN.lastIndex === index) return index;
      index = WHITESPACE_RUN.lastIndex;
    }
  }
  return index;
}

function redactEnvironmentLines(input) {
  const parts = [];
  let copiedThrough = 0;
  let start = 0;
  // Each terminator kind is searched once per occurrence; -2 is unsearched, -1 exhausted.
  const nextTerminator = [-2, -2, -2, -2];
  while (start < input.length) {
    const content = skipWhitespace(input, start);
    if (content === input.length) break;
    const code = input.charCodeAt(content);
    if ((code >= 0x41 && code <= 0x5a) || code === 0x5f) {
      ENV_LINE.lastIndex = start;
      const match = ENV_LINE.exec(input);
      if (match) {
        parts.push(
          input.slice(copiedThrough, start),
          `${match[1]}=[redacted:env-value]`,
        );
        copiedThrough = ENV_LINE.lastIndex;
        start = copiedThrough + 1;
        continue;
      }
    }
    let terminator = -1;
    for (let kind = 0; kind < LINE_TERMINATORS.length; kind++) {
      let next = nextTerminator[kind];
      if (next !== -1 && next < content) {
        next = input.indexOf(LINE_TERMINATORS[kind], content);
        nextTerminator[kind] = next;
      }
      if (next !== -1 && (terminator === -1 || next < terminator))
        terminator = next;
    }
    if (terminator === -1) break;
    start = terminator + 1;
  }
  if (parts.length === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join('');
}

function redactString(input) {
  let out = input.replace(DISPATCH_CAPABILITY, '[dispatch capability redacted]');
  for (const { tag, re } of PROVIDER_PATTERNS)
    out = out.replace(re, `[redacted:${tag}]`);
  out = redactCredentialAssignments(out).replace(
    STANDALONE_BEARER,
    '[redacted:labeled-kv]',
  );
  out = out.replace(URL_USERINFO, '$1[redacted]@');
  return redactEnvironmentLines(out);
}

function credentialKey(key) {
  const lower = key.toLowerCase();
  return (
    CREDENTIAL_KEYS.has(lower) ||
    /\b(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)\b/i.test(
      key,
    ) ||
    /(apikey|token|secret|password|authorization|bearer|privkey|privatekey)/.test(
      lower.replace(/[^a-z0-9]+/g, ''),
    )
  );
}

// Orca worker-turn-stop-wording.ts: a provider's stderr can be long, and its end names the failure.
export function redact(text, max = 2000) {
  const masked = redactString(String(text));
  return masked.length > max ? `…${masked.slice(-(max - 1))}` : masked;
}

/** Orca redactValue: a structured error, such as an RPC error object, with its
 * strings redacted and every credential-named key dropped. */
export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !credentialKey(key))
      .map(([key, entry]) => [key, redactValue(entry, seen)]),
  );
}

function eventText(text, max = 200) {
  const line = redactString(String(text)).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function stopRecord({ kind, code, cause, continuable }) {
  if (!STOP_KINDS.includes(kind))
    throw new TypeError(`Unknown stop kind ${kind}.`);
  if (!STOP_CODES.includes(code))
    throw new TypeError(`Unknown stop code ${code}.`);
  return { kind, code, cause: redact(cause), continuable };
}

// Orca src/shared/agent-launch/startup/parent-agent-session-env.ts: the launching
// session's identity, messaging access and runtime selection stay with that session.
export const PARENT_AGENT_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_VERSION',
  'CODEX_CI',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS',
  'CODEX_PLUGIN_METRICS_OUTPUT',
  'CODEX_WINDOWS_REGISTERED_CORE',
];

export function childEnv(base, executor) {
  const env = { ...base };
  for (const key of PARENT_AGENT_SESSION_ENV_KEYS) delete env[key];
  // Orca antigravity-acp-launch-spec.ts: an inherited Gemini key switches agy to
  // key auth, and the background updater can replace agy mid-run.
  if (executor === 'antigravity') {
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  }
  return env;
}

export function stateHome(env = process.env) {
  if (env.PSTACK_STATE_HOME) return path.resolve(env.PSTACK_STATE_HOME);
  return path.join(
    env.XDG_STATE_HOME
      ? path.resolve(env.XDG_STATE_HOME)
      : path.join(os.homedir(), '.local/state'),
    'pstack',
  );
}

// Events are best effort: the run's own artifacts keep its full trace.
export function appendEvent(runDir, type, text, fields = {}) {
  if (!EVENT_TYPES.includes(type))
    throw new TypeError(`Unknown event type ${type}.`);
  try {
    appendFileSync(
      path.join(runDir, 'events.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), type, text: eventText(text), ...fields })}\n`,
    );
  } catch {}
}

/** Writes the whole file under a temporary name and links it into place, so a
 * reader sees all of it or nothing and an existing file is never replaced. */
export function writeOnce(file, text, mode = 0o666) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    linkSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

// Each run owns one registry file, written once, so concurrent runners never share a writer.
export function registerRun(
  { runDir, executor, model, effort = null, cwd, label = null, pid },
  env = process.env,
) {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const entry = {
    runId: `${stamp}-${randomBytes(4).toString('hex')}`,
    runDir,
    executor,
    model,
    effort,
    cwd,
    label,
    pid,
    startedAt,
  };
  const runs = path.join(stateHome(env), 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  writeOnce(
    path.join(runs, `${entry.runId}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
    0o600,
  );
  return entry;
}

/** Registers the run and opens its event log. Both are best effort, so the worker
 * runs anyway; the result is the receipt's registry record, { runId } or { error }. */
export function startRun(run, ids = {}, env = process.env) {
  const fields = {
    runDir: run.runDir,
    executor: run.executor,
    model: run.model,
    effort: run.effort ?? null,
    cwd: run.cwd,
    label: run.label ?? null,
    pid: process.pid,
  };
  let registry;
  try {
    registry = { runId: registerRun(fields, env).runId };
  } catch (error) {
    registry = { error: error.message };
  }
  appendEvent(
    run.runDir,
    'started',
    `started ${run.executor} ${run.model}${fields.label ? `: ${fields.label}` : ''}`,
    { ...fields, ...ids },
  );
  return registry;
}

export function recordActivity(runDir, text) {
  appendEvent(runDir, 'activity', text);
}

/** The CLI ended a turn; status is its own word for how, such as completed or SUCCESS. */
export function turnCompleted(runDir, status) {
  appendEvent(runDir, 'turn-completed', 'turn completed', {
    status: status ?? null,
  });
}

export function stopRun(runDir, stop) {
  appendEvent(runDir, 'stopped', `stopped: ${stop.kind} (${stop.code})`, {
    kind: stop.kind,
    code: stop.code,
  });
}

// Orca provider-process-supervisor.ts and provider-process-close.ts.
/** Time the provider gets to exit on its own after its stdin ends, before SIGTERM. */
export const STDIN_END_GRACE_MS = 1_000;
/** Time the provider group gets to flush and exit after SIGTERM, before SIGKILL. */
export const SIGTERM_GRACE_MS = 3_000;
/** Bound kernel kill completion, so a process stuck on a hung drive cannot hang the stop. */
export const GROUP_REAP_TIMEOUT_MS = 1_500;
/** Longest the owner waits, after the supervisor exits, for the provider's output pipes to close. */
export const OUTPUT_DRAIN_TIMEOUT_MS = 1_000;
/** The owner waits out the supervisor's whole ladder before forcing the group itself. */
export const SUPERVISOR_MAX_STOP_MS =
  STDIN_END_GRACE_MS +
  SIGTERM_GRACE_MS +
  GROUP_REAP_TIMEOUT_MS +
  OUTPUT_DRAIN_TIMEOUT_MS;
const FORCED_EXIT_MS = 1_000;
// User Node startup options belong to the provider, not the supervisor.
const PROVIDER_ONLY_NODE_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
];
const SUPERVISOR = fileURLToPath(
  new URL('./worker-supervisor.mjs', import.meta.url),
);

const waitFor = (promise, ms) =>
  Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(resolve, ms, false).unref()),
  ]);

/** Behaves like the direct ChildProcess, except that pid and signals are the
 * supervisor's. exit and close carry the provider's own status when the
 * supervisor reported it, and the supervisor's otherwise. */
class SupervisedChild extends EventEmitter {
  #raw;
  #lifetime;
  #spawnError = null;
  #exit = null;
  /** The provider's pid, which is also its process group, once the supervisor reports it. */
  providerPid = null;
  /** Whether the supervisor killed descendants that outlived the provider; null until it reports. */
  descendantsReaped = null;
  stopReason = null;

  constructor(raw, lifetime) {
    super();
    this.#raw = raw;
    this.#lifetime = lifetime;
    this.stdin = raw.stdin;
    this.stdout = raw.stdout;
    this.stderr = raw.stderr;
    raw.on('message', (message) => {
      if (Number.isSafeInteger(message?.providerPid))
        this.providerPid = message.providerPid;
      if (typeof message?.descendantsReaped === 'boolean')
        this.descendantsReaped = message.descendantsReaped;
      if (message?.providerExit)
        this.#emitExit(message.providerExit.code, message.providerExit.signal);
      if (message?.spawnError)
        this.#spawnError = Object.assign(
          new Error(message.spawnError.message),
          { code: message.spawnError.code },
        );
    });
    raw.on('error', (error) => this.emit('error', error));
    // The provider writes to the owner's pipes itself, so a helper outside its
    // group can hold them open. Orca bounds the drain after the provider's exit;
    // here the bound starts when the supervisor exits, after its reap.
    let drain;
    raw.once('exit', () => {
      drain = setTimeout(() => {
        raw.stdout?.destroy();
        raw.stderr?.destroy();
      }, OUTPUT_DRAIN_TIMEOUT_MS);
    });
    // Close follows the IPC channel's close, so every report has arrived by then.
    raw.once('close', (code, signal) => {
      clearTimeout(drain);
      if (this.#spawnError) {
        // A provider that never started looks like Node's own failed spawn.
        const errno = os.constants.errno[this.#spawnError.code];
        this.emit('error', this.#spawnError);
        this.emit('close', errno ? -errno : code, null);
        return;
      }
      this.#emitExit(code, signal);
      this.emit('close', ...this.#exit);
    });
  }

  #emitExit(code, signal) {
    if (this.#exit) return;
    this.#exit = [code, signal];
    this.emit('exit', code, signal);
  }

  get pid() {
    return this.#raw.pid;
  }
  get exitCode() {
    return this.#raw.exitCode;
  }
  get signalCode() {
    return this.#raw.signalCode;
  }
  get killed() {
    return this.#raw.killed;
  }
  kill(signal = 'SIGTERM') {
    return this.#raw.kill(signal);
  }

  /** Ends stdin, then lets the supervisor run its ladder; forces the group only if it outlives it.
   * reason is kept as stopReason; SIGINT, SIGTERM, or SIGHUP is also the signal the supervisor exits with. */
  async stop(reason) {
    this.stopReason ??= reason;
    const raw = this.#raw;
    if (
      raw.pid === undefined ||
      raw.exitCode !== null ||
      raw.signalCode !== null
    )
      return;
    const exited = new Promise((resolve) => raw.once('exit', resolve));
    try {
      raw.stdin?.end();
    } catch {}
    // Only a session reads its stdin end as a close request. The supervisor
    // exits with the signal it received, so a signal reason survives the stop.
    if (this.#lifetime === 'one-shot')
      raw.kill(
        ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(reason) ? reason : 'SIGTERM',
      );
    if (await waitFor(exited, SUPERVISOR_MAX_STOP_MS)) return;
    try {
      if (this.providerPid) process.kill(-this.providerPid, 'SIGKILL');
    } catch {}
    raw.kill('SIGKILL');
    await waitFor(exited, FORCED_EXIT_MS);
  }
}

/**
 * spawn() for a provider CLI, run under worker-supervisor.mjs on POSIX. lifetime
 * 'session' treats the end of stdin as a close request; 'one-shot' treats it as
 * the end of the input, so only stop() or the owner's death stops the provider.
 */
export function spawnSupervised(
  command,
  args,
  { lifetime = 'session', ...options } = {},
) {
  if (process.platform === 'win32') {
    const child = spawn(command, args, options);
    return Object.assign(child, {
      providerPid: child.pid ?? null,
      stopReason: null,
      async stop(reason) {
        child.stopReason ??= reason;
        child.stdin?.end();
        child.kill();
      },
    });
  }
  const {
    cwd = process.cwd(),
    env = process.env,
    stdio = ['pipe', 'pipe', 'pipe'],
  } = options;
  const supervisorEnv = { ...env };
  const nodeEnv = {};
  for (const key of PROVIDER_ONLY_NODE_ENV_KEYS) {
    if (supervisorEnv[key] !== undefined) nodeEnv[key] = supervisorEnv[key];
    delete supervisorEnv[key];
  }
  supervisorEnv.PSTACK_WORKER_SUPERVISOR_SPEC = Buffer.from(
    JSON.stringify({
      cwd,
      ownerPid: process.pid,
      lifetime,
      stdin: stdio[0] === 'ignore' ? 'ignore' : 'pipe',
      stdinEndGraceMs: STDIN_END_GRACE_MS,
      sigtermGraceMs: SIGTERM_GRACE_MS,
      groupReapTimeoutMs: GROUP_REAP_TIMEOUT_MS,
      nodeEnv,
    }),
  ).toString('base64');
  const raw = spawn(process.execPath, [SUPERVISOR, command, ...args], {
    cwd,
    env: supervisorEnv,
    stdio: [stdio[0], stdio[1], stdio[2], 'ipc'],
    detached: true,
  });
  return new SupervisedChild(raw, lifetime);
}
