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
- Tiles store scalar/array `tile_*` properties and their field names, not `descriptorJson`.
  The transport compiler rejects nested unsupported properties instead of hiding them in JSON.
- Explicit routing aliases are resolved during extraction. The imported relationships address
  actual tile vertices. Unresolved or ambiguous aliases fail extraction.
- Computed assignment returns leave the closing tile when one exists; the renderer does not
  infer this endpoint for graph-backed mosaics.
- The shared graph loader validates tile count/order, consecutive links and Step ownership.
  It traverses compositions of separately loaded Steps/Blocks too. Missing links, cycles and
  cross-Step parts are errors even when all expected tiles exist.
- Geometry consumes `mosaicParts`, a transient grouped view of the vertex properties. No JSON
  is rebuilt. Grouped edge endpoints retain the actual vertex IDs for attachment to tiles;
  `sourceLayoutOwnerStableId`/`targetLayoutOwnerStableId` only select the coordinate group.
- Reimport Fisher before using this loader with an older v2 database: the importer removes
  obsolete descriptor JSON properties. Ordinary v1 diagrams keep their existing contract.
- Literal assignments use `WRITE -> ARGUMENT -> CLOSES`, with `layout: mosaic`
  and ordering on those semantic edges. The argument carries `index: 0, role: value`.
- For these assignments the declaration merges into the variable owner. All graph references
  are redirected; declarationSourceStableId preserves the source span. Initializer AST_CHILD
  and VALUE_FROM shortcuts are removed. The importer migrates external context/annotation
  edges transactionally before deleting the replaced declaration vertex.
- Other expression shapes still use MOSAIC_NEXT pending their semantic contracts; this
  experiment does not guess argument/write semantics from arbitrary punctuation.

Run `node --test dev/mosaicVerticesV2.test.mjs` and
`node --import tsx --test dev/mosaicVerticesV2.integration.test.mjs`.
The integration suite extracts all three real functions, checks endpoint existence, runs the
production loader against a graph fixture, and compares mosaic dimensions and draw.io tile
bounds with the previous representation. It does not replace an end-to-end Aura render check.

Then run `npm run fisher:import` and export to a separate comparison diagram with
`node dev/exportFisherYatesDrawio.mjs --output tmp/fisher-yates/graph-vertices.drawio`.
No onSubmit reimport is required.

Remaining: the common AST extractor still produces descriptors before this transport compiler.
AST coverage and contracts for every language construct are not established by chain validation.
In particular, a structurally connected but semantically incomplete expression needs additional
AST-to-graph coverage checks, not another layout repair pass.
