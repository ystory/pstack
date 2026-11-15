import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyPristinePlugin } from '../upstream/dependencies.ts';
import {
  applyPatchBytes,
  diffPluginTrees,
  isPatchName,
  parsePatchReference,
  patchFile,
  patchPaths,
  readFileImages,
  sameFileImage,
  verifyPatches,
} from './patches.ts';
import { distributionTarget, projectTargets } from './targets.ts';
import type { TargetId } from './targets.ts';
import { createOutputDirectory, inspectTree, treeDigest } from './tree.ts';

export interface PatchTheme {
  name: string;
  match: RegExp;
}

export interface PatchThemes {
  target: readonly PatchTheme[];
  shared: readonly PatchTheme[];
}

export const pstackThemes: PatchThemes = {
  target: [
    {
      name: 'identity-and-distribution',
      match:
        /^(plugin\.json$|\.cursor-plugin\/|\.claude-plugin\/|README\.md$|PRIVACY\.md$|TERMS\.md$|licenses\/|assets\/)/,
    },
    {
      name: 'agents-and-invocation',
      match: /^(agents\/|skills\/[^/]+\/agents\/)/,
    },
    { name: 'setup-and-models', match: /^skills\/setup-pstack\// },
    {
      name: 'poteto-mode-references-and-scripts',
      match: /^skills\/poteto-mode\/(references|scripts)\//,
    },
    { name: 'poteto-mode-playbooks', match: /^skills\/poteto-mode\// },
    { name: 'workflow-skills', match: /^skills\// },
    { name: 'guides', match: /^docs\// },
    { name: 'vendored-codex-runtime', match: /^vendor\// },
  ],
  shared: [
    { name: 'workflow-bodies', match: /^skills\/(how|no-comments)\// },
    {
      name: 'worker-execution',
      match: /^skills\/poteto-mode\/(references|scripts)\//,
    },
  ],
};

export interface CompactedPatch {
  name: string;
  paths: string[];
}

export interface CompactionReport {
  targets: {
    target: TargetId;
    digest: string;
    originalPatches: number;
    series: CompactedPatch[];
  }[];
}

function groupByTheme(
  files: readonly string[],
  themes: readonly PatchTheme[],
  prefix: string,
): CompactedPatch[] {
  const groups = themes.map((theme, index) => {
    const name = `${prefix}${String(index + 1).padStart(4, '0')}-${theme.name}.patch`;
    if (!isPatchName(name))
      throw new Error(`Theme name cannot name a patch: ${theme.name}`);
    return { name, match: theme.match, paths: [] as string[] };
  });
  for (const file of files) {
    const group = groups.find((entry) => entry.match.test(file));
    if (!group)
      throw new Error(`No ${prefix ? 'shared' : 'target'} theme owns ${file}.`);
    group.paths.push(file);
  }
  return groups
    .filter((group) => group.paths.length)
    .map(({ name, paths }) => ({ name, paths }));
}

async function planTarget(
  projectRoot: string,
  temporary: string,
  target: TargetId,
) {
  const before = await verifyPatches(projectRoot, target);
  const base = path.join(temporary, target);
  await copyPristinePlugin(projectRoot, base, target);
  const final = path.join(
    projectRoot,
    distributionTarget(target).pluginDirectory,
  );
  const diff = await diffPluginTrees(base, final);
  const shared = new Set<string>();
  for (const patch of before.patches)
    if (parsePatchReference(patch.name).scope === 'shared')
      for (const file of patchPaths(
        base,
        await readFile(patchFile(projectRoot, target, patch.name)),
      ))
        shared.add(file);
  return {
    target,
    before,
    base,
    final,
    changed: diff.length ? patchPaths(base, diff) : [],
    shared,
  };
}

export async function compactPatchSeries(
  projectRoot: string,
  output: string,
  themes: PatchThemes = pstackThemes,
): Promise<CompactionReport> {
  if (!path.isAbsolute(output))
    throw new Error('Output must be an absolute path.');
  if (await lstat(output).catch(() => undefined))
    throw new Error(`Output already exists: ${output}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pstack-compact-'));
  try {
    const plans: Awaited<ReturnType<typeof planTarget>>[] = [];
    for (const target of await projectTargets(projectRoot))
      plans.push(await planTarget(projectRoot, temporary, target));

    const sharedPaths = plans[0]!.changed.filter((file) =>
      plans.every(
        (plan) => plan.shared.has(file) && plan.changed.includes(file),
      ),
    );
    for (const plan of plans)
      for (const file of plan.changed)
        if (plan.shared.has(file) && !sharedPaths.includes(file))
          throw new Error(
            `Shared path is changed in ${plan.target} only: ${file}`,
          );
    const images = await Promise.all(
      plans.map(async (plan) => ({
        base: await readFileImages(plan.base, sharedPaths),
        final: await readFileImages(plan.final, sharedPaths),
      })),
    );
    for (const file of sharedPaths)
      for (const image of images)
        if (
          !sameFileImage(image.base.get(file)!, images[0]!.base.get(file)!) ||
          !sameFileImage(image.final.get(file)!, images[0]!.final.get(file)!)
        )
          throw new Error(`Shared path differs between targets: ${file}`);

    const sharedPatches = [];
    for (const patch of groupByTheme(sharedPaths, themes.shared, 'shared/')) {
      const [bytes, ...others] = await Promise.all(
        plans.map((plan) =>
          diffPluginTrees(plan.base, plan.final, patch.paths),
        ),
      );
      if (others.some((other) => !other.equals(bytes!)))
        throw new Error(`${patch.name} differs between targets.`);
      sharedPatches.push({ ...patch, bytes: bytes! });
    }

    const results = [];
    for (const plan of plans) {
      const series = [];
      for (const patch of groupByTheme(
        plan.changed.filter((file) => !sharedPaths.includes(file)),
        themes.target,
        '',
      ))
        series.push({
          ...patch,
          bytes: await diffPluginTrees(plan.base, plan.final, patch.paths),
        });
      series.push(...sharedPatches);
      for (const patch of series) applyPatchBytes(plan.base, patch.bytes);
      if (treeDigest(await inspectTree(plan.base)) !== plan.before.digest)
        throw new Error(
          `Compacted ${plan.target} series does not reproduce the plugin tree.`,
        );
      results.push({ plan, series });
    }

    await createOutputDirectory(output);
    for (const { plan, series } of results) {
      const directory = path.join(
        output,
        distributionTarget(plan.target).patchDirectory,
      );
      await mkdir(directory, { recursive: true });
      for (const patch of series) {
        const file = patchFile(output, plan.target, patch.name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, patch.bytes);
      }
      await writeFile(
        path.join(directory, 'series'),
        series.map((patch) => `${patch.name}\n`).join(''),
      );
    }
    const report: CompactionReport = {
      targets: results.map(({ plan, series }) => ({
        target: plan.target,
        digest: plan.before.digest,
        originalPatches: plan.before.patches.length,
        series: series.map(({ name, paths }) => ({ name, paths })),
      })),
    };
    await writeFile(
      path.join(output, 'compaction-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
