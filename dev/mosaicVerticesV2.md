# Mosaic vertices v2

Fisher-Yates opts into `mosaic-vertices/v2` at the extraction transport boundary.
All other entry points retain their existing v1 contract.

- The owner is the first tile. `MOSAIC_NEXT` links consecutive tiles, without a hub.
- Existing literal vertices are reused as argument tiles. Source syntax composition links
  on these owners are replaced, not retained alongside the mosaic chain.
- A synthetic Evaluate with only one ASSIGNS_VALUE edge is removed when its exact
  source is an inline literal already represented in the mosaic. Computed producers remain.
- Tile identity is owner + v2 + ordinal. Source coordinates are provenance, not identity.
- Virtual opening and closing tiles are materialized even when their source coordinates coincide.
- The owner records the contract version and expected part count, not a render-parts JSON copy.
- The renderer loads these nodes explicitly and validates completeness. Missing parts are errors.
- Existing geometry consumes an adapter built from the graph. Descriptor stableId remains the
  legacy routing alias; graphStableId identifies the actual tile vertex. Existing sourceRenderPart
  edge references therefore keep working. Migrating routing aliases and draw.io context metadata
  to vertex IDs is a separate remaining step, not part of this storage version.
- Literal assignments use `WRITE -> ARGUMENT -> CLOSES`, with `layout: mosaic`
  and ordering on those semantic edges. The argument carries `index: 0, role: value`.
- For these assignments the declaration merges into the variable owner. All graph references
  are redirected; declarationSourceStableId preserves the source span. Initializer AST_CHILD
  and VALUE_FROM shortcuts are removed. The importer migrates external context/annotation
  edges transactionally before deleting the replaced declaration vertex.
- Other expression shapes still use MOSAIC_NEXT pending their semantic contracts; this
  experiment does not guess argument/write semantics from arbitrary punctuation.

Run `node --test dev/mosaicVerticesV2.test.mjs`, then `npm run fisher:import`
and `node dev/exportFisherYatesDrawio.mjs`. No onSubmit reimport is required.
