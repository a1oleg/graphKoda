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
