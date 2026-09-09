# speculationAccept Browser demo

An authored source-based demonstration, not extractor output or a runtime trace.
Only the successful active-speculation acceptance path is shown. The optional
fourth REPL parameter (`options`) and other branches are intentionally omitted.
The origin edge describes construction of the argument object, not creation of
the existing speculation state carried in its `state` property.

Run `run.cypher` repeatedly in Aura Query / Neo4j Browser using Graph view:

1. REPL.onSubmit and its first three parameters: 4 nodes, 3 relationships.
2. Add PromptInput.onSubmit through object construction: 16 nodes, 14 relationships.
3. Add the authored origin edge: 16 nodes, 15 relationships.

Further runs increment the persistent click counter but retain the final graph.
The counter is shared by everyone running this demo in the same database.
Each result includes the entire revealed graph; Browser controls its layout.
The stage-three edge does not exist before the third run, including when Browser
automatically connects result nodes.

`reset.cypher` deletes only this demo's `ColdKodeDemoNode` nodes and resets its
counter. It preserves the stored script and does not touch extracted graph facts.

Install or update using `.venv/Scripts/python.exe graph/demos/speculation-accept/install.py`.
Credentials are read from ignored `graph/.env`. The installer stores `step.cypher`
on a `ColdKodeDemo` control node, then tests all stages and reset in a transaction
that is rolled back. Existing progress is preserved. The short runner requires
`apoc.cypher.doIt`, verified available in the target Aura instance.

The source locations refer to the frozen claude-code-source checkout; the demo
stores its Git revision. Recheck the authored locations before adapting it to
another source revision. `step.cypher` can also be run directly after installation.
