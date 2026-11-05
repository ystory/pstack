import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const claudeHome = (selected) => {
  const home =
    selected ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(os.homedir(), '.claude');
  if (!path.isAbsolute(home))
    throw new Error('Claude home must be an absolute path.');
  return path.resolve(home);
};
export async function inspect(file, directory = false) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${file}`);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw new Error(`Expected ${directory ? 'directory' : 'file'}: ${file}`);
  return stat;
}
export async function snapshot(file) {
  const stat = await inspect(file);
  if (!stat) return undefined;
  const bytes = await fs.readFile(file);
  return { bytes, sha256: hash(bytes), mode: stat.mode & 0o777 };
}
export async function inputJson(file, label) {
  if (!file || !path.isAbsolute(file))
    throw new Error(`${label} requires an absolute file path.`);
  const state = await snapshot(file);
  if (!state) throw new Error(`${label} file is missing: ${file}`);
  try {
    return JSON.parse(state.bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}
export async function unchanged(file, previous) {
  const current = await snapshot(file);
  if (
    (current?.sha256 ?? null) !== (previous?.sha256 ?? null) ||
    current?.mode !== previous?.mode
  )
    throw new Error(`File changed during save: ${file}`);
}
export async function atomicWrite(file, bytes, mode = 0o600) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
export function argumentsFor(
  argv,
  commands,
  valueFlags,
  booleanFlags = ['--dry-run'],
) {
  if (argv[0] === '--help') return { help: true };
  const options = { command: argv[0] };
  if (commands && !commands.includes(options.command))
    throw new Error(`Choose ${commands.join(', ')}.`);
  for (let index = commands ? 1 : 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = flag
      .replace(/^--/, '')
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (flag === '--help' || booleanFlags.includes(flag)) options[key] = true;
    else if (valueFlags.includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--') || options[key] !== undefined)
        throw new Error(`${flag} requires one value.`);
      options[key] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}
export async function run(main) {
  try {
    const result = await main();
    if (result !== undefined)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
