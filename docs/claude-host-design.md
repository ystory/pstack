# pstack in Claude Code with selectable worker executors

The goal is to make pstack available in Claude Code and let users select Claude or Codex workers for its roles through setup. The host application, the workflow role, and the worker executor are separate choices. A Claude-led workflow using Sol 6.1 workers is one possible configuration. The Claude Code distribution is named `pstack-cc`.

## Accepted decisions

- Maintain the existing Codex distribution and add a separately packaged Claude Code distribution in this repository. Both use the same locked pstack source. See [ADR 0001](adr/0001-separate-host-distributions.md).
- Keep role-model preferences independent for each host. Users can rerun setup to change their selections.
- Include the required official Codex execution code at a pinned source revision. Launch the separate official standalone app-server package with shared Codex authentication and persistent history. This project owns source updates and license notices. See [ADR 0002](adr/0002-bundle-codex-worker-runtime.md).
- Guide CLI discovery, installation, and human login during setup. Reuse existing credentials.
- Preserve pstack's role semantics and workflow behavior, including panel entries, model-diversity requirements, worker instructions, and fresh-worker rules.
- Treat current Sol 6.1 capacity as a reason for a user's current setup choice. It does not determine the new distribution's model defaults.
- Preserve the existing workflow and host error handling. Add no bespoke quota-switching, stop, or confirmation policy.

## Execution approach

The Claude Code host reads its own role configuration. It uses the native Agent tool for Claude workers and the included Codex runtime for Codex workers. Each selected worker receives the role instructions, applicable pstack skills, task scope, and the context its workflow requires.

Reuse the host's asynchronous execution and completion events. A foreground runner calls the bundled official runtime's direct app-server path inside Claude Code's background Bash. Its one server command launches `codex-app-server --session-source app-server` from inherited PATH or an explicit absolute path. The same command handles setup's account and paged model probes. Each run owns its process and receipt. It waits for a real terminal event and resumes only an explicit thread. The companion CLI's shared broker and last-task lookup are outside this execution path.

The standalone binary is an additional platform package with companion files. It is not supplied by the npm CLI installation. Setup guides its installation without automating downloads. Workers share `CODEX_HOME` and send no hidden thread tag. Existing exact resumes retain their source. The generic vendored client keeps its upstream launch default when no `appServerArgs` are supplied.

The workflow's parent owns the launch. It sets the supported native background timeout explicitly and reads retained result files after completion. Setup's configuration target is separate from the inherited CLI authentication environment.

Saved exact Claude selections use generated native definitions. Unsaved roles use only the actual native parent through static inherited agents at their original cardinality. Setup proposals remain separate from these execution fallbacks. Readonly source sites use a native kind that excludes file-editing tools. This is not an OS-level write boundary. Existing workflow requirements determine worktree isolation and when a worker may resume.

Earlier named runtime paths were verified on Claude Code 2.1.317 and Codex CLI 0.165.0. The final standalone 0.167.0 runner also completed native background launch, exact resume, reviewed approvals, child and grandchild delegation, TaskStop, and parent-termination checks. Default-list comparisons passed through both standalone and Desktop-bundled producers. The user's final Recents screenshot shows the control and no candidate entry. The precise screen and descendant limits, failed hidden-tag experiment, and unexposed settings are recorded in [Design and compatibility](spec.md).

## Implementation order

1. Check the external worker connection in an isolated fixture. Confirm instruction delivery, actual completion, model selection, and a failure result.
2. Add the Claude Code distribution and its setup. Preserve the Codex distribution's identity and independent settings.
3. Extend source locks, patch replay, and artifact verification to cover both host targets and the included runtime. Preserve the existing patch series.
4. Apply executor selection at all existing role-based delegation points. Preserve each workflow's instructions and model relationships.
5. Run the affected automated checks and live host workflows. Record source inspection, fixture results, and live compatibility separately.

## Evidence required for implementation completion

Setup changes in one host must leave the other host's settings intact. Runtime checks must demonstrate selected Claude and Codex workers, the full required worker instruction read, background completion and results, concurrent worker separation, workflow-appropriate continuation, and actual cancellation behavior. Record requested and observed model settings separately when effective settings are not exposed.

Artifact and patch replay must reproduce each target's bytes, file types, and permissions. Live workflow receipts identify the tested host versions and scope. Passing artifact checks alone establishes no runtime compatibility.

The implementation and its verified scope are documented in [Design and compatibility](spec.md). Source, fixture, live-runtime, installation, and release evidence remain distinct.
