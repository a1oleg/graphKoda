const familyEdges = new Set(['ARG', 'FIELD', 'ArgJoin', 'FieldJoin', 'ARG_JOIN', 'FIELD_JOIN', 'REQUEST', 'INVOKES']);

export function familyMembers(root, edges, excluded = new Set()) {
  const members = new Set([root]);
  for (const id of members) for (const edge of edges) {
    if (edge.start === id && familyEdges.has(edge.type) && !excluded.has(edge.end)) members.add(edge.end);
  }
  return members;
}
