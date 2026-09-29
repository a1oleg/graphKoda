# Step Integrity Contract

Status: specification v2, not an implemented validator. Machine-readable rules:
`step-integrity.contract.json`. Existing endpoint and ownership checks cover only
parts of this contract. Successful import does not certify Step integrity.

## Two validation levels

**Language coverage:** compare compiler AST constructs with the extractor's
explicit handler/exclusion registry. Report unsupported constructs, including
operator variants and syntactic roles within the same SyntaxKind. A generic
visitor or a successful parse does not demonstrate extractor support. Registered
handling is only a level-one result, not proof of a correct generated graph.

Keep two coverage scopes separate: syntax encountered in the selected project,
and the language catalog for the selected compiler version. Constructs absent
from Telegram are untested, not supported by implication. Compiler syntax-kind
aliases and sentinel values are not independent language features. Even covering
all kinds does not prove all combinations of language constructs are supported.

**Graph correctness:** check the output of supported transformations for missing
operations, connectivity, ownership, evaluation order, data roles and boundaries.
Use local contracts for language constructs, not layout rules. A connected graph
can still reverse a write, misbind an argument or unconditionally run a callback.

These are validation levels, not a mandate to persist two graphs. Compiler AST
can be traversed directly. No additional full AST graph in Neo4j is required.

## Independent inputs

1. Parse the exact source revision with the source project's compiler settings.
   A syntax-rule registry inventories occurrences, semantic roles and required
   evaluation/data constraints independently of graph builders and renderers.
2. Read the extracted graph and explicit mappings from source occurrences to
   semantic graph entities and relationships.
3. Compare these inputs. Do not derive expected operations from the emitted graph:
   that would make omissions invisible. Do not infer coverage from display text.

Inventory the source before enumerating extracted Steps. Otherwise a wholly
missing Step would never enter the audit. The inventory does not require a second
renderer or duplicate graph topology: it records obligations and source identity.

## Coverage

Identify an occurrence by file, source content hash and AST offsets. A stableId
is a graph address, not proof that the underlying source is unchanged.

Syntax rules classify every visited occurrence as runtime, structurally absorbed,
non-runtime, or unsupported. Their semantic roles distinguish reads, writes,
calls, arguments, allocation, member/index access, operators and control transfer.
Binding positions are not identifier reads. Shorthand properties can carry both
property and read roles. Type syntax is non-runtime; enum/decorator behavior and
other emitted constructs require explicit rules, not a blanket TypeScript skip.

Parentheses and other transparent wrappers may be absorbed by named rules. A
composite graph node can represent several operations, provided each occurrence
and role has a mapping. A large source span does not cover everything inside it.
JSON render parts are not semantic coverage evidence unless their semantics and
source mappings are explicitly available to the auditor independently of drawing.

The syntax registry is fail-closed for unsupported kinds. A registered semantic
rule with missing graph evidence produces `fail`; an absent syntax rule produces
`unknown`. Neither is counted as successfully checked.

## Ownership and execution

Connectivity is checked per execution/data region against declared entry/exit
and value boundaries. Do not demand one connected component for a Step and every
nested callback body together. Their separation can be correct. Do not accept
AST containment or ownership edges as a repair for missing execution/data paths.

An execution occurrence has one direct Step/structural owner. Canonical symbols
may be referenced from many Steps without acquiring many execution owners.
Lexical ownership and contextual expansion identity are separate: an inlined
callback may have several instances, all tracing back to the same source body.

Check language-required partial order, not a single flattened sequence. Rules
must preserve short-circuit branches, optional chaining, assignment evaluation,
loops, return/throw, break/continue and async suspension. A reachability path made
of arbitrary relationships is not execution evidence. Unknown callee behavior
must not be replaced by an assumed immediate callback invocation.

Function/callback creation does not execute its body. Audit the body under its
own lexical owner; link invocation through separately supported call semantics.

## Data and boundaries

Check the roles of endpoints: producer -> argument/operand/result consumer, and
evaluated value -> write target. A structurally connected but reversed or wrongly
bound edge fails. External symbols and function contracts can remain boundary
entities; proving a Step does not require expanding every caller or callee.

Cross-Step edges are not inherently errors. Classify entries, ordinary exits,
abrupt exits, calls, reads/writes and async boundaries before validating them.
Structural ownership edges cannot substitute for missing execution/data edges.

The real Telegram case `src/util/debugOverlay.ts`, `counters = {}` inside the click
callback, requires an empty-object creation and a write to the captured binding,
mapped to the callback instance. It must not silently reference the outer/raw
assignment ID when the graph materializes a contextual ID.

## Reporting and rollout

Report the two levels separately. Within graph correctness, report coverage,
connectivity, ownership, execution, data and boundaries separately. A Step passes
only when all applicable obligations pass. A failure
takes precedence over unknown, but unknown findings remain visible in the report.
An unimplemented level is unknown, never an empty successful check.

Reports include total source regions, mapped and missing regions, unsupported
syntax by kind, mapping counts, and stable/source IDs for findings. Completeness
is relative to a versioned rule set, not a claim of universal language support.

Implement in this order:

1. Compiler AST traversal and explicit extractor handler/exclusion registry;
   report project syntax coverage separately from language catalog coverage.
2. Extractor occurrence-role mappings and ownership/boundary evidence, without
   requiring a persisted compiler AST graph.
3. Coverage, connectivity and ownership comparison on real Telegram Steps,
   including missing Steps and legitimately separate callback bodies.
4. Evaluation and producer-consumer contracts, added by supported syntax variant.
5. Read-only whole-project audit; no automatic graph repair or silent exclusions.

Use real source cases for regression checks. The graph is not to be rewritten
merely to make the checks pass. First establish whether a finding is an extractor
omission, an invalid mapping or an incomplete audit rule.
