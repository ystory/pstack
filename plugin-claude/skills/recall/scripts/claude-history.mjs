#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function options(args) {
  const command = args.shift();
  if (!['list', 'read'].includes(command)) throw new Error('Use list or read.');
  const result = { command };
  while (args.length) {
    const key = args.shift();
    if (!['--project', '--claude-home', '--id', '--touching'].includes(key))
      throw new Error(`Unknown option ${key}.`);
    const value = args.shift();
    if (!value || value.startsWith('--'))
      throw new Error(`${key} needs a value.`);
    if (result[key.slice(2)]) throw new Error(`Duplicate option ${key}.`);
    result[key.slice(2)] = value;
  }
  if (!path.isAbsolute(result.project ?? ''))
    throw new Error('--project must be absolute.');
  if (result['claude-home'] && !path.isAbsolute(result['claude-home']))
    throw new Error('--claude-home must be absolute.');
  if (result.command === 'read' && !/^[a-zA-Z0-9_-]+$/.test(result.id ?? ''))
    throw new Error('read needs a session --id.');
  if (result.touching && !path.isAbsolute(result.touching))
    throw new Error('--touching must be absolute.');
  return result;
}

async function physical(directory) {
  return realpath(directory);
}

async function projectDirectories(project) {
  const resolved = await physical(project);
  try {
    const output = execFileSync(
      'git',
      [
        '-C',
        resolved,
        '-c',
        'core.quotePath=false',
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const worktrees = output
      .split('\0')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9));
    return [...new Set(await Promise.all(worktrees.map(physical)))];
  } catch {
    return [resolved];
  }
}

function projectSlug(directory) {
  return directory.replace(/[^a-zA-Z0-9]/g, '-');
}

async function regular(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() ? info : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function records(file) {
  const output = [];
  for (const [index, line] of (await readFile(file, 'utf8'))
    .split('\n')
    .entries()) {
    if (!line.trim()) continue;
    try {
      output.push(JSON.parse(line));
    } catch {
      output.push({ type: 'unparsed-line', lineNumber: index + 1, raw: line });
    }
  }
  return output;
}

async function sessions(home, projects) {
  const found = [];
  for (const project of projects) {
    const directory = path.join(home, 'projects', projectSlug(project));
    try {
      if (
        !(await lstat(directory)).isDirectory() ||
        (await lstat(directory)).isSymbolicLink()
      )
        continue;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name))
        continue;
      const file = path.join(directory, entry.name);
      const info = await regular(file);
      if (!info) continue;
      const rows = await records(file);
      const id = path.basename(entry.name, '.jsonl');
      const owners = new Set();
      let foreign = false;
      for (const row of rows) {
        if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) continue;
        try {
          const owner = await physical(row.cwd);
          if (!projects.includes(owner)) foreign = true;
          owners.add(owner);
        } catch {
          foreign = true;
        }
      }
      if (foreign || !owners.size) continue;
      if (
        rows.some(
          (row) => typeof row.sessionId === 'string' && row.sessionId !== id,
        )
      )
        continue;
      const timestamp = rows.find(
        (row) => typeof row.timestamp === 'string',
      )?.timestamp;
      found.push({
        id,
        file,
        projects: [...owners],
        modified: info.mtime.toISOString(),
        timestamp,
        rows,
      });
    }
  }
  return found.sort(
    (a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id),
  );
}

function metadata(session) {
  const { rows, ...value } = session;
  return value;
}

export async function run(args) {
  const config = options([...args]);
  const home = await physical(
    config['claude-home'] ??
      process.env.CLAUDE_CONFIG_DIR ??
      path.join(homedir(), '.claude'),
  );
  const projects = await projectDirectories(config.project);
  const touching = config.touching
    ? await physical(config.touching)
    : undefined;
  if (touching && !projects.includes(touching))
    throw new Error('--touching is outside the project worktrees.');
  const selected = (await sessions(home, projects)).filter(
    (session) => !touching || session.projects.includes(touching),
  );
  if (config.command === 'list') return selected.map(metadata);
  const session = selected.find((item) => item.id === config.id);
  if (!session) throw new Error('No matching session owned by this project.');
  const subagents = [];
  const parent = path.join(path.dirname(session.file), session.id);
  const directory = path.join(parent, 'subagents');
  try {
    if ((await lstat(parent)).isSymbolicLink())
      throw new Error('Session transcript directory is a symlink.');
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error('Subagent transcript directory is a symlink.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.jsonl') ||
        !(await regular(file))
      )
        continue;
      const rows = await records(file);
      let foreign = false;
      for (const row of rows) {
        if (typeof row.cwd !== 'string') continue;
        try {
          if (!projects.includes(await physical(row.cwd))) foreign = true;
        } catch {
          foreign = true;
        }
      }
      if (!foreign) subagents.push({ file, records: rows });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...metadata(session), records: session.rows, subagents };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await run(process.argv.slice(2));
    if (Array.isArray(result))
      for (const item of result) console.log(JSON.stringify(item));
    else console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
