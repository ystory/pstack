# Run pstack in Claude cloud sessions

A Claude Project thread or a Claude Code session on the web can run in a cloud container instead of on your computer. This page sets up pstack there, with Claude workers and optional Codex workers. A local thread that runs on your computer through Remote Control uses that computer's pstack setup, and nothing here applies to it.

Read [Set up pstack](01-setup.md) first. The models, roles, and first task work the same way in the cloud. What changes is where the plugin, its saved choices, and the Codex login come from.

## What a cloud session starts with

Each new session starts a fresh container with your repositories cloned. It does not inherit plugins, `~/.claude` settings, logins, or binaries from your computer. Anything you install by hand during a session is gone when the container is reclaimed.

The cloud environment's setup script fills that gap. It runs as root before Claude starts, once for every new container. Install pstack there, not from inside a session. Claude loads plugin skills when it starts, so a plugin installed during a session shows no `/pstack-cc:` commands until the next session. The setup script cannot read the environment's saved variables or secrets.

Edit the script and the network settings in the environment's settings. In a Claude Project, open the project settings, then the **Cloud environment** menu, then the gear beside the selected environment. See [Cloud environments](https://code.claude.com/docs/en/cloud-environments) for the other entry points.

One container observed on 2026-11-19 had 4 CPUs, 15 GiB of memory, and about 55 GB of free disk, with Node.js 22 preinstalled and no running Docker daemon. Check your own before planning large swarms or arenas.

## Allow the network hosts

With the **Limited** network level and **Allow package managers** ticked, the setup script can install npm packages and clone the public pstack repository. Claude-only workers need nothing more.

Codex workers also need the OpenAI hosts. Add these under **Allowed domains** and leave **Allow package managers** ticked:

```text
auth.openai.com
api.openai.com
chatgpt.com
```

The environment's proxy refuses GitHub release downloads for repositories that are not attached to the session. The standalone `codex-app-server` package comes from Codex releases, so it cannot be installed in the container. Use the npm Codex CLI instead, and save `codexWorkers: "visible"` so workers start `codex app-server`. Visible worker threads land in the container's own Codex history, which is discarded with the container, so nothing shows up in Codex Desktop on your computer. Setup makes the same choice on its own when it runs in a cloud session.

## Sign in to Codex once

Skip this section if every worker uses Claude.

Give the cloud its own Codex login. Do not copy `~/.codex/auth.json` from your computer. Codex rotates its refresh token, so two copies of one login invalidate each other at the first refresh and force a new login on one side.

In a cloud session, remove the link that the setup script below makes, so the login writes a plain file. Then run the device login and finish it in your browser. You can ask Claude to run these, or enter them yourself with `!`:

```text
!rm -f ~/.codex/auth.json
!codex login --device-auth
```

Move the new login file to a folder that outlives the container and link it back. In a Claude Project, the project's shared folder at `/mnt/project-files/` outlives each thread:

```sh
mkdir -p /mnt/project-files/.codex-cloud
mv -f ~/.codex/auth.json /mnt/project-files/.codex-cloud/auth.json
ln -s /mnt/project-files/.codex-cloud/auth.json ~/.codex/auth.json
```

The setup script makes the same link in each new container. Codex writes refreshed tokens back through the link, so every later thread uses the current login. When Codex reports that the login expired or was revoked, repeat these steps from the `rm`.

Know the limits of this arrangement:

- The shared folder does not keep `600` permissions. Anyone who can read the project's files can read the login. Keep it out of shared projects and out of repositories.
- Two threads that refresh at the same moment can race. The loser may need a new device login.
- Outside a Claude Project there may be no folder that outlives the session. Sign in once per session there.

## Install pstack in the setup script

Add these steps to the environment's setup script. pstack needs Node.js 24.12+, and the container's `/root/.local/bin` comes first on PATH, so links there replace the preinstalled Node.js:

```sh
#!/bin/bash
set -euo pipefail
BIN=/root/.local/bin
mkdir -p "$BIN"

# Node.js 24, checked against the official checksums
if [ ! -x /opt/node24/bin/node ]; then
  base=https://nodejs.org/dist/latest-v24.x
  f=$(curl -fsS $base/SHASUMS256.txt | grep -oE 'node-v24[0-9.]+-linux-x64\.tar\.xz' | head -1)
  tmp=$(mktemp -d)
  curl -fsS -o "$tmp/$f" "$base/$f"
  (cd "$tmp" && curl -fsS $base/SHASUMS256.txt | grep " $f\$" | sha256sum -c -)
  mkdir -p /opt/node24 && tar -xJf "$tmp/$f" -C /opt/node24 --strip-components=1
  rm -rf "$tmp"
fi
export PATH=/opt/node24/bin:$PATH
for b in node npm npx; do ln -sf /opt/node24/bin/$b "$BIN/$b"; done

# Codex CLI and the shared cloud login (Codex workers only)
npm i -g @openai/codex >/dev/null
ln -sf /opt/node24/bin/codex "$BIN/codex"
mkdir -p /root/.codex
ln -sfn /mnt/project-files/.codex-cloud/auth.json /root/.codex/auth.json

# pstack
if ! claude plugin list 2>/dev/null | grep -q 'pstack-cc@pstack-cc'; then
  claude plugin marketplace add https://github.com/ystory/pstack.git
  claude plugin install pstack-cc@pstack-cc
fi
```

Each new container installs the default branch as it is at that moment, so new sessions pick up pstack updates without a script change. A session that is already running keeps the version it started with.

## Save your model choices in the script

Setup saves your choices in `~/.claude/pstack-cc/models.json` and registers matching agents under `~/.claude/agents/`. Both live in the container, so a new container starts without them. You can run `/pstack-cc:setup-pstack` in every session, but writing the file from the script is faster.

Run setup once in a cloud session, or reuse the file from your computer if its models are available in the cloud. Copy the file's contents into the script, then register the agents from it:

```sh
P=/root/.claude/pstack-cc
mkdir -p "$P"
cat > "$P/models.json" <<'JSON'
{"schemaVersion":1,"host":"claude-code","budget":"large","codexWorkers":"visible","roles":{
"bug-fix":{"executor":"claude-code","model":"claude-opus-5-5","reasoningEffort":"xhigh"},
"swarm workers":{"executor":"codex","model":"gpt-6.2-sol","reasoningEffort":"high"}
}}
JSON
S=$(find /root/.claude/plugins/cache/pstack-cc -path '*setup-pstack/scripts/register-agents.mjs' | sort -V | tail -1)
node "$S" >/dev/null
```

The roles above are only an example. Paste your own saved file. If you copy it from a computer that uses the standalone server, change `codexWorkers` to `visible`. The [models contract](../../skills/setup-pstack/references/models-contract.md) describes every field. Writing the file by hand skips setup's catalog check, so rerun `/pstack-cc:setup-pstack` once after you change models.

## Check a new session

Start a new session after saving the script, so the container runs it. `/pstack-cc:` commands should appear in the command list. For Codex workers, ask Claude to run the bundled detection:

```sh
node "$(find ~/.claude/plugins/cache/pstack-cc -name run-codex.mjs | sort -V | tail -1)" detect
```

A ready container reports `cli.workers` as `visible`, `cli.available` as `true`, and `auth.loggedIn` as `true`. Then run the first task from [Set up pstack](01-setup.md#run-your-first-task).

## Open, watch, and land PRs

The session's GitHub proxy refuses GraphQL, so `gh pr` commands fail there with `GitHub GraphQL is not available from Claude Code sessions`. REST still works through `gh api`. The PR watcher and the worktree audit switch to REST by themselves. The Opening a PR, Shipping, and Babysit playbooks send the agent to the matching REST routes in [GitHub REST fallback](../../skills/poteto-mode/references/github-rest.md). Pushes and PR writes reach only the repositories attached to the session.

## When something is missing

- **No `/pstack-cc:` commands.** The plugin was installed after Claude started, or the setup script failed before the install. Fix the script and start a new session.
- **Detection reports `standalone-app-server` with `ENOENT`.** The saved file has no `codexWorkers`, so it means `hidden`. Save `visible`.
- **Detection reports `auth.loggedIn` as `false`.** The link points at a file that does not exist yet, or the login expired. Repeat the sign-in steps above from the `rm`.
- **A `gh pr` command fails with HTTP 403.** GitHub refused GraphQL. Use its REST route from [GitHub REST fallback](../../skills/poteto-mode/references/github-rest.md).
- **A Codex host is refused.** Add the host to **Allowed domains**. Leave the network level at **Limited** unless the work needs more.

Back to [Set up pstack](01-setup.md).
