# Fixed Annotation Readiness Issues

`trackAnnotationReadinessIssues.py` keeps a fixed cohort of `blocked-*` and
`review-*` findings from one complete extraction snapshot. It does not extract,
import, write Neo4j, or generate annotations.

Arguments:

- `--baseline`: complete snapshot containing `summary.json` and `inventory/annotation-plan.parquet`.
- `--source-root`: actual source checkout used by integration validators.
- `--output`: ledger directory; the report is `issues.json`.
- `--evidence BEFORE AFTER VALIDATOR`: repeat for each scoped fix. Pass snapshot
  directories and the repository's real-source `.mts` integration validator.

Every invocation reruns the validators against their scoped snapshots. Both
snapshots must have the baseline's source revision and dirty fingerprint. A
baseline stableId is `confirmed-scoped` only when its scoped before-plan has a
finding, its after-plan is neither blocked, under review nor deferred, and the
validator succeeds. Overlapping checks count the stableId only once.

A targeted validator can return `confirmedStableIds` to restrict confirmation to
the exact cases it checked. Other changed decisions in that snapshot are not
counted. This allows a small scoped snapshot to be compared with the frozen full
baseline without certifying unrelated findings.

For malformed coordinates, a validator may return `replacedStableIds` containing
`stableId` and `replacementStableId`. The old finding must disappear from the
after-graph and its real replacement must exist without a blocked/review decision.
The ledger records this as `source-identity-repair`. A replacement outside the
scope may remain deferred; `sourceExpansionStillDeferred` explicitly records that
the coordinate repair does not certify complete context extraction.

All prior evidence must be supplied again when updating an existing ledger.
Changing the baseline or dropping checks is rejected. The JSON includes exact
stableIds, original decisions, check commands, verification results, and resulting
context targets. `openByDecision` groups the remaining original findings.

The remaining count is for this cohort only. New findings and full-graph effects
of fixes are not certified by scoped tests. Run one fresh full snapshot at the end
to check those separately; do not replace the fixed baseline during repairs.
