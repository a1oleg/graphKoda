# speculationAccept Bloom demo

An authored source-based demonstration, not extractor output or a runtime trace.
Only the successful active-speculation acceptance path is shown. The optional
fourth REPL parameter (`options`) and other branches are intentionally omitted.
The origin edge describes construction of the argument object, not creation of
the existing speculation state carried in its `state` property.

All demo nodes and relationships are now materialized at installation. There is
no click counter and no APOC dependency. Bloom controls presentation locally.

## Perspective and coordinates

1. Refresh the Perspective after migration, then open a fresh Scene. Old Scenes
   may retain cached properties and the deleted relationship types.
2. Use two categories based on `DemoStage1` and `DemoStage2`. Do not use
   the broad `ColdKodeDemoNode` category to load the first stage. Omit the
   `ColdKodeDemo` control label. Include `NEXT` and `VALUE_FROM`.
3. Set the node caption to `name`. Make `x` and `y`
   available in the Perspective.
4. Start with an empty Scene and search for the `DemoStage1` label/category,
   or use `bloom-stage-1.cypher` as a read-only Saved Cypher Search phrase.
5. Select Coordinate layout, edit its settings, and explicitly choose `x`
   for the X axis and `y` for the Y axis. Both properties are integers.
   Adjust axis scales and zoom for readable captions, not a force layout.

The two function entries share y=0. REPL has x=0 and PromptInput has x=1000.
Each successive node has y=-180*ordinal. REPL is a straight display chain:

```text
REPL.onSubmit -> input -> helpers -> speculationAccept
```

`NEXT` between parameters expresses display order, not runtime execution order.
Ownership is retained as `ownerKey` and `parameterIndex` in this authored demo;
the extractor's actual `HAS_PARAMETER` schema has not been changed.

## Stage labels

Stages use actual, mutually exclusive Neo4j node labels, not property filters:

| Label | Nodes |
| --- | --- |
| DemoStage1 | Exactly 4: REPL.onSubmit, input, helpers, speculationAccept |
| DemoStage2 | Exactly 12: the PromptInput vertical through object creation |

First load only DemoStage1, then add DemoStage2. The third step reveals only
VALUE_FROM. Relationships cannot have node labels, so keep that relationship
type excluded until step 3, or use the Search phrases below for exact results.
The old stage/revealTag properties remain metadata, but are not needed for
stage selection. Coordinate positions and NEXT chains are unchanged.

Bloom filters grey out excluded elements rather than making them disappear.
Do not use Dismiss Filtered Elements when planning to reveal them by changing
the filter: dismissed elements must be loaded again. Scene clearing also clears
the filters. For a clean reveal without grey placeholders, use Search phrases.

## Read-only Search phrases

### Verified Bloom search-bar sequence

The [Bloom Demo Next Chrome extension](chrome-next/README.md) automates this
sequence with a Next button on the Bloom page, including detection of an
already-loaded first stage and result-count checks.

Tested in Aura Bloom with the Default Perspective on 2026-09-09. Saved Cypher
phrases are not required: use the ordinary graph search bar.

| Step | Search text | Result accumulated in the Scene |
| --- | --- | --- |
| 1 | `DemoStage1 NEXT DemoStage1` | 4 nodes, 3 NEXT relationships |
| 2 | `DemoStage2 NEXT DemoStage2` | 16 nodes, 14 NEXT relationships; no VALUE_FROM |
| 3 | `DemoStage1 VALUE_FROM DemoStage2` | 16 nodes, 14 NEXT + 1 VALUE_FROM |

Before each new search, click **Clear input** (the X in the search bar), enter
the next search text, wait for Bloom's graph-pattern suggestion, then press
Enter. Keep the Scene between steps: search results are added to it. These are
successive searches, not additional tokens appended to a single search pattern.
Do not use **Clear Scene** between steps. Use **Fit all nodes** after step 2
if the second function is outside the viewport.

The third search adds only the link between `speculationAccept?` and
`{ state, speculationSessionTimeSavedMs, setAppState }`. To restart, reopen an
unchanged first-stage Scene or clear the working Scene and run step 1 again.
Running step 1 over a full Scene does not remove stages 2 and 3.

### Saved Cypher alternative

In Perspective designer -> Saved Cypher, register these static Search phrases:

| Phrase | Query file |
| --- | --- |
| specAcc 1 | bloom-stage-1.cypher |
| specAcc 2 | bloom-stage-2.cypher |
| specAcc 3 | run.cypher |

Start in an empty Scene and run phrases 1, 2, 3 in that order. They return:

1. REPL.onSubmit and its first three parameters: 4 nodes, 3 relationships.
2. Add PromptInput.onSubmit through object construction: 16 nodes, 14 relationships.
3. Add the authored origin edge: 16 nodes, 15 relationships.

The full stage is returned each time, so it can also be loaded in a new Scene.
Do not Reveal Relationships / expand across VALUE_FROM before step 3: the edge
already exists in the database. To return to step 1, clear the Scene and run
phrase 1; running it over a full Scene does not remove previously loaded nodes.

`reset.cypher` is now a read-only first-stage query, not a database deletion.
The UI's Perspective/Scene configuration is manual; it is not installed by Python.

## Installation and verification

Run `.venv/Scripts/python.exe graph/demos/speculation-accept/install.py`.
Credentials come from ignored `graph/.env`; sourceRoot comes from projectPaths.
The installer executes `bake.cypher`, tests counts, tags, coordinates, edge types,
and idempotent reinstallation in one transaction, then commits. On failure it
rolls back. Only this authored demo is migrated; extracted facts are untouched.
The old Russian relationship, HAS_PARAMETER fan-out, DEMO_NEXT and stored
APOC script/counter are removed. Existing demo node IDs are preserved.

The origin summary now uses VALUE_FROM, a relationship name present in the
extractor, with authored=true and derived=true. The direct parameter-to-object
edge summarizes the actual argument binding/value chain; it does not claim the
extractor already emits that exact shortcut.

The installer checks the frozen source revision before using authored locations.
Database behavior is integration-tested against Aura. Bloom visual layout and
filter interactions require manual verification in the user's Scene.

References:
- https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/
- https://neo4j.com/docs/bloom-user-guide/current/bloom-tutorial/search-phrases-advanced/
