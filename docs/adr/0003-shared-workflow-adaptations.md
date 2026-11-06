---
status: accepted
---

# Share workflow adaptations across host distributions

Preserve original pstack behavior and user-selected hosts, worker executors, and models while maintaining common procedure changes once. Keep the separate distributions from [ADR 0001](0001-separate-host-distributions.md). Users still install committed, self-contained target trees from Git without a build.

Store common changes as patches under `patches/shared/`, referenced explicitly by each target's ordered series. The maintainer edits one output and uses `generate-shared-patch --from TARGET --name NAME --paths PATHS`. One patch is applied to both replay states before its references and other output are materialized. Native installation, registration, execution, authentication, and personal preferences stay host-specific. One shared receiving-worker context is injected automatically by the existing outbound wrappers. It preserves launching-host role choices while distinguishing the receiving executor from foreign native tool names and parent launch recipes.

Transfer How and No comments with target-specific full deletions followed by a shared addition. The original snapshots and historical patch bytes remain intact. A changed upstream body can conflict with that deletion input instead of being silently replaced by a final file copy. Use a common `execution.md` location with each host's actual binding, so portable workflow bodies need no host detector or extra fragment reads.

Regenerate shared candidates by their intermediate file states and shared nodes. A common postimage must remain a common patch and reproduce both target results. An unresolvable intermediate state remains a concrete candidate conflict. Byte and mode replay establishes reproducibility, while upstream semantic review and runtime checks remain separate.

We accept two complete installation trees and repeated shared references in exchange for native Git installs and preserved history. A third full common skill tree or a template language would duplicate the original source and add another maintenance format. Splitting each procedure into host wrappers and common fragments would add reading steps. Keeping two independently authored host patches would retain the drift that prompted this change.
