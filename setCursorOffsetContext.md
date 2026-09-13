# setCursorOffset: compact context plan

Source run: `11516ece-e3a6-4a5c-9796-abf3d6064eae`, revision 372.
Plan: `0a8fc7d7f5245e1b33c67fdcd99561eac1bcf2f2099cc81ba22cc205a3d0a248`.

Explicit target: `utils/Cursor.ts:169:59:169:65` (offset use in Cursor.fromText).
This is a selected intermediate target, not a discovered terminal effect.

377 recorded tasks -> 23 selected contexts -> 8 nodes, 7 edges.
Two distinct invocation contexts remain distinct. No name-based dispatch.
Status: `TARGET_SLICE_ONLY`; the final uses remain unresolved.

```cypher
MATCH (a:ValueContextStep)-[r:CONTEXT_NEXT]->(b:ValueContextStep)
WHERE a.planId = '0a8fc7d7f5245e1b33c67fdcd99561eac1bcf2f2099cc81ba22cc205a3d0a248'
RETURN a, r, b
```

Each edge contains `evidenceEdgeIndexes` into the saved discovery edges.
The ValueContextPlan.stateJson contains the corresponding low-level evidence.
The prototype selects and compacts a recorded discovery, not yet a replacement
for discovery itself. It creates no annotations and does not resolve missing
return-value, state-consumer or context-provider links.

Rebuild:

```powershell
node dev/buildValueContextPlan.mjs 11516ece-e3a6-4a5c-9796-abf3d6064eae utils/Cursor.ts:169:59:169:65
```
