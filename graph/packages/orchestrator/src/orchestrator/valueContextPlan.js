import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Evidence paths are not execution contexts. Keep call bindings and selected
// members distinct, but do not repeat work merely because arrival paths differ.
export function contextIdentity(node) {
  const c = node.context || {};
  return hash([node.stableId, c.selection, c.memberPath || [], c.frames || [],
    c.parameterId, c.callSiteId, c.argumentIndex, c.parameterIndex,
    c.memberDeclarationId, c.objective, c.purposeState]);
}

export function buildValueContextPlan(source, targetStableId) {
  if (!targetStableId) throw new Error('An explicit targetStableId is required');
  const nodes = new Map(), aliases = new Map();
  for (const n of source.nodes) {
    const id = contextIdentity(n);
    aliases.set(n.id, id);
    if (!nodes.has(id)) nodes.set(id, { id, stableId: n.stableId, context: n.context,
      sourceTaskIds: [], states: [], reasons: [] });
    const group = nodes.get(id);
    group.sourceTaskIds.push(n.id);
    if (!group.states.includes(n.state)) group.states.push(n.state);
    if (n.reason && !group.reasons.includes(n.reason)) group.reasons.push(n.reason);
  }
  let edges = [];
  source.edges.forEach((e, index) => {
    const from = aliases.get(e.from), to = aliases.get(e.to);
    if (!from || !to) throw new Error('Source edge has a missing endpoint');
    const existing = edges.find(x => x.from === from && x.to === to && x.kind === e.relation);
    if (existing) existing.evidenceEdgeIndexes.push(index);
    else edges.push({ from, to, kind: e.relation, evidenceEdgeIndexes: [index] });
  });
  const rootId = aliases.get(source.rootId);
  const targets = [...nodes.values()].filter(n => n.stableId === targetStableId).map(n => n.id);
  if (!targets.length) throw new Error('Target is absent from the recorded discovery; do not invent a route');
  const reachable = (seeds, reverse) => {
    const seen = new Set(seeds), queue = [...seeds];
    while (queue.length) {
      const id = queue.shift();
      for (const e of edges) {
        if ((reverse ? e.to : e.from) !== id) continue;
        const next = reverse ? e.from : e.to;
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen;
  };
  const forward = reachable([rootId], false), backward = reachable(targets, true);
  const selected = new Set([...forward].filter(id => backward.has(id)));
  if (!selected.has(rootId)) throw new Error('No recorded route from root to target');
  const selectedCount = selected.size;
  edges = edges.filter(e => selected.has(e.from) && selected.has(e.to));
  for (const id of nodes.keys()) if (!selected.has(id)) nodes.delete(id);
  const anchors = new Set([rootId, ...targets]);
  // Preserve real responsibility crossings, not individual reference tiles.
  for (const e of edges) if (['WRITES_TO', 'BINDS_TO_PARAMETER', 'CONSUMES_VALUE'].includes(e.kind)) anchors.add(e.to);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of nodes.keys()) {
      if (anchors.has(id)) continue;
      const incoming = edges.filter(e => e.to === id), outgoing = edges.filter(e => e.from === id);
      if (incoming.length !== 1 || outgoing.length !== 1) continue;
      const a = incoming[0], b = outgoing[0];
      if (a.from === id || b.to === id || a.from === b.to) continue;
      edges = edges.filter(e => e !== a && e !== b);
      edges.push({ from: a.from, to: b.to, kind: 'VALUE_TRANSFER',
        evidenceEdgeIndexes: [...new Set([...a.evidenceEdgeIndexes, ...b.evidenceEdgeIndexes])] });
      nodes.delete(id); changed = true; break;
    }
  }
  return { version: 1, sourceRunId: source.runId, sourceRevision: source.revision,
    rootId, targetStableId, targetIds: targets.filter(id => nodes.has(id)),
    status: 'TARGET_SLICE_ONLY', fullMechanismVerified: false,
    stats: { sourceTasks: source.nodes.length, uniqueContexts: new Set(aliases.values()).size,
      selectedContexts: selectedCount, highLevelNodes: nodes.size, highLevelEdges: edges.length },
    nodes: [...nodes.values()], edges,
    evidence: source.edges.map((e, index) => ({ index, ...e,
      fromStableId: source.nodes.find(n => n.id === e.from)?.stableId,
      toStableId: source.nodes.find(n => n.id === e.to)?.stableId }))
      .filter(e => edges.some(edge => edge.evidenceEdgeIndexes.includes(e.index))) };
}

export async function saveValueContextPlan(session, plan) {
  const planId = hash([plan.version, plan.sourceRunId, plan.sourceRevision, plan.targetStableId]);
  await session.executeWrite(async tx => {
    const source = await tx.run('MATCH (r:ValueOriginRun {runId:$id}) RETURN r.stateJson AS state', { id: plan.sourceRunId });
    if (source.records.length !== 1 || JSON.parse(source.records[0].get('state')).revision !== plan.sourceRevision)
      throw new Error('Source discovery is missing or has changed; rebuild the context plan');
    await tx.run(`MATCH (source:ValueOriginRun {runId:$sourceId})
      MERGE (plan:ValueContextPlan {planId:$id})
      SET plan.stateJson=$json, plan.status=$status
      MERGE (plan)-[:DERIVED_FROM]->(source)`, {
      sourceId: plan.sourceRunId, id: planId, json: JSON.stringify(plan), status: plan.status,
    });
    await tx.run(`MATCH (plan:ValueContextPlan {planId:$id})
      UNWIND $nodes AS n
      MERGE (step:ValueContextStep {planId:$id, contextId:n.id})
      SET step.stableId=n.stableId, step.sourceTaskIds=n.sourceTaskIds, step.states=n.states
      MERGE (plan)-[:HAS_CONTEXT_STEP]->(step)`, { id: planId, nodes: plan.nodes });
    const groupedEdges = new Map();
    for (const edge of plan.edges) {
      const key = JSON.stringify([edge.from, edge.to, edge.kind]);
      const old = groupedEdges.get(key);
      groupedEdges.set(key, { ...edge, evidenceEdgeIndexes: [...new Set([...(old?.evidenceEdgeIndexes || []), ...edge.evidenceEdgeIndexes])] });
    }
    await tx.run(`UNWIND $edges AS e
      MATCH (a:ValueContextStep {planId:$id, contextId:e.from}), (b:ValueContextStep {planId:$id, contextId:e.to})
      MERGE (a)-[r:CONTEXT_NEXT {kind:e.kind}]->(b)
      SET r.evidenceEdgeIndexes=e.evidenceEdgeIndexes`, { id: planId, edges: [...groupedEdges.values()] });
  });
  return planId;
}
