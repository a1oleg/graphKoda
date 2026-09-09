import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value?.toNumber ? value.toNumber() : Array.isArray(value)
  ? value.map(plain) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, plain(value[key])])) : value;

// These are executable selectors, not instructions to a language model.
export const routeRules = Object.freeze([
  { id: 'parameter-bindings', labels: ['Parameter'], probe: 'bindings' },
  { id: 'object-creation', labels: ['ObjectConstruction'], exclude: ['ValueDeclaration', 'Type'], probe: 'owner' },
  { id: 'literal-origin', labels: ['Literal', 'LiteralValue'], probe: 'none' },
  { id: 'external-origin', labels: ['ExternalBoundary'], exclude: ['DeveloperDefined', 'Type', 'TypeReference'], probe: 'none' },
  { id: 'value-transfer', labels: ['ArgumentValue', 'PropertyValue', 'ValueReference', 'Reference'], probe: 'transfer' },
]);
export const routeContract = Object.freeze({ version: 1, objective: 'object-origin',
  evidence: 'static-candidates-not-runtime', rules: routeRules,
  identity: 'entity-and-call-binding-not-arrival-history',
  invalidation: 'revalidate-all-read-fact-sets-including-negative-results',
  annotation: 'no-text-generation-or-implicit-legacy-annotation-cache' });

const nodeProjection = `n { .stableId, .name, .syntax, .declarationKind, .provenance_id,
  .source_state_id, .repoRelativePath, .startLine, .startColumn, .endLine, .endColumn,
  labels: labels(n) }`;
const edgeProjection = `r { .index, .propertyName, .resolution, .provenance_id,
  from: startNode(r).stableId, to: endNode(r).stableId, relation: type(r) }`;

// Hard adapter: only structural facts. Never read renderer coordinates or annotations.
export async function readRouteFacts(tx, stableId, probe) {
  let query;
  if (probe === 'node') query = `MATCH (n {stableId:$id}) RETURN ${nodeProjection} AS fact LIMIT 2`;
  else if (probe === 'bindings') query = `MATCH (a)-[r:BINDS_TO_PARAMETER]->(p {stableId:$id})
    OPTIONAL MATCH (c)-[h:HAS_ARGUMENT]->(a)
    RETURN ${edgeProjection} AS edge, c.stableId AS callSiteId, h.index AS argumentIndex,
      h { .index, .resolution, from: c.stableId, to: a.stableId, relation: type(h) } AS supplied
    ORDER BY callSiteId, edge.from LIMIT 501`;
  else if (probe === 'owner') query = `MATCH (a {stableId:$id})-[r:ENCLOSED_BY]->(n:FunctionImplementation)
    RETURN ${edgeProjection} AS edge, ${nodeProjection} AS owner ORDER BY edge.to LIMIT 501`;
  else if (probe === 'transfer') query = `MATCH (a {stableId:$id})-[r:VALUE_FROM|RESOLVES_TO|READS_FROM]->(n)
    RETURN ${edgeProjection} AS edge ORDER BY edge.relation, edge.to LIMIT 501`;
  else throw new Error('Unknown hard-fact probe');
  const result = await tx.run(query, { id: stableId });
  const rows = result.records.map(record => plain(record.toObject()));
  for (const row of rows) {
    if (row.fact?.labels) row.fact.labels.sort();
    if (row.owner?.labels) row.owner.labels.sort();
  }
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return rows;
}

export function routeTaskId(stableId, context = {}) {
  return hash([routeContract.version, stableId, plain(context)]);
}
function makeTask(stableId, context = {}, depth = 0) {
  return { id: routeTaskId(stableId, context), stableId, context, depth, state: 'PENDING', results: [] };
}
export function initialRoute({ stableId, maxTasks = 100 }) {
  if (!String(stableId || '').trim()) throw new Error('stableId is required');
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 1000) throw new Error('maxTasks must be 1..1000');
  const root = makeTask(stableId);
  return { runId: randomUUID(), version: routeContract.version, objective: routeContract.objective,
    coverage: 'loaded-hard-graph-only',
    revision: 0, maxTasks, rootId: root.id, status: 'PAUSED', nodes: [root], edges: [],
    probes: [], events: [], results: [] };
}

export async function inspectRouteTask(read, task) {
  const probes = [];
  async function probe(kind) {
    const rows = await read(task.stableId, kind);
    probes.push({ stableId: task.stableId, kind, fingerprint: hash(rows) });
    return rows;
  }
  const nodes = await probe('node');
  const gap = reason => ({ probes, reason, children: [], results: [] });
  if (nodes.length !== 1) return gap('ENTITY_MISSING_OR_AMBIGUOUS');
  const node = nodes[0].fact;
  if (node.labels.includes('Call') || node.labels.includes('CallResult'))
    return gap('CALL_RESULT_SLICE_REQUIRED');
  const rule = routeRules.find(r => r.labels.some(label => node.labels.includes(label))
    && !(r.exclude || []).some(label => node.labels.includes(label)));
  if (!rule) return gap('NO_ORIGIN_RULE');
  const rows = rule.probe === 'none' ? [] : await probe(rule.probe);
  const base = { probes, rule: rule.id, node, children: [], results: [] };
  if (rows.length > 500) return { ...base, reason: 'FACT_LIMIT' };
  if (rule.id === 'object-creation') {
    if (rows.length !== 1) return { ...base, reason: 'LEXICAL_OWNER_MISSING_OR_AMBIGUOUS' };
    return { ...base, results: [{ kind: 'CREATED_IN', creationId: task.stableId,
      ownerId: rows[0].owner.stableId, context: task.context, evidence: [rows[0].edge] }] };
  }
  if (rule.probe === 'none') return { ...base, results: [{
    kind: rule.id === 'literal-origin' ? 'LITERAL' : 'EXTERNAL_BOUNDARY',
    stableId: task.stableId, context: task.context, evidence: [] }] };
  if (rule.id === 'parameter-bindings') {
    const valid = rows.filter(row => row.callSiteId && Number.isInteger(row.edge.index)
      && row.edge.index === row.argumentIndex && row.edge.from);
    return { ...base, reason: !rows.length ? 'BINDINGS_MISSING' : valid.length !== rows.length ? 'BINDING_CONTEXT_MISSING' : null,
      children: valid.map(row => ({ stableId: row.edge.from,
        context: { ...task.context, bindings: [...(task.context.bindings || []), {
          parameterId: task.stableId, callSiteId: row.callSiteId,
          argumentId: row.edge.from, index: row.argumentIndex }] },
        evidence: [row.edge, row.supplied], relation: 'PARAMETER_ORIGIN' })) };
  }
  // A value edge is more precise than symbol resolution when both exist.
  // A declaration alone is not a reaching-definition proof.
  const selected = rows.some(row => row.edge.relation === 'VALUE_FROM')
    ? rows.filter(row => row.edge.relation === 'VALUE_FROM') : rows;
  return { ...base, reason: selected.length ? null : 'VALUE_SOURCE_MISSING',
    children: selected.filter(row => row.edge.to).map(row => ({ stableId: row.edge.to,
      context: task.context, evidence: [row.edge], relation: 'VALUE_ORIGIN' })) };
}

export function applyRouteStep(plan, taskId, expansion) {
  const next = structuredClone(plan), task = next.nodes.find(n => n.id === taskId);
  if (!task || task.state !== 'PENDING') throw new Error('Pending task required');
  task.rule = expansion.rule || null;
  task.fact = expansion.node || null;
  task.reason = expansion.reason || null;
  task.results = expansion.results;
  task.state = task.reason ? 'GAP' : expansion.children.length ? 'WAITING' : 'READY';
  next.probes.push(...expansion.probes);
  for (const child of expansion.children) {
    const repeatedBinding = child.context.bindings?.some((binding, index, all) =>
      all.findIndex(other => JSON.stringify(binding) === JSON.stringify(other)) !== index);
    if (repeatedBinding) { task.reason = 'RECURSIVE_BINDING'; task.state = 'GAP'; continue; }
    const candidate = makeTask(child.stableId, child.context, task.depth + 1);
    if (!next.nodes.some(n => n.id === candidate.id)) {
      if (next.nodes.length >= next.maxTasks) { task.state = 'GAP'; task.reason = 'TASK_LIMIT'; continue; }
      next.nodes.push(candidate);
    }
    const edge = { from: task.id, to: candidate.id, relation: child.relation, evidence: child.evidence };
    if (!next.edges.some(e => JSON.stringify(e) === JSON.stringify(edge))) next.edges.push(edge);
  }
  next.events.push({ kind: 'EXPAND', taskId, rule: task.rule });
  // Resolve parents from their dependencies, retaining shared subproblems once.
  let changed = true;
  while (changed) {
    changed = false;
    for (const parent of next.nodes.filter(n => n.state === 'WAITING')) {
      const children = next.edges.filter(e => e.from === parent.id).map(e => next.nodes.find(n => n.id === e.to));
      if (children.length && children.every(n => ['READY', 'GAP'].includes(n.state))) {
        parent.results = [...new Map(children.flatMap(n => n.results).map(r => [hash(r), r])).values()];
        parent.state = children.some(n => n.state === 'GAP') ? 'GAP' : 'READY';
        if (parent.state === 'GAP') parent.reason = 'DEPENDENCY_GAP';
        next.events.push({ kind: 'COLLECT', taskId: parent.id });
        changed = true;
      }
    }
  }
  const pending = next.nodes.some(n => n.state === 'PENDING');
  if (!pending) for (const n of next.nodes.filter(n => n.state === 'WAITING')) {
    n.state = 'GAP'; n.reason = 'CYCLIC_DEPENDENCY';
  }
  next.revision++;
  next.status = pending ? 'PAUSED' : next.nodes.every(n => n.state === 'READY') ? 'COMPLETE' : 'INCOMPLETE';
  next.results = next.nodes.find(n => n.id === next.rootId).results;
  return next;
}

export async function validateRoute(read, plan) {
  for (const probe of new Map(plan.probes.map(p => [`${p.stableId}|${p.kind}`, p])).values()) {
    if (hash(await read(probe.stableId, probe.kind)) !== probe.fingerprint) return false;
  }
  return plan.version === routeContract.version;
}

export async function startDeterministicRoute(driver, database, input) {
  const plan = initialRoute(input), session = driver.session({ database });
  try {
    const cached = await session.run(`MATCH (r:DeterministicRouteRun {rootStableId:$root, version:$version})
      RETURN r.stateJson AS state ORDER BY r.createdAt DESC LIMIT 20`,
    { root: input.stableId, version: routeContract.version });
    for (const row of cached.records) {
      const previous = JSON.parse(row.get('state'));
      if (previous.status === 'COMPLETE' && await validateRoute((id, probe) => readRouteFacts(session, id, probe), previous))
        return previous;
    }
    await session.run(`CREATE (:DeterministicRouteRun {runId:$id,stateJson:$state,
      rootStableId:$root,version:$version,createdAt:$now})`,
    { id: plan.runId, state: JSON.stringify(plan), root: input.stableId,
      version: routeContract.version, now: new Date().toISOString() });
    return plan;
  } finally { await session.close(); }
}
export async function readDeterministicRoute(driver, database, runId) {
  const session = driver.session({ database });
  try {
    const result = await session.run('MATCH (r:DeterministicRouteRun {runId:$id}) RETURN r.stateJson AS state', { id: runId });
    if (result.records.length !== 1) throw new Error('Route not found');
    return JSON.parse(result.records[0].get('state'));
  } finally { await session.close(); }
}
export async function nextDeterministicRoute(driver, database, { runId, expectedRevision, taskId }) {
  const session = driver.session({ database });
  try {
    return await session.executeWrite(async tx => {
      const result = await tx.run(`MATCH (r:DeterministicRouteRun {runId:$id})
        SET r.lockedAt=$now RETURN r.stateJson AS state`, { id: runId, now: new Date().toISOString() });
      if (result.records.length !== 1) throw new Error('Route not found');
      const plan = JSON.parse(result.records[0].get('state'));
      if (plan.revision !== expectedRevision) throw new Error('Route revision conflict');
      const read = (id, probe) => readRouteFacts(tx, id, probe);
      let updated;
      if (!await validateRoute(read, plan)) updated = { ...plan, revision: plan.revision + 1, status: 'STALE' };
      else {
        if (plan.status !== 'PAUSED') throw new Error('Route is not paused; start a new run for changed facts');
        const task = plan.nodes.find(n => n.state === 'PENDING' && (!taskId || n.id === taskId));
        if (!task) throw new Error('Pending task not found');
        updated = applyRouteStep(plan, task.id, await inspectRouteTask(read, task));
      }
      await tx.run('MATCH (r:DeterministicRouteRun {runId:$id}) SET r.stateJson=$state',
        { id: runId, state: JSON.stringify(updated) });
      return updated;
    });
  } finally { await session.close(); }
}
