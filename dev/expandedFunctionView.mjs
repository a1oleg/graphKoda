// View settings do not alter extracted facts or standalone function diagrams.
export const expandedFunctionView = Object.freeze({
  kind: 'expanded-functions',
  secondaryParameters: 'hidden',
  alignCalledStart: true,
});

export function omitEntryParameters(nodes, edges, fnId) {
  const owner = n => n.props?.parentFnStableId || n.props?.parent_fn_stable_id;
  const step = n => n.props?.parentStepStableId || n.props?.parent_step_stable_id;
  const parameters = nodes.filter(n => n.labels.includes('Parameter') && owner(n) === fnId);
  const steps = new Set(parameters.map(step).filter(Boolean));
  const hidden = new Set(nodes.filter(n => parameters.includes(n) || steps.has(n.key) || steps.has(step(n))).map(n => n.key));
  const outgoing = new Map();
  for (const e of edges) {
    if (!outgoing.has(e.start)) outgoing.set(e.start, []);
    outgoing.get(e.start).push(e);
  }
  const retained = edges.filter(e => !hidden.has(e.start) && !hidden.has(e.end));
  for (const entry of edges.filter(e => e.type === 'NEXT' && !hidden.has(e.start) && hidden.has(e.end))) {
    const queue = [entry.end], seen = new Set(), targets = new Set();
    while (queue.length) {
      const id = queue.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of outgoing.get(id) || []) {
        if (hidden.has(e.end)) queue.push(e.end);
        else if (e.type === 'NEXT') targets.add(e.end);
      }
    }
    if (targets.size !== 1) throw new Error(`Parameter view requires one body continuation, got ${targets.size}`);
    retained.push({ ...entry, end: [...targets][0], props: { displayLabel: '', viewProjection: 'omit-entry-parameters' } });
  }
  return { nodes: nodes.filter(n => !hidden.has(n.key)), edges: retained };
}
