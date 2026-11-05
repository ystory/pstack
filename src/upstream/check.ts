import { validateCodexRuntimeLock } from './runtime.ts';
import type { CodexRuntimeLock } from './runtime.ts';
import { validateLock } from './lock.ts';
import type { UpstreamLock } from './lock.ts';
import { errorMessage } from './errors.ts';
import { validateDependencyLock } from './dependencies.ts';
import type { DependencyLock } from './dependencies.ts';

export type UpstreamSource =
  'pstack' | 'codex' | 'cursor-team-kit' | 'codex-runtime';

export interface RevisionComparison {
  name: UpstreamSource;
  pinned: string;
  remote: string;
  changed: boolean;
}

export type UpstreamCheckOutcome =
  | ({ status: 'checked' } & RevisionComparison)
  | { status: 'failed'; name: UpstreamSource; pinned: string; error: string };

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchUpstream = (
  url: string,
  options: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponse>;

export interface CheckOptions {
  fetchImpl?: FetchUpstream;
  timeoutMs?: number;
  dependencies?: DependencyLock;
  codexRuntime?: CodexRuntimeLock;
}

const revisionPattern = /^[0-9a-f]{40}$/;

export function compareRevision(
  name: UpstreamSource,
  pinned: unknown,
  remote: unknown,
): RevisionComparison {
  if (
    typeof pinned !== 'string' ||
    typeof remote !== 'string' ||
    !revisionPattern.test(pinned) ||
    !revisionPattern.test(remote)
  ) {
    throw new Error(
      `Invalid ${name} revision returned or pinned; expected a full commit SHA.`,
    );
  }
  return { name, pinned, remote, changed: pinned !== remote };
}

function readRemoteRevision(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'sha' in payload
    ? payload.sha
    : undefined;
}

export async function checkUpstream(
  lock: UpstreamLock,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    dependencies,
    codexRuntime,
  }: CheckOptions = {},
): Promise<UpstreamCheckOutcome[]> {
  const validatedLock = validateLock(lock);
  const targets: {
    name: UpstreamSource;
    pinned: string;
    url: string;
    revision(payload: unknown): unknown;
  }[] = [
    {
      name: 'pstack',
      pinned: validatedLock.pstack.pathRevision,
      url: 'https://api.github.com/repos/cursor/plugins/commits?sha=main&path=pstack&per_page=1',
      revision: (payload) =>
        Array.isArray(payload) ? readRemoteRevision(payload[0]) : undefined,
    },
    {
      name: 'codex',
      pinned: validatedLock.codex.sourceRevision,
      url: 'https://api.github.com/repos/openai/codex/commits/main',
      revision: readRemoteRevision,
    },
  ];
  if (dependencies) {
    const dependency = validateDependencyLock(dependencies).cursorTeamKit;
    targets.push({
      name: 'cursor-team-kit',
      pinned: dependency.pathRevision,
      url: 'https://api.github.com/repos/cursor/plugins/commits?sha=main&path=cursor-team-kit&per_page=1',
      revision: (payload) =>
        Array.isArray(payload) ? readRemoteRevision(payload[0]) : undefined,
    });
  }
  if (codexRuntime) {
    const runtime = validateCodexRuntimeLock(codexRuntime).codexRuntime;
    targets.push({
      name: 'codex-runtime',
      pinned: runtime.revision,
      url: 'https://api.github.com/repos/openai/codex-plugin-cc/commits/main',
      revision: readRemoteRevision,
    });
  }
  return Promise.all(
    targets.map(async (target) => {
      try {
        const response = await fetchImpl(target.url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'pstack',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
          throw new Error(
            `GitHub returned HTTP ${response.status} for ${target.name}.`,
          );
        return {
          status: 'checked' as const,
          ...compareRevision(
            target.name,
            target.pinned,
            target.revision(await response.json()),
          ),
        };
      } catch (error) {
        return {
          status: 'failed' as const,
          name: target.name,
          pinned: target.pinned,
          error: errorMessage(error),
        };
      }
    }),
  );
}
