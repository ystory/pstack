---
status: accepted
---

# Maintain separate host distributions in one repository

Maintain the existing Codex distribution and add a separately packaged Claude Code distribution in this repository. Both use the same locked pstack source and share role semantics, while each host owns its installation, execution binding, and role-model preferences. This keeps upstream updates together and lets users change their Claude setup without changing their Codex setup.

The goal is to make pstack available in Claude Code with user-selectable Claude or Codex workers. The host and worker executor are separate choices. A particular orchestrator model or fixed assignment of models to roles is not part of this decision.

A separate repository would isolate experiments but require synchronizing source updates and adaptations across two projects. Separate host distributions retain that isolation for consumers within one maintenance project. Both host targets are implemented. Their verified scope is recorded in [Design and compatibility](../spec.md).
