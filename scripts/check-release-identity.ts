import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkReleaseIdentity } from '../src/distribution/release-identity.ts';

try {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      project: { type: 'string', default: process.cwd() },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.base)
    throw new Error('--base REF is required. No release identity check ran.');
  if (!path.isAbsolute(values.project))
    throw new Error('--project must be an absolute path.');
  const receipt = await checkReleaseIdentity({
    project: values.project,
    base: values.base,
    head: values.head,
  });
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
