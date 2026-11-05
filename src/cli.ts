#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { checkUpstream } from './upstream/check.ts';
import { errorMessage } from './upstream/errors.ts';
import { readLock } from './upstream/lock.ts';
import { verifySnapshot } from './upstream/verify.ts';
import {
  buildDistributionArtifact,
  verifyDistributionArtifact,
} from './distribution/products.ts';
import { generatePatch, verifyPatches } from './distribution/patches.ts';
import { createUpstreamCandidate } from './upstream/candidate.ts';
import { readDependencyLock } from './upstream/dependencies.ts';
import path from 'node:path';
import { regenerateCandidatePatches } from './distribution/regenerate.ts';
import { parseTarget, projectTargets } from './distribution/targets.ts';
import {
  readCodexRuntimeLock,
  verifyCodexRuntime,
} from './upstream/runtime.ts';
import { promotePluginArtifact } from './distribution/marketplace.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? '--help';

function selectedProject(options: Record<string, string>): string {
  if (!options['--project']) return projectRoot;
  if (!path.isAbsolute(options['--project']))
    throw new Error('--project must be an absolute path.');
  return options['--project'];
}

function optionsFor(
  names: string[],
  optionalNames: string[] = [],
): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (
      ![...names, ...optionalNames].includes(name) ||
      !value ||
      value.startsWith('--') ||
      options[name]
    )
      throw new Error(
        `Invalid or duplicate option ${name}. Use --help for usage.`,
      );
    options[name] = value;
  }
  for (const name of names)
    if (!options[name]) throw new Error(`Missing ${name}.`);
  return options;
}

try {
  if (
    ['--help', 'verify-upstream', 'check-upstream'].includes(command) &&
    args.length > 1
  )
    throw new Error('Expected one command. Use --help for usage.');
  switch (command) {
    case '--help':
      console.log(
        'pstack maintainer CLI\n\nCommands:\n  verify-upstream  Verify pinned source integrity and manifest version\n  verify-patches [--project ABSOLUTE_DIRECTORY] [--target codex|claude-code|all]\n                  Replay every patch and compare plugin bytes and modes\n  check-upstream   Read public GitHub revisions and report changes\n  build-plugin --output ABSOLUTE_NEW_DIRECTORY [--target codex|claude-code] [--project ABSOLUTE_DIRECTORY] [--marketplace ABSOLUTE_DIRECTORY]\n                  Build and verify; --marketplace then selects the verified child artifact\n  promote-plugin --artifact ABSOLUTE_DIRECTORY --marketplace ABSOLUTE_DIRECTORY\n                  Verify an existing child artifact and select it for the fixed native marketplace\n  verify-plugin --artifact ABSOLUTE_DIRECTORY\n  generate-patch --name NNNN-lowercase-name.patch [--target codex|claude-code] [--paths FILE_OR_DIRECTORY[,..]] [--project ABSOLUTE_DIRECTORY]\n  regenerate-patches --candidate ABSOLUTE_DIRECTORY --output ABSOLUTE_NEW_DIRECTORY\n  upstream-candidate --source ABSOLUTE_GIT_CHECKOUT --revision FULL_SHA --output ABSOLUTE_NEW_DIRECTORY\n  --help           Show this usage\n\nThese commands do not install or activate plugins, skills, or agents. An omitted target selects Codex; all is accepted only for patch verification. Marketplace selection verifies artifact integrity, not Codex runtime compatibility or release approval. Candidates never replace the pinned source.',
      );
      break;
    case 'verify-patches': {
      const options = optionsFor([], ['--project', '--target']);
      const project = selectedProject(options);
      const targets =
        options['--target'] === 'all'
          ? await projectTargets(project)
          : [parseTarget(options['--target'])];
      for (const target of targets) {
        const result = await verifyPatches(project, target);
        console.log(
          `Verified ${target} ${result.patches.length} patches: ${result.files} plugin files match replayed bytes and modes (${result.digest}).`,
        );
      }
      break;
    }
    case 'build-plugin': {
      const options = optionsFor(
        ['--output'],
        ['--project', '--marketplace', '--target'],
      );
      const artifact = await buildDistributionArtifact(
        selectedProject(options),
        options['--output']!,
        parseTarget(options['--target']),
      );
      console.log(
        `Built ${artifact.name} ${artifact.version}: ${options['--output']} (${artifact.treeSha256}).`,
      );
      if (options['--marketplace']) {
        const selected = await promotePluginArtifact(
          options['--output']!,
          options['--marketplace'],
        );
        console.log(
          `Selected ${selected.artifactRoot} for native marketplace ${selected.marketplaceRoot} (${selected.artifact.treeSha256}).`,
        );
      }
      break;
    }
    case 'promote-plugin': {
      const options = optionsFor(['--artifact', '--marketplace']);
      const selected = await promotePluginArtifact(
        options['--artifact']!,
        options['--marketplace']!,
      );
      console.log(
        `Selected ${selected.artifactRoot} for native marketplace ${selected.marketplaceRoot} (${selected.artifact.treeSha256}).`,
      );
      break;
    }
    case 'verify-plugin': {
      const options = optionsFor(['--artifact']);
      const artifact = await verifyDistributionArtifact(options['--artifact']!);
      console.log(
        `Verified ${artifact.name} ${artifact.version}: plugin bytes, modes, identity, and attribution match artifact.json.`,
      );
      break;
    }
    case 'generate-patch': {
      const options = optionsFor(
        ['--name'],
        ['--paths', '--project', '--target'],
      );
      console.log(
        `Recorded ${await generatePatch(selectedProject(options), options['--name']!, options['--paths']?.split(','), parseTarget(options['--target']))}. Run verify-patches before building.`,
      );
      break;
    }
    case 'regenerate-patches': {
      const options = optionsFor(['--candidate', '--output']);
      const result = await regenerateCandidatePatches(
        options['--candidate']!,
        options['--output']!,
      );
      console.log(
        `Regenerated candidate-only patches: ${result.files} files replay exactly (${result.digest}). Review ${options['--output']}/regeneration-report.json before replacing candidate patches. Current pins and series are unchanged.`,
      );
      break;
    }
    case 'upstream-candidate': {
      const options = optionsFor(['--source', '--revision', '--output']);
      const result = await createUpstreamCandidate(
        projectRoot,
        options['--source']!,
        options['--revision']!,
        options['--output']!,
      );
      console.log(
        `Candidate ${result.status}: ${result.output}/candidate-report.json. The pinned source is unchanged.`,
      );
      if (result.status !== 'ready-for-review') process.exitCode = 1;
      break;
    }
    case 'verify-upstream': {
      const result = await verifySnapshot(projectRoot);
      console.log(
        `Verified pstack ${result.version}: snapshot and manifest match upstream.lock.json.`,
      );
      const dependencies = await readDependencyLock(projectRoot);
      if (dependencies)
        console.log(
          `Verified cursor-team-kit selected sources and license: ${dependencies.cursorTeamKit.revision}.`,
        );
      const runtime = await verifyCodexRuntime(projectRoot);
      if (runtime)
        console.log(
          `Verified pinned Codex runtime sources and Apache license: ${runtime.codexRuntime.revision}.`,
        );
      console.log(
        'This verifies source integrity only; runtime compatibility is not established.',
      );
      break;
    }
    case 'check-upstream': {
      const dependencies = await readDependencyLock(projectRoot);
      const runtime = await readCodexRuntimeLock(projectRoot);
      const results = await checkUpstream(await readLock(projectRoot), {
        ...(dependencies ? { dependencies } : {}),
        ...(runtime ? { codexRuntime: runtime } : {}),
      });
      for (const result of results) {
        console.log(`${result.name}\n  pinned: ${result.pinned}`);
        if (result.status === 'failed') {
          console.error(`  check failed: ${result.error}`);
          process.exitCode = 1;
        } else {
          console.log(
            `  remote: ${result.remote}\n  status: ${result.changed ? 'changed' : 'no change'}`,
          );
        }
      }
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
} catch (error) {
  console.error(`Command failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}
