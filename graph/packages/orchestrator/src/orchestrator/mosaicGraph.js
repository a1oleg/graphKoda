// Geometry groups tiles; graph relationships still address the actual vertices.
export function mosaicPart(props) {
  if (!Array.isArray(props.tileFields)) throw new Error(`Mosaic requires reimport: ${props.stableId}`);
  return { ...Object.fromEntries(props.tileFields.map(key => [key, props[`tile_${key}`]])),
    stableId: props.stableId, graphStableId: props.stableId };
}

export function validateMosaicChains(nodes, edges) {
  const groups = new Map();
  for (const node of nodes) {
    if (!node.props?.mosaicContractVersion) continue;
    const owner = node.props.ownerStableId;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(node);
  }
  for (const [owner, parts] of groups) {
    parts.sort((a, b) => Number(a.props.partOrder) - Number(b.props.partOrder));
    const head = parts.find(n => n.key === owner);
    if (!head || parts.length !== Number(head.props.mosaicPartCount)
      || parts.some((n, i) => Number(n.props.partOrder) !== i)) throw new Error(`Incomplete mosaic: ${owner}`);
    const links = edges.filter(e => e.props?.ownerStableId === owner && e.props?.layout === 'mosaic');
    if (links.length !== parts.length - 1) throw new Error(`Broken mosaic chain: ${owner}`);
    for (let i = 1; i < parts.length; i++) {
      if (links.filter(e => e.start === parts[i - 1].key && e.end === parts[i].key).length !== 1) {
        throw new Error(`Broken mosaic chain: ${owner} at ${i}`);
      }
      if (parts[i].props.parentStepStableId !== head.props.parentStepStableId) {
        throw new Error(`Mosaic crosses Step ownership: ${parts[i].key}`);
      }
    }
  }
  return groups;
}

export function projectMosaicGraph(nodes, edges) {
  const groups = validateMosaicChains(nodes, edges);
  if (!groups.size) return { nodes, edges };
  const byId = new Map(nodes.map(n => [n.key, n]));
  const projected = nodes.filter(n => !n.props?.mosaicContractVersion || n.props.ownerStableId === n.key)
    .map(n => groups.has(n.key) ? { ...n, mosaicParts: groups.get(n.key).map(p => mosaicPart(p.props)) } : n);
  const projectedEdges = edges.filter(e => e.props?.layout !== 'mosaic').map(edge => {
    const result = { ...edge, props: { ...edge.props } };
    for (const [side, endpoint] of [['source', 'start'], ['target', 'end']]) {
      const tile = byId.get(edge[endpoint]);
      if (!tile?.props?.mosaicContractVersion) continue;
      result[endpoint] = edge.props?.[`${side}LayoutOwnerStableId`] || tile.props.ownerStableId;
      if (!byId.has(result[endpoint])) throw new Error(`Missing layout owner: ${result[endpoint]}`);
      // These are real vertex IDs, not aliases into a JSON descriptor.
      if (edge.props?.[`${side}LayoutOwnerStableId`] || tile.key !== tile.props.ownerStableId) {
        result.props[`${side}RenderPartStableId`] = tile.key;
      }
      result.props[`${side}GraphVertexStableId`] = tile.key;
    }
    return result;
  });
  return { nodes: projected, edges: projectedEdges };
}
