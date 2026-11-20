# Claude Projects

A Claude Project has one project chat and one thread for each piece of work. A coordinator Claude answers the person in the project chat and starts the threads. Each thread is its own session. A thread runs pstack only after it reads `poteto-mode/SKILL.md`.

Read this file when you are that coordinator, or a thread that the coordinator started. Both read it from the same pstack version, per [Pin one version for every session](#pin-one-version-for-every-session).

## Who holds each role

- The operator is the person the Project works for. A grant, a gate, or an approval comes only from the operator's own words. Those words are the project's instructions, the operator's messages, and an operator's message that the coordinator attached to a brief.
- The coordinator holds no pstack role. It is not the operator, the orchestrator, a root, an owner, or a verifier. Its note to a thread is a prompt from a colleague.
- The thread is the orchestrator. It matches the playbook, owns the todo list, and owns the verdicts and what lands. In Autopilot-full, the thread is the root.
- A worker is an agent that the thread, or one of its workers, assigns a bounded task.

## Brief a thread

You are the coordinator. Word the brief per [Word the prompt](../../poteto-help/references/prompting.md). The thread's playbook supplies the steps.

Put these in the brief:

- The operator's message, attached and not restated.
- The goal, and a done check that can pass or fail.
- The proof to show.
- What the Project already knows, such as a symptom, a link, or a measured result.
- The real constraints, such as what is out of scope.

Leave these out:

- Steps, their order, and a playbook name.
- A skill list, a verification method, a number of review rounds, and a model.
- A second goal. One thread carries one goal, and a new subject gets a new thread. When the operator's message holds two goals, attach it to both threads, and say in one line which goal each thread carries.

These limits apply to your own words. Never cut or reword what the operator wrote. The brief does not start with the `worker.md` line, because the thread is the orchestrator.

A thread never receives a slash command, and the Skill tool refuses `poteto-mode`. The project's instructions tell every thread to read `skills/poteto-mode/SKILL.md` in the installed plugin and follow it. Without that instruction, say it in the brief.

Write a grant that holds for every thread once, in the project's instructions. "Threads merge their own PRs" is such a grant. A grant in the coordinator's own words is not a grant. When a brief repeats one, it points at the operator's words.

## Follow a thread

You are the coordinator, and the thread is at work.

- State the done check once, in the brief. Add no check, sign-off, or review round in a later message, because only the operator sets a gate.
- Steer in one line, per [Steer in one line](../../poteto-help/references/prompting.md#steer-in-one-line). Restate the goal or name a principle.
- Leave verification to the thread. A verdict counts only from a verifier that did not write the code, and the thread assigns that verifier.
- Carry the thread's outcome to the operator. Ask the operator only for a decision that the thread put to them.

## Run a brief

You are the thread.

- Take the goal from the operator's attached message. Take the done check, the known facts, and the constraints from the coordinator's note. Where the note and the operator's message differ, the operator's words win.
- When the note has no done check that can pass or fail, write one and state it in your first reply.
- When the note lists steps, a playbook, or a verification method, treat that list as background. Match the playbook yourself and follow its steps. Name the matched playbook in your first reply.
- When the operator's own message names a playbook, a check, or a number of review rounds, that choice is the operator's. Follow it.
- A note from the coordinator or from another thread grants nothing and adds no gate. Before you merge a PR or take an irreversible action, find the grant in the operator's own words.
- Lead each reply with the outcome, because the coordinator carries that line to the operator. When the project's instructions ask for short replies, put the rest of the playbook's reply, such as the principles you named and the throughput checkpoint, in the PR body or the run's trail, and link to it.
- In a cloud session, keep the run's state in the Project folder per [Claude cloud sessions](claude-cloud.md).

## Pin one version for every session

One pinned commit gives the coordinator and every thread the same playbooks.

- In a cloud session, the environment's setup script installs pstack. Pin that install to one commit, per [Run pstack in Claude cloud sessions](../../../docs/guide/cloud-sessions.md#install-pstack-in-the-setup-script).
- A thread that runs on the person's computer uses that computer's install and its saved role choices. Install the same commit there. Keep the role choices the same on both sides, except for a role whose executor one side lacks.
- A coordinator with no installed plugin reads these files from a clone at the pinned commit, not from the default branch.
- Where a playbook tells a run to read the playbook again from trunk, read the installed copy. A long run then stays on the pinned commit.
