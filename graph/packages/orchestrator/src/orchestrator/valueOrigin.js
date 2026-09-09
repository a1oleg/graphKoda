import { createHash, randomUUID } from 'node:crypto';
import { inspectValueUsage, findContextProviders } from './valueUsage.js';

// Discovery and synthesis are separate passes. No legacy whole-entity annotation
// is a cache hit for a use-site-specific value slice.
export const valueOriginContract = Object.freeze({
  id: 'value-origin', version: 7, evidence: 'static-possible-paths',
  purpose: 'write-owner-directed-transfer-concrete-consumption-not-complete-effects',
  usage: 'reverse-value-transfers-not-type-member-matching',
  provider: 'nearest-per-static-ancestry-path-with-explicit-gaps',
  renderedValue: 'follow-argument-value-to-jsx-insertion-not-factory-call-ancestry',
  parameter: 'declared-members-first-then-binding-scoped-member-sources',
  history: 'reaching-definitions-at-use-site-not-all-writes',
  callable: 'selected-result-or-effect-backward-slice-with-control-dependencies',
  cache: 'slice-identity-and-source-fingerprint-not-whole-step',
  proxy: 'follow-original-no-own-annotation',
  boundary: 'system-operation-or-literal-not-type-annotation',
  layout: 'sources-below-consumer-value-edges-upward',
});
const normalize = value => value?.toNumber ? value.toNumber() : Array.isArray(value)
  ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
export function originTaskId(stableId, context) {
  return createHash('sha256').update(JSON.stringify([valueOriginContract.version, stableId,
    context.atStableId || null, context.callSiteId || null, context.parameterIndex ?? null,
    context.argumentIndex ?? null, context.selection || 'value', context.frames || [],
    context.parameterId || null, context.memberPath || [], context.providerPath || [],
    context.objective || 'mechanism', context.purposeState || null, context.usagePath || []])).digest('hex');
}
function task(stableId, context, depth, ancestors = []) {
  return { id: originTaskId(stableId, context), stableId, context, depth, ancestors,
    state: 'PENDING', profile: null, reason: null, evidence: [] };
}
export function initialOriginPlan(stableId, maxDepth = 8, selection = 'value', objective = 'purpose') {
  if (!['purpose', 'mechanism'].includes(objective)) throw new Error('objective must be purpose or mechanism');
  if (!['value', 'usage'].includes(selection)) throw new Error('selection must be value or usage');
  if (!String(stableId || '').trim()) throw new Error('stableId is required');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new Error('maxDepth must be an integer between 0 and 32');
  const root = task(stableId, { atStableId: stableId, selection, objective, frames: [] }, 0);
  return { runId: randomUUID(), revision: 0, mode: valueOriginContract.id,
    version: valueOriginContract.version, rootId: root.id, maxDepth, status: 'PAUSED',
    nodes: [root], edges: [], lastTaskId: null };
}

export async function inspectOrigin(session, item) {
  const result = await session.run(`MATCH (n {stableId:$id})
    RETURN labels(n) AS labels, properties(n) AS properties LIMIT 2`, { id: item.stableId });
  if (result.records.length !== 1) return { profile: 'Unresolved', reason: 'SUBJECT_MISSING_OR_AMBIGUOUS', children: [] };
  const labels = result.records[0].get('labels');
  const properties = normalize(result.records[0].get('properties'));
  const evidence = [{ stableId: item.stableId, labels, properties }];
  const has = label => labels.includes(label);
  if (item.context.selection === 'usage') {
    if (item.context.objective === 'purpose' && has('ValueConsumption')
      && item.context.purposeState && !item.context.memberPath?.length) {
      const proof = await session.run(`MATCH (writer {stableId:$writer})-[:WRITES_TO]->(state {stableId:$state})
        MATCH (state)-[:ENCLOSED_BY]->(owner:FunctionImplementation)
        MATCH (consumer {stableId:$consumer})-[:ENCLOSED_BY]->(consumerOwner:FunctionImplementation)
        WHERE all(edge IN $path WHERE EXISTS {
          MATCH (a {stableId:edge.from})-[r]-(b {stableId:edge.to})
          WHERE type(r)=edge.relation AND edge.relation IN
            ['RESOLVES_TO','READS_FROM','VALUE_FROM','HAS_PROPERTY','SPREADS_FROM','BINDS_TO_PARAMETER','CONSUMES_VALUE']
            AND ((edge.direction='outgoing' AND startNode(r)=a) OR (edge.direction='incoming' AND endNode(r)=a))
        })
        RETURN DISTINCT writer.stableId AS writerId, state.stableId AS stateId,
          owner.stableId AS ownerId, consumer.stableId AS consumerId,
          consumer.syntax AS syntax, consumer.consumptionKind AS kind,
          consumerOwner.stableId AS consumerOwnerId`, {
        writer: item.context.purposeState.writerId, state: item.context.purposeState.stateId, consumer: item.stableId,
        path: item.context.usagePath || [],
      });
      const path = item.context.usagePath || [];
      if (proof.records.length === 1 && path.length && path[0].from === item.context.purposeState.stateId
        && path.at(-1).to === item.stableId && path.at(-1).relation === 'CONSUMES_VALUE'
        && path.every((edge, index) => index === 0 || path[index - 1].to === edge.from)) {
        return { profile: 'StateLocalUse', purposeBoundary: true, evidence: [...evidence,
          { ...normalize(proof.records[0].toObject()), path, coverage: 'one-static-use-not-all-effects' }], children: [] };
      }
    }
    if (has('System') && has('ExternalBoundary') && !has('DeveloperDefined')) {
      return { profile: 'SystemConsumerBoundary', boundary: true, evidence, children: [] };
    }
    return { ...await inspectValueUsage(session, item), evidence };
  }
  if (has('Call')) {
    const contexts = await session.run(`MATCH (n {stableId:$id})-[:READS_CONTEXT]->(ref)
      MATCH (ref)-[:RESOLVES_TO]->(context)
      RETURN DISTINCT context.stableId AS id`, { id: item.stableId });
    if (contexts.records.length) {
      const children = [], gaps = [];
      for (const record of contexts.records) {
        const contextId = record.get('id');
        const result = await findContextProviders(session, item.stableId, contextId, 24, item.context.frames || []);
        gaps.push(...result.gaps);
        for (const provider of result.providers) children.push({ ...provider,
          relation: 'PROVIDES_CONTEXT', direction: 'incoming', contextId,
          context: { ...item.context, providerPath: provider.path, atStableId: provider.fieldId } });
      }
      return { profile: 'ContextProviders', evidence: [...evidence, ...gaps], children,
        reason: gaps.length ? 'PROVIDER_ANCESTRY_INCOMPLETE' : children.length ? null : 'PROVIDER_MISSING' };
    }
  }
  if (has('Parameter') && !item.context.memberPath?.length) {
    const members = await session.run(`
      MATCH (parameter {stableId:$id})-[:TYPED_AS]->(declared)
      MATCH path=(declared)-[:RESOLVES_TO|ALIASES*0..8]->(owner)-[:HAS_MEMBER]->(member)
      WHERE member.stableId IS NOT NULL
      WITH member, owner, path ORDER BY length(path)
      WITH member, head(collect({ownerId:owner.stableId, ownerName:owner.name,
        nodes:[n IN nodes(path) | n.stableId], relations:[r IN relationships(path) | type(r)]})) AS typePath
      RETURN member.stableId AS stableId, member.name AS name, member.syntax AS syntax,
        typePath, member.startLine AS line, member.startColumn AS column
      ORDER BY line, column, stableId LIMIT 501`, { id: item.stableId });
    if (members.records.length > 500) return { profile: 'ParameterStructure', evidence, reason: 'MEMBER_LIMIT', children: [] };
    if (members.records.length) return { profile: 'ParameterStructure', evidence,
      children: members.records.map(record => {
        const row = normalize(record.toObject());
        return { ...row, relation: 'HAS_MEMBER', direction: 'outgoing',
          context: { ...item.context, selection: 'member-origin',
            parameterId: item.stableId, memberPath: [row.name], memberDeclarationId: row.stableId } };
      }) };
  }
  const selectedMember = item.context.selection === 'member-origin'
    && item.context.memberDeclarationId === item.stableId;
  if (selectedMember) {
    const sources = await session.run(`
      MATCH (argument)-[binding:BINDS_TO_PARAMETER]->(parameter {stableId:$parameterId})
      OPTIONAL MATCH (call)-[supplied:HAS_ARGUMENT]->(argument)
      OPTIONAL MATCH (argument)-[:HAS_PROPERTY]->(field)-[:SATISFIES_MEMBER]->(member {stableId:$id})
      OPTIONAL MATCH (field)-[origin:VALUE_FROM|RESOLVES_TO]->(source)
      RETURN argument.stableId AS argumentId, call.stableId AS callSiteId,
        binding.index AS parameterIndex, supplied.index AS argumentIndex,
        field.stableId AS fieldId, source.stableId AS stableId,
        source.syntax AS syntax, source.name AS name, labels(source) AS labels,
        type(origin) AS originRelation, properties(binding) AS binding
      ORDER BY callSiteId, fieldId, stableId LIMIT 501`,
    { id: item.stableId, parameterId: item.context.parameterId });
    if (sources.records.length > 500) return { profile: 'MemberOrigins', evidence, reason: 'MEMBER_SOURCE_LIMIT', children: [] };
    const rows = sources.records.map(record => normalize(record.toObject()));
    const missing = rows.filter(row => !row.stableId || !row.fieldId || !row.callSiteId
      || row.parameterIndex == null || row.argumentIndex == null);
    return { profile: 'MemberOrigins', evidence: [...evidence, ...missing],
      reason: !rows.length ? 'PARAMETER_BINDINGS_MISSING' : missing.length ? 'MEMBER_SOURCE_PATH_MISSING' : null,
      children: rows.filter(row => !missing.includes(row)).map(row => ({
        ...row, relation: 'SATISFIES_MEMBER', direction: 'incoming',
        path: { nodes: [item.stableId, row.fieldId, row.stableId],
          relations: ['SATISFIES_MEMBER', row.originRelation], directions: ['incoming', 'outgoing'] },
        context: { ...item.context, selection: 'value', memberPath: [],
          atStableId: row.fieldId, callSiteId: row.callSiteId,
          parameterIndex: row.parameterIndex, argumentIndex: row.argumentIndex,
          frames: [...item.context.frames, { parameterId: item.context.parameterId,
            memberDeclarationId: item.stableId, memberPath: item.context.memberPath,
            argumentId: row.argumentId, fieldId: row.fieldId, callSiteId: row.callSiteId,
            parameterIndex: row.parameterIndex, argumentIndex: row.argumentIndex }] },
      })) };
  }
  if (has('Parameter')) {
    const parameterId = item.stableId;
    const bound = await session.run(`
      MATCH (argument)-[binding:BINDS_TO_PARAMETER]->(parameter {stableId:$id})
      OPTIONAL MATCH (call)-[supplied:HAS_ARGUMENT]->(argument)
      RETURN argument.stableId AS stableId, argument.syntax AS syntax,
        call.stableId AS callSiteId, binding.index AS parameterIndex,
        supplied.index AS argumentIndex, properties(binding) AS binding,
        properties(supplied) AS supplied
      ORDER BY callSiteId, stableId LIMIT 501`, { id: parameterId });
    if (bound.records.length > 500) return { profile: 'ParameterOrigins', evidence, reason: 'BINDING_LIMIT', children: [] };
    return { profile: 'ParameterOrigins', evidence,
      reason: bound.records.length ? null : 'PARAMETER_BINDINGS_MISSING',
      children: bound.records.map(record => {
        const row = normalize(record.toObject());
        return { ...row, relation: 'BINDS_TO_PARAMETER', direction: 'incoming',
          unresolved: !row.callSiteId || row.parameterIndex == null || row.argumentIndex == null
            ? 'CALL_SITE_OR_POSITION_MISSING' : null,
          context: { ...item.context, atStableId: row.callSiteId || row.stableId,
            callSiteId: row.callSiteId, parameterIndex: row.parameterIndex, argumentIndex: row.argumentIndex,
            frames: [...item.context.frames, { parameterId,
              argumentId: row.stableId, callSiteId: row.callSiteId,
              parameterIndex: row.parameterIndex, argumentIndex: row.argumentIndex }] } };
      }) };
  }
  if (item.context.memberPath?.length) {
    // A member signature is not an implementation; never widen a selected
    // member to the entire argument object when a property slice is missing.
    return { profile: 'MemberValueOrigin', evidence, reason: 'MEMBER_VALUE_SLICE_REQUIRED', children: [] };
  }
  if (has('LiteralValue') || has('Literal')) return { profile: 'LiteralOrigin', boundary: true, evidence, children: [] };
  if (has('System') && !has('DeveloperDefined') && !has('Type') && !has('TypeReference')) {
    return { profile: 'SystemBoundary', boundary: true, evidence, children: [] };
  }
  if (has('Call') || has('CallResult') || has('Fn') || has('FunctionImplementation')) {
    return { profile: 'CallResultSlice', evidence, reason: 'RESULT_SLICE_REQUIRED', children: [] };
  }
  if (has('ValueDeclaration') || has('ValueSlot')) {
    const writes = await session.run(`MATCH (n {stableId:$id})-[r:WRITES_TO]->(state)
      RETURN state.stableId AS stableId, properties(r) AS properties`, { id: item.stableId });
    if (writes.records.length) return { profile: 'WrittenStatePurpose', evidence,
      children: writes.records.map(record => ({ ...normalize(record.toObject()),
        relation: 'WRITES_TO', direction: 'outgoing',
        context: { ...item.context, selection: 'usage', memberPath: [], atStableId: item.stableId,
          purposeState: { writerId: item.stableId, stateId: record.get('stableId') }, usagePath: [] } })) };
    // Following the initializer alone would silently omit later writes. Wait for
    // a proven reaching-definition slice rather than substitute lexical order.
    return { profile: 'ValueHistory', evidence, reason: 'REACHING_DEFINITIONS_REQUIRED', children: [] };
  }
  const origins = await session.run(`
    MATCH (n {stableId:$id})-[r:VALUE_FROM|RESOLVES_TO|READS_FROM]->(origin)
    WHERE origin.stableId IS NOT NULL
    RETURN origin.stableId AS stableId, type(r) AS relation, properties(r) AS properties
    ORDER BY relation, stableId LIMIT 501`, { id: item.stableId });
  if (origins.records.length > 500) return { profile: 'ValueOrigins', evidence, reason: 'ORIGIN_LIMIT', children: [] };
  return { profile: 'ValueOrigins', evidence, reason: origins.records.length ? null : 'VALUE_ORIGIN_MISSING',
    children: origins.records.map(record => ({ ...normalize(record.toObject()),
      direction: 'outgoing', context: item.context })) };
}

export function applyOriginExpansion(plan, taskId, expansion) {
  const next = structuredClone(plan);
  const current = next.nodes.find(n => n.id === taskId);
  if (!current || current.state !== 'PENDING') throw new Error('A pending taskId is required');
  current.profile = expansion.profile;
  current.evidence = expansion.evidence || [];
  current.reason = expansion.reason || null;
  current.state = expansion.reason ? 'UNRESOLVED' : expansion.purposeBoundary ? 'PURPOSE_BOUNDARY' : expansion.boundary ? 'BOUNDARY' : 'EXPANDED';
  for (const origin of expansion.children || []) {
    if (!origin.stableId) { current.state = 'UNRESOLVED'; current.reason = 'ORIGIN_WITHOUT_ID'; continue; }
    const child = task(origin.stableId, origin.context, current.depth + 1, [...current.ancestors, current.stableId]);
    if (origin.unresolved) { child.state = 'UNRESOLVED'; child.reason = origin.unresolved; }
    else if (child.ancestors.includes(child.stableId)) { child.state = 'LIMIT'; child.reason = 'RECURSION_BOUNDARY'; }
    else if (child.depth > next.maxDepth) { child.state = 'LIMIT'; child.reason = 'DEPTH_BOUNDARY'; }
    if (!next.nodes.some(n => n.id === child.id)) next.nodes.push(child);
    next.edges.push({ from: current.id, to: child.id, relation: origin.relation,
      direction: origin.direction, evidence: origin });
  }
  if (next.nodes.length > 2000) throw new Error('Origin plan exceeds 2000 nodes');
  next.revision++; next.lastTaskId = current.id;
  next.status = next.nodes.some(n => n.state === 'PENDING') ? 'PAUSED'
    : next.nodes.some(n => ['UNRESOLVED', 'LIMIT'].includes(n.state)) ? 'INCOMPLETE'
    : next.nodes.some(n => n.state === 'PURPOSE_BOUNDARY') ? 'PURPOSE_COMPLETE' : 'COMPLETE';
  return next;
}

export async function startValueOrigin(driver, database, { stableId, maxDepth = 8, selection = 'value', objective = 'purpose' }) {
  const plan = initialOriginPlan(stableId, maxDepth, selection, objective);
  const session = driver.session({ database });
  try {
    await session.run(`CREATE (run:ValueOriginRun {runId:$id, stateJson:$state, createdAt:$now})`,
      { id: plan.runId, state: JSON.stringify(plan), now: new Date().toISOString() });
    return plan;
  } finally { await session.close(); }
}
export async function readValueOrigin(driver, database, runId) {
  const session = driver.session({ database, defaultAccessMode: 'READ' });
  try {
    const result = await session.run('MATCH (run:ValueOriginRun {runId:$id}) RETURN run.stateJson AS state', { id: runId });
    if (!result.records.length) throw new Error('Value origin run not found');
    return JSON.parse(result.records[0].get('state'));
  } finally { await session.close(); }
}
export async function nextValueOrigin(driver, database, { runId, expectedRevision, taskId }) {
  const session = driver.session({ database });
  try {
    return await session.executeWrite(async tx => {
      const result = await tx.run(`MATCH (run:ValueOriginRun {runId:$id})
        SET run.lockedAt=$now RETURN run.stateJson AS state`, { id: runId, now: new Date().toISOString() });
      if (!result.records.length) throw new Error('Value origin run not found');
      const plan = JSON.parse(result.records[0].get('state'));
      if (plan.revision !== expectedRevision) throw new Error('Value origin revision conflict; read the current plan');
      const item = taskId ? plan.nodes.find(n => n.id === taskId && n.state === 'PENDING')
        : plan.nodes.find(n => n.state === 'PENDING');
      if (!item) throw new Error('No matching pending discovery task');
      const updated = applyOriginExpansion(plan, item.id, await inspectOrigin(tx, item));
      await tx.run('MATCH (run:ValueOriginRun {runId:$id}) SET run.stateJson=$state', { id: runId, state: JSON.stringify(updated) });
      return updated;
    });
  } finally { await session.close(); }
}
