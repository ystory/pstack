// Orca 84f67831 src/main/provider-process/provider-process-supervisor.ts
// (POSIX_PROVIDER_SUPERVISOR_SCRIPT), run as a file. worker-runtime.mjs starts it
// detached; it starts the provider in its own process group and stops that group
// when its owner dies. It reports the provider's pid, or why it never started,
// over the IPC channel.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const spec = JSON.parse(
  Buffer.from(process.env.PSTACK_WORKER_SUPERVISOR_SPEC, 'base64').toString(),
);
const [providerCommand, ...providerArgs] = process.argv.slice(2);
// A detached supervisor is reparented when its owner exits. The new parent may
// be PID 1 or a platform subreaper, so any other parent means no live owner.
const ownerGone = () => process.ppid !== spec.ownerPid;
// Registered before the spawn, so a stop that lands while the provider starts still reaps it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(signal, () => stopProviderGroup(signal));
// The owner can die before this runs; spawning then would start a provider nothing watches.
if (ownerGone()) process.exit(1);
const childEnv = { ...process.env, ...spec.nodeEnv };
delete childEnv.PSTACK_WORKER_SUPERVISOR_SPEC;
const disconnect = () => {
  try {
    process.disconnect();
  } catch {}
};
// The owner sees only this pid's exit; the report says the provider never started.
const exitWithSpawnFailure = (error) => {
  const spawnError = {
    code: error?.code || 'UNKNOWN',
    message: String(error?.message),
  };
  try {
    process.send({ spawnError }, () => process.exit(127));
  } catch {
    process.exit(127);
  }
};
// Children inherit the IPC fd, so /dev/null takes that slot and only this pid holds the channel.
const reportShield = openSync('/dev/null', 'r');
let child;
try {
  child = spawn(providerCommand, providerArgs, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: [spec.stdin, 'pipe', 'pipe', reportShield],
    detached: true,
  });
} catch (error) {
  // Node throws most spawn failures (ENOEXEC, ENOTDIR, ...) rather than emitting them.
  exitWithSpawnFailure(error);
}
try {
  closeSync(reportShield);
} catch {}
// A spawn that failed without a pid reports through its 'error' event below.
if (child?.pid) {
  try {
    process.send({ providerPid: child.pid }, disconnect);
  } catch {
    disconnect();
  }
}
let timer;
let ownerShutdownTimer;
let settling = false;
let providerExited = false;
const providerGroupExists = () => {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH');
  }
};
const waitForProviderGroupExit = async (
  timeoutMs,
  stopWaiting = () => false,
) => {
  const deadline = Date.now() + timeoutMs;
  while (providerGroupExists()) {
    if (Date.now() >= deadline || stopWaiting()) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};
const reapOwnedProviderGroup = async () => {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error && error.code !== 'ESRCH') return false;
  }
  return waitForProviderGroupExit(spec.groupReapTimeoutMs);
};
const finishWithProviderOutcome = (code, signal) => {
  if (!signal) return process.exit(code ?? 1);
  // Re-raise with the default action; this supervisor's own handler would swallow it.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
};
// Every stop is the same: SIGTERM the group, SIGKILL it after its grace, and exit
// only once it is gone. Whoever stops this pid judges the provider by it, so a dead
// supervisor means a dead group.
function stopProviderGroup(receivedSignal) {
  if (settling) return;
  settling = true;
  clearInterval(timer);
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer);
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  // A one-shot's helpers die with it once it has exited; a session's keep the grace to clean up.
  const graceOver = () => spec.lifetime === 'one-shot' && providerExited;
  void waitForProviderGroupExit(spec.sigtermGraceMs, graceOver)
    .then((exited) => exited || reapOwnedProviderGroup())
    .then((reaped) => {
      if (!reaped) return process.exit(1);
      finishWithProviderOutcome(137, receivedSignal);
    });
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return;
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(
    () => stopProviderGroup(null),
    spec.stdinEndGraceMs,
  );
  ownerShutdownTimer.unref();
};
// A one-shot's stdin end is the end of its request, not a stop; only its owner's death stops it.
if (spec.lifetime !== 'one-shot') {
  process.stdin.once('end', scheduleOwnerShutdown);
  process.stdin.once('close', scheduleOwnerShutdown);
}
if (child?.pid) {
  if (child.stdin) {
    process.stdin.pipe(child.stdin);
    // A provider that stops reading must fail the owner's write as a direct pipe would.
    child.stdin.on('error', () => process.stdin.destroy());
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  // A dead owner's stdout pipe raises EPIPE; unhandled, it would end this pid before the group.
  for (const stream of [
    ...(child.stdin ? [process.stdin, child.stdin] : []),
    process.stdout,
    process.stderr,
    child.stdout,
    child.stderr,
  ])
    stream.on('error', () => {});
}
// Exit can land before the provider's last output is relayed; a one-shot's answer is that output.
const drainProviderOutput = () => {
  const ended = (stream) =>
    stream.readableEnded || stream.destroyed
      ? null
      : new Promise((resolve) => {
          stream.once('end', resolve);
          stream.once('close', resolve);
        });
  const flushed = (stream) =>
    new Promise((resolve) => stream.write('', resolve));
  const drained = Promise.all([child.stdout, child.stderr].map(ended)).then(
    () => Promise.all([process.stdout, process.stderr].map(flushed)),
  );
  return Promise.race([
    drained,
    new Promise((resolve) => setTimeout(resolve, spec.outputDrainTimeoutMs)),
  ]);
};
const reapProviderExit = async (code, signal) => {
  if (settling) return;
  settling = true;
  clearInterval(timer);
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer);
  if (!(await reapOwnedProviderGroup())) return process.exit(1);
  await drainProviderOutput();
  finishWithProviderOutcome(code, signal);
};
// An owner that is gone gets the close its owner would have asked for, made here on its behalf.
timer = setInterval(() => {
  if (!ownerGone()) return;
  clearInterval(timer);
  if (child?.stdin) {
    process.stdin.unpipe(child.stdin);
    try {
      child.stdin.end();
    } catch {}
  }
  // A one-shot's stdin end was its request, so only a stop is left to ask for.
  if (spec.lifetime === 'one-shot') return stopProviderGroup(null);
  scheduleOwnerShutdown();
}, 100);
timer.unref();
child?.once('error', (error) => {
  clearInterval(timer);
  exitWithSpawnFailure(error);
});
child?.once('exit', (code, signal) => {
  providerExited = true;
  void reapProviderExit(code, signal);
});
