#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stateHome } from './worker-runtime.mjs';

const usage = `Usage: node workers.mjs status [--cwd DIR] [--all] [--json]
       node workers.mjs follow --run-dir DIR

status lists the runs registered for DIR (default: the current directory) and
the directories inside it, or every run with --all, each with its last event.
A run is running while its runner lives without result.json, lost when the
runner died without one, and otherwise its receipt's stop kind.
follow prints each new event of one run and exits when result.json appears,
or with status 1 when the runner died without writing it.`;

const FOLLOW_POLL_MS = 200;
const FOLLOW_START_MS = 30_000;

function parse(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (!['status', 'follow'].includes(command)) throw new Error(usage);
  const options = { command, all: false, json: false };
  const flags = command === 'status' ? ['--all', '--json'] : [];
  const values = command === 'status' ? ['--cwd'] : ['--run-dir'];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (flags.includes(name)) options[name.slice(2)] = true;
    else if (values.includes(name) && args[index + 1] !== undefined)
      options[name === '--cwd' ? 'cwd' : 'runDir'] = path.resolve(
        args[++index],
      );
    else throw new Error(`Unknown argument ${name}.\n${usage}`);
  }
  if (command === 'follow' && !options.runDir)
    throw new Error('follow requires --run-dir.');
  return options;
}

// A live pid we may not signal still exists.
function alive(pid) {
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Runners link a complete receipt into place, so one that does not parse as a
// record is not a receipt; status and follow both judge a run by this.
function readReceipt(runDir) {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'),
    );
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? receipt
      : null;
  } catch {
    return null;
  }
}

function runState(entry) {
  const receipt = readReceipt(entry.runDir);
  if (!receipt)
    return { state: alive(entry.pid) ? 'running' : 'lost', code: null };
  return {
    state: receipt.stop?.kind ?? receipt.status,
    code: receipt.stop?.code ?? null,
  };
}

// The run's last whole event line, read from the end of its event log.
function lastEvent(runDir) {
  let fd;
  try {
    fd = fs.openSync(path.join(runDir, 'events.jsonl'), 'r');
    const { size } = fs.fstatSync(fd);
    const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    const { ts, type, text } = JSON.parse(
      bytes.toString('utf8').trimEnd().split('\n').at(-1),
    );
    return { ts, type, text };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};

function status(options) {
  const runs = path.join(stateHome(), 'runs');
  let names = [];
  try {
    names = fs.readdirSync(runs).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const directory = options.cwd ?? process.cwd();
  const roots = [directory];
  try {
    roots.push(fs.realpathSync(directory));
  } catch {}
  const entries = [];
  for (const name of names.sort()) {
    try {
      entries.push(JSON.parse(fs.readFileSync(path.join(runs, name), 'utf8')));
    } catch (error) {
      // One unreadable entry must not hide the healthy runs.
      console.error(`Skipped registry entry ${name}: ${error.message}`);
    }
  }
  const listed = entries
    .filter(
      (entry) => options.all || roots.some((root) => inside(root, entry.cwd)),
    )
    .map((entry) => ({
      ...entry,
      ...runState(entry),
      lastEvent: lastEvent(entry.runDir),
    }));
  if (options.json) return console.log(JSON.stringify(listed, null, 2));
  if (!listed.length) return console.log('No worker runs.');
  for (const run of listed)
    console.log(
      [
        run.code && run.code !== run.state
          ? `${run.state} (${run.code})`
          : run.state,
        run.executor,
        run.model,
        run.label ?? '-',
        run.lastEvent?.text ?? '-',
        run.runDir,
      ].join('\t'),
    );
}

async function follow({ runDir }) {
  const eventsPath = path.join(runDir, 'events.jsonl');
  const decoder = new StringDecoder('utf8');
  const startBy = Date.now() + FOLLOW_START_MS;
  let offset = 0,
    pending = '',
    pid = null;
  const drain = () => {
    let bytes;
    try {
      bytes = fs.readFileSync(eventsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    pending += decoder.write(bytes.subarray(offset));
    offset = bytes.length;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const event = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (event.type === 'started') pid = event.pid;
      console.log(event.text);
    }
  };
  for (;;) {
    // Runners append their stopped event before result.json, so this drain includes it.
    const finished = readReceipt(runDir) !== null;
    drain();
    if (finished) return 0;
    if (pid === null && Date.now() > startBy) {
      console.error(`No run started in ${runDir}.`);
      return 1;
    }
    if (pid !== null && !alive(pid) && !readReceipt(runDir)) {
      drain();
      console.log(`lost: runner ${pid} exited without result.json`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
}

try {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') console.log(usage);
  else if (options.command === 'status') status(options);
  else process.exitCode = await follow(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
