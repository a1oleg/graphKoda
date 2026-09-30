# Scoped extractor upgrades

Replacement mode permits a new extractor revision for the same source revision,
source dirty fingerprint and extraction options. Append mode retains the strict
same-provenance policy. Unknown provenance, changed source snapshots and changed
shared dependencies are rejected before mutation.

Scoped body imports do not request expansion of parameter origins into callers.
Existing external links are retained; changing a parameter's origin graph is a
separate operation, not an implicit side effect of replacing the callee body.
The parameter-origin target property alone is not proof of node ownership.

The importer checks all supplied facts for consistent provenance, then builds
the replacement scope from the requested function, explicit ownership and source
coordinates. Existing shared nodes must contain the incoming properties and
labels (ignoring provenance and importer-managed role lists). Equivalent shared
nodes and shared-source relationships outside the scope are removed from the
write payload, retaining their original provenance. A difference requires a
broader replacement; it is not overwritten silently.

Shared `functions` catalog rows labelled only `Fn` may use a call-site alias
instead of the existing canonical name. That name difference alone is ignored
for equivalence: the catalog row is omitted from writes, retaining the stored
name. This exemption does not apply to semantic entity rows, syntax, other
properties, labels, or source provenance. `dev/scopedCatalogNames.integration.py`
checks actual Telegram catalog aliases and the repaired GiftCraftModal preflight.
It is a read-only live-database integration check and expects the canonical text
repair described below to have been applied.

### Canonical text repair

`dev/streamingCanonicalText.integration.mts` exercises actual streaming extraction:
canonical names and syntax must survive composition emission. Rendering text stays
on composition occurrences rather than replacing source entity text.

`dev/repairCanonicalCompositionText.py --fn-stable-id <id> --report <path>`
compares fresh source-backed entities to the database without writing. `--apply`
requires proof for every changed shared entity and updates only name/syntax in
one transaction, with old values recorded in the report. Source provenance and
coordinates must match, and old text must match a stored render occurrence.
Optional `--source-root <path>` also verifies older destructuring/rest text using
the TypeScript AST. Unproven differences inside the requested function are reported
as deferred to scoped import, not repaired. Unknown shared differences abort.

The September 30 repair restored 241 definition texts and 512 operation texts.
GiftCraftModal and its two affected nested functions were subsequently imported
through the normal orchestrator API. Live verification confirms six context-specific
blocks, one explicit owner each, and no self-containment relationships.

### Scoped ownership boundary

Cleanup selects existing nodes explicitly owned by the requested function plus
nodes included in the validated replacement scope. Source coordinates alone no
longer delete omitted nested callback bodies or entities with unknown ownership.
Boundary collection uses the union of the old replacement set and the new scope,
and restores relationships crossing that boundary in both directions. Missing
endpoints still abort the transaction; no boundary relationship is silently dropped.
For replaced nodes, explicit `parentFlowBlockStableId` supersedes contradictory old
`NESTED_IN` edges; `supersededBoundaryOwnership` reports their count.

`dev/auditScopedOwnership.py <function-id>` inventories old coordinate-based cleanup.
`dev/scopedNestedOwnership.integration.py` exercises actual GiftCraftModal replacement
and rolls back. It verifies unchanged properties of 313 omitted entities and all
1,024 incident relationships, with annotations preserved. The subsequent live import
removed four obsolete ownership edges. `dev/verifyLiveFlowBlockOwnership.py` fails
unless all six block instances have exactly their explicit owner.

Preflight, cleanup, writing, restoration of external incoming relationships,
annotation restoration and import-run recording execute in one transaction.
The replacement result reports its policy, scope, preserved shared-node count
and previous provenance IDs. No database-wide label cleanup is performed during
scoped replacement.

Run `python dev/scopedProvenance.integration.py <actual-payload.json>` with the
real `_raiseCastFail` payload from `dev/throwBody.integration.mts`. It verifies
the new Throw node, preservation of shared dependencies and boundary links,
then rolls back and verifies the original function properties. No fabricated
graph is used.
