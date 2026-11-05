#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CLAUDE_MODEL,
  CLAUDE_MINIMUM_VERSION,
  CLAUDE_CLI_EFFORTS,
  exactClaudeModel,
  versionAtLeast,
} from './claude-capabilities.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = `Usage:
  node run-claude.mjs detect [--executable /absolute/claude]
  node run-claude.mjs run --cwd /absolute/worktree --run-dir /absolute/local-run \\
    [--model EXACT_MODEL_ID] --effort xhigh --instruction /absolute/AGENTS.md --skill /absolute/SKILL.md \\
    [--role /absolute/role.md] [--resume session-uuid] [--allowed-tool tool] \\
    [--executable /absolute/claude] < task.txt

Repeat --instruction, --skill, and --allowed-tool as needed. --role supplies only
the requested role's Markdown body. Each supplied context file receives an exact
Read allowance. Pass the task's other authorized tool rules with --allowed-tool.
Fresh sessions are the default. Artifacts are saved in --run-dir outside the
plugin; stdout is the result receipt JSON. Dispatchers pass the resolved model.
Legacy direct calls omitting --model retain the bundled Opus default.`;

function parseArguments(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (command !== 'detect' && command !== 'run') throw new Error(USAGE);
  const options = { command, instruction: [], skill: [], allowedTool: [] };
  const names = {
    '--cwd': 'cwd',
    '--run-dir': 'runDir',
    '--effort': 'effort',
    '--model': 'model',
    '--instruction': 'instruction',
    '--skill': 'skill',
    '--role': 'role',
    '--resume': 'resume',
    '--allowed-tool': 'allowedTool',
    '--executable': 'executable',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const name = names[argv[index]];
    const value = argv[index + 1];
    if (!name || !value || value.startsWith('--')) {
      throw new Error(`Expected a supported option and its value.\n${USAGE}`);
    }
    if (command === 'detect' && name !== 'executable') {
      throw new Error('detect accepts only --executable');
    }
    if (Array.isArray(options[name])) options[name].push(value);
    else if (options[name] !== undefined) {
      throw new Error(`${argv[index]} was provided more than once`);
    } else options[name] = value;
  }
  return options;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function contains(directory, target) {
  const relative = path.relative(directory, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function canonicalPath(target) {
  try {
    return await realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(
      await canonicalPath(path.dirname(target)),
      path.basename(target),
    );
  }
}

async function executablePath(requested = 'claude') {
  if (path.isAbsolute(requested)) {
    await access(requested, constants.X_OK);
    return requested;
  }
  if (requested !== 'claude')
    throw new Error('--executable must be an absolute path');
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, requested);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue normal PATH lookup.
    }
  }
  throw new Error('claude was not found on PATH');
}

function cliText(executable, argument) {
  const result = spawnSync(executable, [argument], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `claude ${argument} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function detect(options) {
  const executable = await executablePath(options.executable);
  const versionText = cliText(executable, '--version').trim();
  const version = versionText.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (!version)
    throw new Error(`Unrecognized Claude Code version: ${versionText}`);
  const help = cliText(executable, '--help');
  const requiredOptions = {
    print: help.includes('--print'),
    model: help.includes('--model'),
    effort: help.includes('--effort'),
    outputFormat:
      help.includes('--output-format') && help.includes('stream-json'),
    verbose: help.includes('--verbose'),
    resume: help.includes('--resume'),
  };
  const effortStart = help.indexOf('--effort');
  const effortEnd = help.indexOf('\n  --', effortStart + 1);
  const effortHelp = help.slice(
    effortStart,
    effortEnd === -1 ? undefined : effortEnd,
  );
  const effortSyntax = CLAUDE_CLI_EFFORTS.filter((effort) =>
    new RegExp(`\\b${effort}\\b`).test(effortHelp),
  );
  return {
    executor: 'claude-code',
    executable,
    version,
    minimumVersion: CLAUDE_MINIMUM_VERSION,
    requiredOptions,
    compatible:
      versionAtLeast(version, CLAUDE_MINIMUM_VERSION) &&
      Object.values(requiredOptions).every(Boolean) &&
      effortSyntax.length > 0,
    effortSyntax,
    modelExecutionVerified: false,
  };
}

function markdownBody(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

async function contextFile(file, kind, bodyOnly = false) {
  const absolutePath = absolute(file, `--${kind}`);
  const bytes = await readFile(absolutePath, 'utf8');
  return {
    kind,
    path: absolutePath,
    content: bodyOnly ? markdownBody(bytes) : bytes,
  };
}

async function inputText() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function run(options) {
  const model = exactClaudeModel(options.model ?? DEFAULT_CLAUDE_MODEL);
  const cwd = absolute(options.cwd, '--cwd');
  if (!(await stat(cwd)).isDirectory())
    throw new Error('--cwd must be a directory');
  const runDir = absolute(options.runDir, '--run-dir');
  if (contains(PLUGIN_ROOT, runDir))
    throw new Error('--run-dir must be outside the plugin');
  if (!CLAUDE_CLI_EFFORTS.includes(options.effort))
    throw new Error(`--effort must be one of ${CLAUDE_CLI_EFFORTS.join(', ')}`);
  if (options.instruction.length === 0 || options.skill.length === 0) {
    throw new Error('run requires at least one --instruction and --skill path');
  }
  if (
    options.resume &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.resume,
    )
  ) {
    throw new Error('--resume must be the exact original session UUID');
  }
  const executable = await executablePath(options.executable);
  const context = [];
  for (const file of options.instruction)
    context.push(await contextFile(file, 'instruction'));
  for (const file of options.skill)
    context.push(await contextFile(file, 'skill'));
  if (options.role) context.push(await contextFile(options.role, 'role', true));
  const task = await inputText();
  if (!task.trim()) throw new Error('Supply the task prompt on stdin');
  const prompt = [
    `Working directory: ${cwd}\n\nApply the supplied project and role instructions to the assigned task. Use the supplied skill material for that task.`,
    ...context.map(
      (file) => `## ${file.kind}: ${file.path}\n\n${file.content}`,
    ),
    `## Assigned task\n\n${task}`,
  ].join('\n\n');
  if (contains(await realpath(PLUGIN_ROOT), await canonicalPath(runDir))) {
    throw new Error('--run-dir must be outside the plugin');
  }
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.jsonl');
  const stderrPath = path.join(runDir, 'stderr.log');
  const promptPath = path.join(runDir, 'prompt.txt');
  const requestPath = path.join(runDir, 'request.json');
  const resultPath = path.join(runDir, 'result.json');
  const args = [
    '-p',
    '--model',
    model,
    '--effort',
    options.effort,
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (options.resume) args.push('--resume', options.resume);
  // Claude's absolute file rule adds a slash before the absolute POSIX path.
  const contextTools = context.map(
    ({ path: sourcePath }) => `Read(/${sourcePath.split(path.sep).join('/')})`,
  );
  for (const tool of new Set([...contextTools, ...options.allowedTool])) {
    args.push('--allowedTools', tool);
  }
  const request = {
    executor: 'claude-code',
    executable,
    args,
    cwd,
    model,
    modelSelection: options.model === undefined ? 'legacy-default' : 'explicit',
    reasoningEffort: options.effort,
    resumeSessionId: options.resume ?? null,
    context: context.map(({ kind, path: sourcePath }) => ({
      kind,
      path: sourcePath,
    })),
    startedAt: new Date().toISOString(),
  };
  await writeFile(promptPath, prompt, { flag: 'wx' });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    flag: 'wx',
  });
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  // Open artifacts before starting a process so a reused run directory never overwrites evidence.
  await Promise.all([
    new Promise((resolve, reject) =>
      stdout.once('open', resolve).once('error', reject),
    ),
    new Promise((resolve, reject) =>
      stderr.once('open', resolve).once('error', reject),
    ),
  ]);
  const child = spawn(executable, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let pending = '';
  const decoder = new StringDecoder('utf8');
  let resultEvent = null;
  let sessionId = null;
  let observedModel = null;
  let parseError = null;
  const event = (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (typeof value.session_id === 'string') sessionId = value.session_id;
      if (
        value.type === 'system' &&
        value.subtype === 'init' &&
        typeof value.model === 'string'
      )
        observedModel = value.model;
      if (value.type === 'result') resultEvent = value;
    } catch (error) {
      parseError ??= error.message;
    }
  };
  child.stdout.on('data', (chunk) => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      event(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  let stdinError = null;
  child.stdin.on('error', (error) => {
    stdinError = error.message;
  });
  child.stdin.end(prompt);
  const forwardSignal = (signal) => child.kill(signal);
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error.message;
  });
  const completion = await new Promise((resolve) =>
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal })),
  );
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  pending += decoder.end();
  if (pending) event(pending);
  await Promise.all([finished(stdout), finished(stderr)]);
  const receipt = {
    ...request,
    pid: child.pid ?? null,
    ...completion,
    sessionId,
    observedModel,
    result: typeof resultEvent?.result === 'string' ? resultEvent.result : null,
    resultEvent,
    spawnError,
    stdinError,
    parseError,
    completedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    promptPath,
    requestPath,
    resultPath,
  };
  await writeFile(resultPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(JSON.stringify(receipt));
  process.exitCode =
    (completion.exitCode >= 0 ? completion.exitCode : null) ??
    (completion.signal === 'SIGINT'
      ? 130
      : completion.signal === 'SIGTERM'
        ? 143
        : 1);
  if (process.exitCode === 0 && (parseError || !resultEvent))
    process.exitCode = 1;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') console.log(USAGE);
  else if (options.command === 'detect') {
    const receipt = await detect(options);
    console.log(JSON.stringify(receipt));
    if (!receipt.compatible) process.exitCode = 1;
  } else await run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
