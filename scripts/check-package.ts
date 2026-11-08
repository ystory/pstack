import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree } from '../src/distribution/tree.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pstack-package-test-'),
);

function run(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  // Preserve every declared source byte; npm pack omits nested .gitignore files.
  const staging = path.join(temporaryRoot, 'staging', 'package');
  await mkdir(staging, { recursive: true });
  const sourceMetadata = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  if (
    !Array.isArray(sourceMetadata.files) ||
    sourceMetadata.files.some(
      (file: unknown) =>
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.split('/').includes('..') ||
        /[*?]/.test(file),
    )
  )
    throw new Error(
      'Archive inputs must be explicit relative files or directories.',
    );
  for (const file of ['package.json', ...sourceMetadata.files]) {
    const source = path.join(projectRoot, file);
    const destination = path.join(staging, file);
    const stat = await lstat(source);
    if (stat.isDirectory()) await copyTree(source, destination);
    else if (stat.isFile() && !stat.isSymbolicLink()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else throw new Error(`Unsupported archive input: ${file}`);
  }
  run(
    'tar',
    [
      '-czf',
      path.join(temporaryRoot, 'pstack.tgz'),
      '-C',
      path.dirname(staging),
      'package',
    ],
    temporaryRoot,
  );
  const archives = (await readdir(temporaryRoot)).filter((name) =>
    name.endsWith('.tgz'),
  );
  const archive = archives[0];
  if (archives.length !== 1 || !archive)
    throw new Error('Expected exactly one packed archive.');
  const packageRoot = path.join(temporaryRoot, 'node_modules', 'pstack');
  await mkdir(packageRoot, { recursive: true });
  run(
    'tar',
    [
      '-xzf',
      path.join(temporaryRoot, archive),
      '-C',
      packageRoot,
      '--strip-components',
      '1',
    ],
    temporaryRoot,
  );
  for (const forbidden of ['src', 'tests', 'node_modules']) {
    try {
      await access(path.join(packageRoot, forbidden));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
    throw new Error(`Packed artifact unexpectedly includes ${forbidden}.`);
  }
  const metadata: unknown = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('name' in metadata) ||
    metadata.name !== 'pstack'
  )
    throw new Error('Packed artifact must use the pstack package name.');
  const bin =
    typeof metadata === 'object' && metadata !== null && 'bin' in metadata
      ? metadata.bin
      : undefined;
  const cliPath =
    typeof bin === 'object' &&
    bin !== null &&
    Object.keys(bin).length === 1 &&
    'pstack' in bin
      ? bin['pstack']
      : undefined;
  if (cliPath !== 'dist/cli.js')
    throw new Error('Packed artifact must expose its built maintainer CLI.');
  const output = run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-upstream'],
    temporaryRoot,
  );
  if (!output.includes('snapshot and manifest match upstream.lock.json')) {
    throw new Error(`Packed CLI did not confirm source integrity:\n${output}`);
  }
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-patches', '--target', 'all'],
    temporaryRoot,
  );
  const artifactRoot = path.join(temporaryRoot, 'artifact');
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'build-plugin', '--output', artifactRoot],
    temporaryRoot,
  );
  const verification = run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      artifactRoot,
    ],
    temporaryRoot,
  );
  if (!verification.includes('attribution match artifact.json'))
    throw new Error('Packed CLI did not verify its distributable plugin.');
  const codexHome = path.join(temporaryRoot, 'isolated-codex-home');
  await mkdir(path.join(codexHome, 'agents'), { recursive: true });
  await mkdir(path.join(codexHome, 'pstack-codex'));
  const preservedSettings = '{"userChoice":"preserve"}\n';
  await writeFile(
    path.join(codexHome, 'config.toml'),
    'model = "user-model"\n',
  );
  await writeFile(
    path.join(codexHome, 'pstack-codex', 'models.json'),
    preservedSettings,
  );
  await writeFile(
    path.join(codexHome, 'agents', 'user-agent.toml'),
    'name = "user-agent"\n',
  );
  const registrar = path.join(
    artifactRoot,
    'plugin',
    'skills',
    'setup-pstack',
    'scripts',
    'register-agents.mjs',
  );
  const register = (extra: string[] = []) =>
    run(
      process.execPath,
      [registrar, '--definitions-only', '--codex-home', codexHome, ...extra],
      temporaryRoot,
    );
  register(['--dry-run']);
  register();
  const beforeRegistration = await readFile(
    path.join(codexHome, 'pstack-codex', 'agent-registration.json'),
  );
  register();
  if (
    !(
      await readFile(
        path.join(codexHome, 'pstack-codex', 'agent-registration.json'),
      )
    ).equals(beforeRegistration)
  )
    throw new Error('Repeated setup changed ownership metadata.');
  const manifestFile = path.join(artifactRoot, 'plugin', 'plugin.json');
  const originalManifest = await readFile(manifestFile);
  const originalAgentFile = path.join(
    artifactRoot,
    'plugin',
    'agents',
    'poteto-agent.toml',
  );
  const originalAgent = await readFile(originalAgentFile);
  const fixtureManifest = JSON.parse(originalManifest.toString('utf8'));
  fixtureManifest.version = '0.1.0-lifecycle-test';
  await writeFile(
    manifestFile,
    `${JSON.stringify(fixtureManifest, null, 2)}\n`,
  );
  await writeFile(
    originalAgentFile,
    Buffer.concat([originalAgent, Buffer.from('\n')]),
  );
  register();
  if (
    JSON.parse(
      await readFile(
        path.join(codexHome, 'pstack-codex', 'agent-registration.json'),
        'utf8',
      ),
    ).pluginVersion !== fixtureManifest.version
  )
    throw new Error('Packaged registrar did not record fixture update.');
  await writeFile(manifestFile, originalManifest);
  await writeFile(originalAgentFile, originalAgent);
  register();
  if (
    !(
      await readFile(path.join(codexHome, 'agents', 'poteto-agent.toml'))
    ).equals(originalAgent)
  )
    throw new Error('Prior bundle did not restore its registered agent.');
  register(['--unregister', '--dry-run']);
  register(['--unregister']);
  register(['--unregister']);
  if (
    (await readdir(path.join(codexHome, 'agents'))).join(',') !==
    'user-agent.toml'
  )
    throw new Error('Unregister did not preserve unowned agent files.');
  if (
    (await readFile(
      path.join(codexHome, 'pstack-codex', 'models.json'),
      'utf8',
    )) !== preservedSettings ||
    (await readFile(path.join(codexHome, 'config.toml'), 'utf8')) !==
      'model = "user-model"\n'
  )
    throw new Error('Packaged lifecycle changed user settings.');
  const isolatedModelsHome = path.join(temporaryRoot, 'mixed-model-home');
  const models = JSON.parse(
    run(
      process.execPath,
      [
        path.join(
          artifactRoot,
          'plugin/skills/setup-pstack/scripts/models.mjs',
        ),
        'read',
        '--codex-home',
        isolatedModelsHome,
      ],
      temporaryRoot,
    ),
  );
  if (
    models.config.schemaVersion !== 1 ||
    Object.keys(models.config.roles).length !== 0 ||
    Object.keys(models.proposal.roles).length !== 17 ||
    models.needsChoice.length !== 21 ||
    models.exists !== false ||
    models.sha256 !== null
  )
    throw new Error(
      'Packaged model helper did not preserve fresh unconfigured choices.',
    );
  const unconfiguredPanel = JSON.parse(
    run(
      process.execPath,
      [
        path.join(
          artifactRoot,
          'plugin/skills/setup-pstack/scripts/models.mjs',
        ),
        'resolve',
        '--role',
        'arena runners',
        '--codex-home',
        isolatedModelsHome,
      ],
      temporaryRoot,
    ),
  );
  if (
    unconfiguredPanel.source !== 'unconfigured' ||
    unconfiguredPanel.entries.length !== 2 ||
    !unconfiguredPanel.entries.every(
      (entry: { model: string; executor?: string }) =>
        entry.model === 'inherit-parent' &&
        (entry.executor === undefined || entry.executor === 'codex'),
    )
  )
    throw new Error('Packaged Codex panel lost its two native-parent seats.');
  try {
    await access(isolatedModelsHome);
    throw new Error('Reading packaged choices wrote a model configuration.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const instruction = path.join(temporaryRoot, 'AGENTS.md');
  await writeFile(
    instruction,
    'Apply only the assigned package fixture task.\n',
  );
  const externalStub = path.join(temporaryRoot, 'existing-claude-stub');
  const externalCapture = path.join(temporaryRoot, 'external-argv.json');
  await writeFile(
    externalStub,
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] === '--version') console.log('2.1.300 (Claude Code)');\n` +
      `else if (args[0] === '--help') console.log('--print --model --effort low medium high xhigh max --output-format stream-json --verbose --resume');\n` +
      `else if (args[0] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token'}));\n` +
      `else {\n` +
      `  process.stdin.resume();\n` +
      `  process.stdin.on('end', () => {\n` +
      `    require('node:fs').writeFileSync(${JSON.stringify(externalCapture)}, JSON.stringify(args));\n` +
      `    const index = args.indexOf('--model');\n` +
      `    const model = index < 0 ? null : args[index + 1];\n` +
      `    console.log(JSON.stringify({type:'system',subtype:'init',model,session_id:'00000000-0000-4000-8000-000000000001'}));\n` +
      `    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'packaged external transport received ' + model}));\n` +
      `  });\n` +
      `}\n`,
  );
  await chmod(externalStub, 0o755);
  const runner = JSON.parse(
    run(
      process.execPath,
      [
        path.join(
          artifactRoot,
          'plugin/skills/poteto-mode/scripts/run-claude.mjs',
        ),
        'run',
        '--cwd',
        temporaryRoot,
        '--run-dir',
        path.join(temporaryRoot, 'external-run-evidence'),
        '--model',
        'claude-transport-fixture-20300101',
        '--effort',
        'xhigh',
        '--instruction',
        instruction,
        '--skill',
        path.join(artifactRoot, 'plugin/skills/how/SKILL.md'),
        '--executable',
        externalStub,
      ],
      temporaryRoot,
      'Check the packaged external transport fixture.\n',
    ),
  );
  if (
    runner.exitCode !== 0 ||
    runner.model !== 'claude-transport-fixture-20300101' ||
    runner.observedModel !== 'claude-transport-fixture-20300101' ||
    runner.result !==
      'packaged external transport received claude-transport-fixture-20300101' ||
    !(await readFile(runner.promptPath, 'utf8')).includes(
      'Apply only the assigned package fixture task.',
    )
  )
    throw new Error('Packaged runner did not execute the external stub.');
  const packagedRunner = path.join(
    artifactRoot,
    'plugin/skills/poteto-mode/scripts/run-claude.mjs',
  );
  const packagedModels = path.join(
    artifactRoot,
    'plugin/skills/setup-pstack/scripts/models.mjs',
  );
  const modelCall = (args: string[]) =>
    JSON.parse(
      run(
        process.execPath,
        [packagedModels, ...args, '--codex-home', isolatedModelsHome],
        temporaryRoot,
      ),
    );
  const runtimeFile = path.join(temporaryRoot, 'external-runtime.json');
  const detected = JSON.parse(
    run(
      process.execPath,
      [packagedRunner, 'detect', '--executable', externalStub],
      temporaryRoot,
    ),
  );
  if (
    detected.models !== undefined ||
    detected.modelExecutionVerified !== false
  )
    throw new Error('Packaged detection claimed account model capabilities.');
  await writeFile(runtimeFile, JSON.stringify(detected));
  const packageModel = 'claude-package-fixture-20300101';
  const combinedInput = path.join(temporaryRoot, 'combined-models.json');
  const combinedCatalog = path.join(temporaryRoot, 'combined-catalog.json');
  const selectedInput = path.join(temporaryRoot, 'selected-model.json');
  const source = {
    kind: 'manual-confirmation',
    description:
      'Package fixture confirms this exact model and supported efforts.',
  };
  await writeFile(
    combinedInput,
    JSON.stringify({
      models: [
        {
          model: 'gpt-6.1-sol',
          supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
        },
        {
          executor: 'claude-code',
          model: packageModel,
          supportedReasoningEfforts: ['medium', 'high'],
          source,
        },
      ],
    }),
  );
  const catalog = modelCall([
    'catalog',
    '--input',
    combinedInput,
    '--claude-runtime',
    runtimeFile,
  ]);
  if (JSON.stringify(catalog.models[1].source) !== JSON.stringify(source))
    throw new Error('Packaged catalog lost external model provenance.');
  await writeFile(combinedCatalog, JSON.stringify(catalog));
  await writeFile(
    selectedInput,
    JSON.stringify({
      roles: {
        'how explainer': [
          {
            executor: 'claude-code',
            model: packageModel,
            reasoningEffort: 'high',
          },
        ],
      },
    }),
  );
  modelCall([
    'write',
    '--input',
    selectedInput,
    '--catalog',
    combinedCatalog,
    '--expected-hash',
    'absent',
    '--dry-run',
  ]);
  modelCall([
    'write',
    '--input',
    selectedInput,
    '--catalog',
    combinedCatalog,
    '--expected-hash',
    'absent',
  ]);
  const budgeted = modelCall([
    'budget',
    '--budget',
    'small',
    '--catalog',
    combinedCatalog,
  ]);
  await writeFile(selectedInput, JSON.stringify(budgeted));
  modelCall([
    'write',
    '--input',
    selectedInput,
    '--catalog',
    combinedCatalog,
    '--expected-hash',
    budgeted.sha256,
  ]);
  const selected = modelCall(['resolve', '--role', 'how explainer']).entries[0];
  if (
    modelCall(['read']).config.budget !== 'small' ||
    selected.model !== packageModel ||
    selected.reasoningEffort !== 'medium'
  )
    throw new Error(
      'Packaged setup did not preserve the budgeted external choice.',
    );
  const nondefault = JSON.parse(
    run(
      process.execPath,
      [
        packagedRunner,
        'run',
        '--cwd',
        temporaryRoot,
        '--run-dir',
        path.join(temporaryRoot, 'external-nondefault-evidence'),
        '--model',
        selected.model,
        '--effort',
        selected.reasoningEffort,
        '--instruction',
        instruction,
        '--skill',
        path.join(artifactRoot, 'plugin/skills/how/SKILL.md'),
        '--executable',
        externalStub,
      ],
      temporaryRoot,
      'Check the selected packaged nondefault model.\n',
    ),
  );
  const received = JSON.parse(await readFile(externalCapture, 'utf8'));
  const request = JSON.parse(await readFile(nondefault.requestPath, 'utf8'));
  if (
    received[received.indexOf('--model') + 1] !== packageModel ||
    received[received.indexOf('--effort') + 1] !== 'medium' ||
    request.model !== packageModel ||
    nondefault.model !== packageModel ||
    nondefault.observedModel !== packageModel ||
    nondefault.result !== `packaged external transport received ${packageModel}`
  )
    throw new Error(
      'Packaged detect-to-run chain lost the selected external model.',
    );
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      artifactRoot,
    ],
    temporaryRoot,
  );
  const repositoryClaudeMarketplace = JSON.parse(
    await readFile(
      path.join(packageRoot, '.claude-plugin/marketplace.json'),
      'utf8',
    ),
  );
  const repositoryClaudeManifest = JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        repositoryClaudeMarketplace.plugins[0].source,
        '.claude-plugin/plugin.json',
      ),
      'utf8',
    ),
  );
  if (
    repositoryClaudeMarketplace.name !== 'pstack-cc' ||
    repositoryClaudeManifest.name !== 'pstack-cc'
  )
    throw new Error(
      'Packed repository marketplace did not resolve its committed Claude tree.',
    );
  const claudeArtifact = path.join(temporaryRoot, 'claude-artifact');
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'build-plugin',
      '--target',
      'claude-code',
      '--output',
      claudeArtifact,
    ],
    temporaryRoot,
  );
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      claudeArtifact,
    ],
    temporaryRoot,
  );
  const claudeMarketplace = JSON.parse(
    await readFile(
      path.join(claudeArtifact, '.claude-plugin/marketplace.json'),
      'utf8',
    ),
  );
  const claudeManifest = JSON.parse(
    await readFile(
      path.join(
        claudeArtifact,
        claudeMarketplace.plugins[0].source,
        '.claude-plugin/plugin.json',
      ),
      'utf8',
    ),
  );
  if (claudeManifest.name !== 'pstack-cc')
    throw new Error(
      'Packed Claude marketplace did not resolve its native plugin.',
    );
  const packagedRuntime = JSON.parse(
    await readFile(path.join(claudeArtifact, 'artifact.json'), 'utf8'),
  ).codexRuntime;
  const sourceRuntime = JSON.parse(
    await readFile(path.join(packageRoot, 'codex-runtime.lock.json'), 'utf8'),
  );
  if (JSON.stringify(packagedRuntime) !== JSON.stringify(sourceRuntime))
    throw new Error('Packed Claude artifact lost the independent runtime pin.');
  const claudeHome = path.join(temporaryRoot, 'isolated-claude-home');
  await mkdir(path.join(claudeHome, 'agents'), { recursive: true });
  const claudeSettings = '{ "model": "user-choice", "unknown": true }\n';
  await writeFile(path.join(claudeHome, 'settings.json'), claudeSettings);
  await writeFile(
    path.join(claudeHome, 'agents', 'user-agent.md'),
    'Unrelated Claude agent.\n',
  );
  const claudeModels = path.join(
    claudeArtifact,
    'plugin/skills/setup-pstack/scripts/models.mjs',
  );
  const claudeModelCall = (args: string[]) =>
    JSON.parse(
      run(
        process.execPath,
        [claudeModels, ...args, '--claude-home', claudeHome],
        temporaryRoot,
      ),
    );
  const initialClaude = claudeModelCall(['read']);
  if (
    initialClaude.exists ||
    Object.keys(initialClaude.proposal.roles).length !== 17
  )
    throw new Error(
      'Packaged Claude helper did not expose the original role proposal.',
    );
  const unconfiguredClaudePanel = claudeModelCall([
    'resolve',
    '--role',
    'arena runners',
    '--kind',
    'general-purpose',
  ]);
  if (
    unconfiguredClaudePanel.source !== 'unconfigured' ||
    unconfiguredClaudePanel.entries.length !== 2 ||
    !unconfiguredClaudePanel.entries.every(
      (entry: { model: string; executor: string; agentType: string }) =>
        entry.model === 'inherit-parent' &&
        entry.executor === 'claude-code' &&
        entry.agentType === 'pstack-cc:general-purpose',
    )
  )
    throw new Error('Packaged Claude panel lost its two native-parent seats.');
  const nativeWorkerKinds = [
    'general-purpose',
    'poteto-agent',
    'comment-sicko',
    'read-only',
  ];
  for (const kind of nativeWorkerKinds) {
    const fallback = claudeModelCall([
      'resolve',
      '--role',
      'how explorer',
      '--kind',
      kind,
    ]);
    const definition = await readFile(
      path.join(claudeArtifact, 'plugin/agents', `${kind}.md`),
      'utf8',
    );
    const frontmatter = /^---\n([\s\S]*?)\n---\n\s*\S/.exec(definition)?.[1];
    if (
      fallback.source !== 'unconfigured' ||
      fallback.entries.length !== 1 ||
      fallback.entries[0].executor !== 'claude-code' ||
      fallback.entries[0].model !== 'inherit-parent' ||
      fallback.entries[0].agentType !== `pstack-cc:${kind}` ||
      !frontmatter ||
      !frontmatter.split('\n').includes(`name: ${kind}`) ||
      !/^description: \S.+$/m.test(frontmatter) ||
      !/^model: inherit$/m.test(frontmatter) ||
      (kind === 'read-only' &&
        !/^disallowedTools: Write, Edit, NotebookEdit$/m.test(frontmatter))
    )
      throw new Error(`Packaged Claude static fallback is unusable: ${kind}`);
  }
  const nativeFallback = claudeModelCall([
    'resolve',
    '--role',
    'how explainer',
    '--kind',
    'general-purpose',
  ]);
  if (
    nativeFallback.source !== 'unconfigured' ||
    nativeFallback.entries.length !== 1 ||
    nativeFallback.entries[0].executor !== 'claude-code' ||
    nativeFallback.entries[0].model !== 'inherit-parent' ||
    nativeFallback.entries[0].agentType !== 'pstack-cc:general-purpose' ||
    claudeModelCall(['read']).exists
  )
    throw new Error(
      'Packaged Claude native execution default was lost or saved as a fixed choice.',
    );
  const nativeModel = 'claude-package-exact-20300101';
  const catalogFile = path.join(temporaryRoot, 'claude-package-catalog.json');
  await writeFile(
    catalogFile,
    JSON.stringify({
      models: [
        {
          executor: 'claude-code',
          model: nativeModel,
          supportedReasoningEfforts: ['xhigh'],
          source: {
            kind: 'manual-confirmation',
            description:
              'Synthetic package fixture only, not an actual account catalog.',
          },
        },
        {
          executor: 'codex',
          model: 'package-model',
          supportedReasoningEfforts: ['xhigh'],
        },
      ],
    }),
  );
  const nativeChoice = {
    executor: 'claude-code',
    model: nativeModel,
    reasoningEffort: 'xhigh',
  };
  const codexChoice = {
    executor: 'codex',
    model: 'package-model',
    reasoningEffort: 'xhigh',
  };
  const claudeConfig = {
    schemaVersion: 1,
    host: 'claude-code',
    budget: 'large',
    roles: Object.fromEntries(
      Object.entries(initialClaude.proposal.roles).map(([role, value]) => [
        role,
        Array.isArray(value)
          ? [nativeChoice, codexChoice, nativeChoice]
          : nativeChoice,
      ]),
    ),
  };
  const choicesFile = path.join(temporaryRoot, 'claude-package-choices.json');
  await writeFile(choicesFile, JSON.stringify(claudeConfig));
  claudeModelCall([
    'write',
    '--input',
    choicesFile,
    '--catalog',
    catalogFile,
    '--expected-hash',
    'absent',
    '--dry-run',
  ]);
  const savedClaude = claudeModelCall([
    'write',
    '--input',
    choicesFile,
    '--catalog',
    catalogFile,
    '--expected-hash',
    'absent',
  ]);
  const savedClaudeBytes = await readFile(savedClaude.file);
  const claudeRegistrar = path.join(
    claudeArtifact,
    'plugin/skills/setup-pstack/scripts/register-agents.mjs',
  );
  const claudeRegister = (args: string[] = []) =>
    JSON.parse(
      run(
        process.execPath,
        [claudeRegistrar, '--claude-home', claudeHome, ...args],
        temporaryRoot,
      ),
    );
  claudeRegister(['--dry-run']);
  const claudeRegistration = claudeRegister();
  if (
    JSON.stringify(
      claudeRegistration.agents
        .map((agent: { kind: string }) => agent.kind)
        .sort(),
    ) !== JSON.stringify([...nativeWorkerKinds].sort())
  )
    throw new Error(
      'Packaged Claude registration must expose every native worker kind exactly once.',
    );
  for (const agent of claudeRegistration.agents) {
    const definition = await readFile(agent.file, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n\s*\S/.exec(definition)?.[1];
    if (
      !frontmatter ||
      !/^description: \S.+$/m.test(frontmatter) ||
      !frontmatter.includes(`name: ${JSON.stringify(agent.agentType)}\n`) ||
      !frontmatter
        .split('\n')
        .includes(`model: ${JSON.stringify(nativeModel)}`) ||
      agent.model !== nativeModel ||
      (agent.kind === 'read-only'
        ? !/^disallowedTools: Write, Edit, NotebookEdit$/m.test(frontmatter)
        : /^disallowedTools:/m.test(frontmatter))
    )
      throw new Error(
        `Packaged Claude registered definition is unusable: ${agent.kind}`,
      );
  }
  const registeredBytes = await readFile(claudeRegistration.registry);
  claudeRegister();
  if (!(await readFile(claudeRegistration.registry)).equals(registeredBytes))
    throw new Error('Packaged Claude registration was not idempotent.');
  const resolvedClaude = claudeModelCall([
    'resolve',
    '--role',
    'arena runners',
    '--kind',
    'poteto-agent',
  ]);
  if (
    resolvedClaude.entries.length !== 3 ||
    resolvedClaude.entries[0].executor !== 'claude-code' ||
    !resolvedClaude.entries[0].agentType ||
    resolvedClaude.entries[1].executor !== 'codex' ||
    resolvedClaude.entries[2].agentType !== resolvedClaude.entries[0].agentType
  )
    throw new Error(
      'Packaged Claude role resolution lost executor routing or duplicate panel seats.',
    );
  claudeRegister(['--unregister']);
  if (
    !(await readFile(savedClaude.file)).equals(savedClaudeBytes) ||
    (await readFile(path.join(claudeHome, 'settings.json'), 'utf8')) !==
      claudeSettings ||
    (await readFile(path.join(claudeHome, 'agents/user-agent.md'), 'utf8')) !==
      'Unrelated Claude agent.\n' ||
    (await readFile(
      path.join(codexHome, 'pstack-codex/models.json'),
      'utf8',
    )) !== preservedSettings
  )
    throw new Error('Packaged Claude setup changed unrelated host settings.');
  const codexStub = path.join(temporaryRoot, 'existing-codex-stub');
  await writeFile(
    codexStub,
    `#!${process.execPath}\n` +
      String.raw`
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2), config = {};
const merge = (target, next) => { for (const [key,value] of Object.entries(next)) { if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value); else target[key] = value; } };
while (args[0] === '-c') {
  args.shift();
  const value = args.shift();
  const parsed = spawnSync('python3',['-c','import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],{input:value,encoding:'utf8'});
  if (parsed.status !== 0) throw new Error(parsed.stderr);
  merge(config,JSON.parse(parsed.stdout));
}
if (args[0] === '--version') { console.log('codex-cli 0.fixture'); process.exit(0); }
if (args[0] === 'app-server' && args[1] === '--help') { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(3);
const hookKey = '/<session-flags>/config.toml:pre_tool_use:0:0', hookHash = 'sha256:'+'1'.repeat(64);
const send = (value) => console.log(JSON.stringify(value));
const respond = (request, result) => send({id: request.id, result});
const lines = readline.createInterface({input: process.stdin});
lines.on('line', (line) => {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize': respond(request, {userAgent: 'package-fixture'}); break;
    case 'initialized': break;
    case 'config/read': respond(request, {config:{model_provider:'openai',features:{hooks:true}}}); break;
    case 'configRequirements/read': respond(request,{requirements:null}); break;
    case 'experimentalFeature/list': respond(request,{data:[{name:'hooks',enabled:true}],nextCursor:null}); break;
    case 'hooks/list': {
      const group = config.hooks?.PreToolUse?.[0], handler = group?.hooks?.[0];
      const hooks = handler ? [{key:hookKey,eventName:'preToolUse',handlerType:'command',command:handler.command,async:false,matcher:group.matcher,timeoutSec:5,source:'sessionFlags',sourcePath:'/<session-flags>/config.toml',enabled:true,currentHash:hookHash,trustStatus:config.hooks?.state?.[hookKey]?.trusted_hash === hookHash ? 'trusted' : 'untrusted'}] : [];
      respond(request,{data:[{cwd:request.params.cwds[0],hooks,errors:[],warnings:[]}]}); break;
    }
    case 'account/read': respond(request, {account:{type:'chatgpt'},requiresOpenaiAuth:true}); break;
    case 'model/list': respond(request, {data:[{id:'package-model',model:'package-model',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}],nextCursor:null}); break;
    case 'thread/start': respond(request, {thread:{id:'package-thread'},model:'package-model',reasoningEffort:'xhigh',approvalPolicy:request.params.approvalPolicy,approvalsReviewer:request.params.approvalsReviewer,sandbox:{type:request.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly',networkAccess:false}}); break;
    case 'turn/start':
      respond(request, {turn:{id:'package-turn',status:'inProgress'}});
      send({method:'item/completed',params:{threadId:'package-thread',turnId:'package-turn',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:'packaged Codex transport stub'}}});
      setTimeout(() => send({method:'turn/completed',params:{threadId:'package-thread',turn:{id:'package-turn',status:'completed'}}}), 20);
      break;
    default: send({id:request.id,error:{code:-32601,message:'unexpected '+request.method}});
  }
});
lines.on('close', () => process.exit(0));
`,
  );
  await chmod(codexStub, 0o755);
  const codexRunner = path.join(
    claudeArtifact,
    'plugin/skills/poteto-mode/scripts/run-codex.mjs',
  );
  const codexRunDirectory = path.join(temporaryRoot, 'packaged-codex-evidence');
  const codexReceipt = JSON.parse(
    run(
      process.execPath,
      [
        codexRunner,
        'run',
        '--cwd',
        temporaryRoot,
        '--run-dir',
        codexRunDirectory,
        '--model',
        'package-model',
        '--effort',
        'xhigh',
        '--instruction',
        instruction,
        '--skill',
        path.join(claudeArtifact, 'plugin/skills/how/SKILL.md'),
        '--executable',
        codexStub,
      ],
      temporaryRoot,
      'Check the packaged Codex transport fixture.\n',
    ),
  );
  if (
    codexReceipt.status !== 'completed' ||
    codexReceipt.threadId !== 'package-thread' ||
    codexReceipt.turnId !== 'package-turn' ||
    codexReceipt.finalText !== 'packaged Codex transport stub' ||
    codexReceipt.requested.model !== 'package-model' ||
    codexReceipt.executionPolicy?.requested?.approvalMode !== 'auto-review' ||
    codexReceipt.executionPolicy?.observed?.approvalPolicy !== 'on-request' ||
    codexReceipt.executionPolicy?.observed?.approvalsReviewer !==
      'auto_review' ||
    codexReceipt.executionPolicy?.observed?.sandbox?.type !== 'readOnly' ||
    codexReceipt.commandBoundary?.status !==
      (process.platform === 'darwin' ? 'active' : 'notApplicable')
  )
    throw new Error(
      'Packaged Codex runner did not complete its owned app-server turn.',
    );
  const savedCodexReceipt = JSON.parse(
    await readFile(path.join(codexRunDirectory, 'result.json'), 'utf8'),
  );
  if (JSON.stringify(savedCodexReceipt) !== JSON.stringify(codexReceipt))
    throw new Error(
      'Packaged Codex worker returned a different terminal receipt.',
    );
  const packagedPrompt = await readFile(
    path.join(codexRunDirectory, 'prompt.txt'),
    'utf8',
  );
  if (
    !packagedPrompt.includes('Apply only the assigned package fixture task.') ||
    !packagedPrompt.includes('Check the packaged Codex transport fixture.')
  )
    throw new Error('Packaged Codex worker lost assigned instructions.');
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      claudeArtifact,
    ],
    temporaryRoot,
  );
  const commonFile = 'skills/how/SKILL.md';
  const editedCommon = path.join(packageRoot, 'plugin-claude', commonFile);
  const commonBytes = `${await readFile(editedCommon, 'utf8')}\nPackaged shared-authoring fixture.\n`;
  await writeFile(editedCommon, commonBytes);
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'generate-shared-patch',
      '--from',
      'claude-code',
      '--name',
      '9000-package-common.patch',
      '--paths',
      commonFile,
    ],
    temporaryRoot,
  );
  if (
    (await readFile(path.join(packageRoot, 'plugin', commonFile), 'utf8')) !==
    commonBytes
  )
    throw new Error(
      'Packaged shared command did not materialize the other output.',
    );
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-patches', '--target', 'all'],
    temporaryRoot,
  );
  const rawText = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  await writeFile(path.join(packageRoot, 'plugin/latin.txt'), rawText);
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'generate-shared-patch',
      '--from',
      'codex',
      '--name',
      '9001-package-bytes.patch',
      '--paths',
      'latin.txt',
    ],
    temporaryRoot,
  );
  if (
    !(await readFile(path.join(packageRoot, 'plugin-claude/latin.txt'))).equals(
      rawText,
    )
  )
    throw new Error('Packaged shared authoring changed non-UTF-8 file bytes.');
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-patches', '--target', 'all'],
    temporaryRoot,
  );
  console.log(
    'Packed artifact verified: both standalone host plugins, native marketplace manifests, independent patch replay, common authoring materialization and pinned runtime, isolated setup lifecycle, fresh unresolved model choices, parent fallback cardinality, the nondefault Claude detect-to-run chain, and both external CLI stub transports without source files or development dependencies. User settings are preserved. The stubs do not prove authentication or live model execution. Native global install was not run.',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
