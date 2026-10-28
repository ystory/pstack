# Codex execution

Read this reference before launching, steering, waiting for, or collecting pstack delegates. Resolve every bundled path from the directory containing the actual installed `SKILL.md`, not from the workspace or a guessed installation directory.

## Roles, models, and effort

Run the sibling setup helper with its absolute path:

```text
node <skills>/setup-pstack/scripts/models.mjs resolve --role "<role>"
```

It reads `$CODEX_HOME/pstack-for-codex/models.json`, or `~/.codex/pstack-for-codex/models.json` when `CODEX_HOME` is unset. The response contains `role`, ordered `entries`, `source`, and `file`. Each entry supplies `model`, its saved budget's starting `reasoningEffort`, and an optional `executor`. An absent executor or `"codex"` uses native Codex delegation. `"claude-code"` uses the bundled Claude Code runner with `claude-opus-5-5`.

A missing role uses the bundled default. Ordinary implementation and investigation, judgment and prose, how, why, reflect, and scalar swarm workers default to native `gpt-6.1-sol`. Only `hardest tasks` defaults to Claude Code `claude-opus-5-5`. The `arena runners`, `architect runners`, and `interrogate reviewers` defaults each contain one Sol seat and one Opus seat. The `arena cross-judge pool` contains those two choices, from which the caller selects one judge.

Preserve ordered entries and their multiplicity. Equal entries remain separate executions. Saved role selections override defaults. For an explicit model, use the task's explicit effort when given; otherwise adjust the entry's starting effort for the job using poteto-mode's Subagents guidance and the selected executor's confirmed model capabilities. Pass model and effort separately. A refused model follows the caller's documented fallback, and every fallback is reported. A rejected adjusted effort returns to the role's supported starting effort and is reported. Never invent a model ID or attach effort or speed suffixes.

`auto` and `inherit-parent` both select the current native Codex parent model. Budget changes preserve these aliases. Check the active native subagent defaults and selected role before binding them: an omitted model or effort can select `[agents]` defaults, and an omitted agent type can apply the configured `default` role. Omit model and effort only when they will preserve the parent selection. Otherwise pass the observed parent model and effort explicitly through supported fields, using a fresh-context brief when the host requires it. If the parent settings or effective inheritance cannot be established, report the alias as unresolved. An alias is not a refused model and does not use a fallback model.

Keep a per-executor record of rejected model IDs during the run. A model is rejected when the executor reports it invalid or omits it from an explicit list of valid models. Never submit an already rejected model to that executor again, including through a fallback. After a rejected adjusted effort or speed, try the role's supported starting setting unless its model is already rejected, then follow the calling skill's fallback. When the caller has no fallback, use the closest valid model of the role's family from the error's list. If that list has none, or the caller exhausts its fallbacks without another outcome, bind a native execution to the actual parent selection and disclose the loss of the requested model. An unresolved parent selection remains unresolved. Explicit different-model or different-family gates still apply, as do Arena's judge skip rules. An unavailable executor is a capability gap, not evidence that a model was rejected.

Speed uses a separate executor control when one is exposed. Native subagents inherit the root session's service tier when no per-agent speed control is available. Report an urgent fast request that the selected executor cannot express independently.

Record the actual model and effort for each execution when the executor exposes them; otherwise distinguish requested settings from unknown effective settings. Validate required distinct models or families before launching the affected step; report a configuration error when the selected entries cannot satisfy it. A distinct-model or distinct-family requirement remains a requirement. Repeated seats on one model do not satisfy it. Keep a source preference distinct from a requirement and report an unmet preference accurately. Arena has its own different-family-or-skip rule for its judge, rather than a stop on an unavailable judge.

For the default pair, Sol's counterpart is Opus through Claude Code, and Opus's counterpart is Sol through native Codex. Use that selection for a required different-family trail review or verifier. The Arena judge family check compares the judge with the parent, not every candidate. Apply Arena's ordered pool, default-pool retry, disclosed skip, and unknown-parent rules. Its skip does not waive another workflow's required verifier. The orchestrate tool-error retry requires a different model; it does not add a different-family requirement. Preserve each caller's existing selection, dropout, and retry rules.

## Native delegation

Inspect the tools exposed by the current runtime and use their actual schemas. Use native Codex subagent tools for entries whose executor is absent or `"codex"`, not Cursor `Task` parameters. On a runtime exposing `collaboration`:

- Spawn with `spawn_agent`, a unique `task_name`, and a complete `message`.
- The message includes the goal, owned files or slice, boundaries, exact verification, required report, and absolute skill/reference/artifact paths. For writers, say they are not alone and must accommodate others' edits.
- General-purpose workflow seats explicitly select `agent_type: "pstack-general-purpose"`. Setup registers this pstack routing role with a description only, without a config file or instruction body. It preserves the parent-derived instructions and selected model/effort instead of applying the user's configured `default` role. Inspect the actual schema and role precedence. Check effective settings when the host exposes them; otherwise record them as unknown instead of inferring missing response fields.
- Playbook delegates select the registered `poteto-agent` custom role through `agent_type`. Comment cleanup selects `comment-sicko`. Pass the absolute `poteto-mode/SKILL.md` path to every `poteto-agent`; its preserved instruction body uses that path to find the bundled principles.
- Resolve custom roles through native discovery after setup. Confirm both the loaded role and a role-selector field in the actual spawn schema. If either is unavailable, inspect registration, enabled config layers and project trust, and the host's tool capabilities; report the specific gap. Use the authorized setup path for missing registration and start a new Codex session before retrying, as setup requires. Preserve the requested custom role's instructions.
- Explicit `model` and `reasoning_effort` overrides use `fork_turns: "none"` on schemas that require it. Supply all task context in the message. Inherited aliases use the parent-selection binding above; a fresh brief can still use `fork_turns: "none"`.

`fork_turns: "all"` copies conversation history into a subagent. It does not create an independent checkout, copy uncommitted files, or clone running processes. `fork_turns: "none"` starts from the complete brief. Neither field supplies worktree isolation. Use the local-worktree and working-tree transfer rules below for filesystem state. These collaboration schemas have no worker-fork operation that copies a live environment. Use the stateful reuse exception below when the required state cannot be moved, rather than creating a separate user task to simulate a worker fork.

Launch independent seats consecutively without waiting between them. A concurrency limit affects how many run at once, not how many seats the workflow requires. Queue remaining seats and drain them; preserve every required result.

## Claude Code delegation

For an entry with `executor: "claude-code"`, resolve `scripts/run-claude.mjs` from the installed `poteto-mode` directory. Write the consolidated task brief to an absolute local file, then launch the runner through the host's command tool. The process remains governed by that tool's OS permissions and environment. Use the host's standard execution and approval mechanism for access to the existing Claude authentication and runtime state. On a Codex host exposing `exec_command` with `sandbox_permissions`, request `sandbox_permissions: "require_escalated"` with a task-specific `justification` when that access requires it, and set `workdir` to the assigned checkout.

For a task that edits `index.mjs` and verifies it with `node --test index.test.mjs`, include the corresponding file and command rules:

```sh
node "<poteto-mode>/scripts/run-claude.mjs" run \
  --cwd "/absolute/assigned-worktree" \
  --run-dir "/absolute/local-run-directory" \
  --effort xhigh \
  --instruction "/absolute/applicable/AGENTS.md" \
  --skill "<absolute/relevant/SKILL.md>" \
  --allowed-tool 'Read(//absolute/plugin/skills/principle-prove-it-works/SKILL.md)' \
  --allowed-tool 'Edit(//absolute/assigned-worktree/index.mjs)' \
  --allowed-tool 'Bash(node --test index.test.mjs)' \
  < "/absolute/task-prompt.txt"
```

Use the resolved task effort. Repeat `--instruction` for the applicable project instructions and selected source references, templates, and rubrics, and `--skill` for the relevant skill bodies. The runner reads these absolute files, sends their contents with the task to Claude Code, and grants standard exact-file `Read` access to each supplied context file. The caller also supplies `--allowed-tool` rules for required linked source files and already-authorized task operations, including edits and verification commands. Use exact files or the required source subtree for `Read`, scoped `Edit` rules for owned files whether the delegate uses Edit or Write, and the task's command for `Bash`. Claude Code absolute file rules begin with two slashes, as in `Edit(//absolute/project/new-file.md)`. Keep task edits in the assigned cwd/worktree. Gather these rules from the task and its source references before launching.

Claude Code's [file permission rules](https://code.claude.com/docs/en/permissions#writepath-notebookeditpath-and-globpath-rules-never-match) match file creation and editing through `Edit(path)`. A path-scoped `Write(path)` rule is accepted but never matches. `--allowedTools` preapproves matching calls; it does not restrict the available tool set or create a filesystem boundary. An allowed shell or interpreter can perform operations beyond another tool's rule, so retain the host's OS permissions and the task's ownership scope.

The brief carries the original task, later directives, owned scope, cwd and branch, exact input SHAs, required tools and constraints, verification, artifact locations including this runner's run directory, and output contract. Filled template fields belong in that brief. Preserve judge blinding by using sanitized candidate labels and paths in the judge's files and brief.

When the original dispatcher calls for `poteto-agent` or `comment-sicko`, add `--role "<plugin>/agents/poteto-agent.md"` or `--role "<plugin>/agents/comment-sicko.md"`. Pass `poteto-mode/SKILL.md` with `poteto-agent`. General-purpose reviewers, candidates, investigators, and explainers use their own workflow sources without a `--role` file. Native role registration does not load instructions into Claude Code.

The runner invokes the existing Claude Code installation with `claude -p --model claude-opus-5-5`, the chosen effort, and stream JSON output. It uses Claude Code's existing authentication and configured harness, tools, and MCPs. The Codex parent's native role configuration, MCP inventory, and thread state do not automatically load into Claude Code.

Start each independent seat or new round with a distinct run directory and a fresh Claude session. Only the stateful reuse exception in poteto-mode permits `--resume "<exact-session-uuid>"` on a subsequent run. A running command is asynchronous work; track its command identity and collect its terminal receipt. Do not wait for one independent seat before launching the next.

## Local worktrees

Workers run on the current host through their selected executor. Give each independent worker an exclusive Git worktree and branch when it writes code. Use native managed-worktree tools when exposed, waiting for creation to complete, or `git worktree add` with an explicit base ref and a local `codex/` branch. The worker's prompt names its absolute checkout, branch, and resolved starting SHA; every shell command runs in that checkout. Keep the coordinator's checkout separate.

For workflows that previously started from the repository's default branch, resolve the actual default ref and SHA before creating the worker checkouts. A caller-supplied non-default ref replaces that base. Measurements and verification pin the exact SHAs required by their brief. Local uncommitted changes enter a worker's input only when the brief explicitly includes them.

The coordinator creates and removes worktrees and coordinates shared repository metadata. Each branch owner performs the pushes, rebases, and PR operations its calling workflow assigns. Workers own their assigned checkout and output only. Worktrees isolate files and indexes; they share the host, repository metadata, credentials, and other machine resources. Assign distinct ports, temporary/cache/data directories, simulator/device resources, and output locations for work that uses them. Serialize a machine resource that cannot be separated. Restrict the brief's commands to the assigned resources.

After collecting and verifying artifacts, integrate accepted work deliberately. Retain any unintegrated changes and evidence. Remove temporary worktrees and local branches only after their needed work has been integrated or preserved, following the worktree cleanup playbook. A completed worker alone does not authorize discarding its checkout.

### Working-tree transfer

When a workflow includes uncommitted changes, record the source checkout and its exact HEAD, then create every receiving worktree at that HEAD. Capture the scoped tracked working-tree contents with `git diff --binary HEAD -- <scope>` in a local patch file. This includes the final staged and unstaged contents, additions, deletions, and executable-mode changes. Inventory scoped untracked files separately and copy their file types, bytes or symlink targets, and executable modes to the same relative paths in every receiving worktree. Include ignored input only when the task explicitly needs it. Do not copy the source's Git metadata or unrelated personal state.

Apply the tracked patch in each clean receiving worktree and copy the untracked files before launching its worker. Compare the resulting scoped file bytes, file types, executable modes, and deletions against the source. Record the source SHA, scope, patch, untracked inventory, and comparison result in the brief or its artifacts. If the input changes during capture, recapture a coherent input before dispatch. A diff in the prompt or inherited chat history is context, not this transfer.

For new work that needs a completed worker's built state, give a fresh worker the consolidated brief and reports. Transfer its committed or uncommitted checkout state to an exclusive worktree, or hand over the existing checkout after the prior writer stops. Preserve branch ownership and resource assignments. Reuse the existing worker only under poteto-mode's exception for a costly-to-move checkout, uncommitted changes, or a process it still runs. There is no implied copy of a running process. Name the process and host resources if that state is needed.

## Wait, results, and continuation

Track every returned agent or command identity, executor, and slice. For native delegates, use `wait_agent` for an event and `list_agents` for status on runtimes with those tools. The final-answer notification contains the result. Use a result/retrieval tool when the runtime exposes one. A spawn acknowledgement or a completed status without its report is not a result.

For Claude Code, collect the command's terminal receipt and inspect its `result`, `resultEvent`, `sessionId`, `exitCode`, and `signal`, plus the artifacts named by `promptPath`, `requestPath`, `stdoutPath`, `stderrPath`, and `resultPath`. The receipt preserves the process outcome and raw stream. Review the reported work and artifacts under the calling workflow's normal result and failure rules.

Wait for every required terminal result before synthesis. Record failures and missing reports as gaps under the calling workflow's dropout rule. Review changed artifacts and verification evidence yourself.

Spawns, steering, and continuation remain asynchronous. Use the exposed native controls without inventing a `run_in_background` field, and keep a long-running external command under the host's asynchronous process controls. Collect its terminal receipt later while other independent work proceeds.

Fresh agents take new rounds with the consolidated brief. Reuse an existing agent only for the stateful exceptions in poteto-mode. For native delegates, use `send_message` to steer a running agent, `followup_task` to continue an idle agent, and `interrupt_agent` for a stop/hold on runtimes exposing those controls. Use a native resume control only when present. Claude Code's stateful continuation uses its recorded session ID with the runner's `--resume`. Keep a stop order separate from a new work brief.

For a repeated watcher or work that must resume after the active turn, read [Codex loops](codex-loops.md) and use its native event or heartbeat controls.

## Permissions and MCP access

Native v2 delegates use the parent's sandbox, approvals, and available tools. Route the role and its normal task procedures through native delegation. MCP-backed native `why` and `reflect` delegates use the inherited tools for investigation and citation checks. Claude Code delegates use their existing configured execution environment and receive the same applicable task instructions and source bodies through the runner.

## References

[Codex subagents and custom-agent permissions](https://learn.chatgpt.com/docs/agent-configuration/subagents).
