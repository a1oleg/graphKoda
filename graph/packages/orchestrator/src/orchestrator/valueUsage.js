const rows = result => result.records.map(record => record.toObject());
const number = value => value?.toNumber ? value.toNumber() : value;

export function transferUsage(item, row) {
  let memberPath = [...(item.context.memberPath || [])];
  const properties = row.properties || {};
  if (row.relation === 'READS_FROM' && properties.propertyName != null && memberPath.length) {
    if (String(properties.propertyName) !== memberPath[0]) return null;
    memberPath = memberPath.slice(1);
  }
  if (row.relation === 'HAS_PROPERTY') memberPath.unshift(properties.propertyName);
  const later = row.later || [];
  if (later.some(entry => entry.relation === 'HAS_PROPERTY' && entry.propertyName === memberPath[0])) return null;
  const uncertainOverwrite = later.some(entry => entry.relation === 'SPREADS_FROM'
    || entry.propertyName == null);
  const frames = [...(item.context.frames || [])];
  if (row.relation === 'BINDS_TO_PARAMETER') frames.push({
    parameterId: row.stableId, argumentId: item.stableId,
    callSiteId: properties.callSiteStableId || row.callSiteId,
    parameterIndex: number(properties.index), memberPath,
  });
  return { ...row, unresolved: uncertainOverwrite ? 'COMPOSITION_OVERWRITE_UNRESOLVED' : undefined,
    context: { ...item.context, selection: 'usage', memberPath, frames, atStableId: row.stableId,
      ...(item.context.purposeState ? { usagePath: [...(item.context.usagePath || []), {
        from: item.stableId, to: row.stableId, relation: row.relation, direction: row.direction,
      }] } : {}) } };
}

export async function inspectValueUsage(session, item) {
  // Type-member matching is intentionally absent: it is not a value transfer.
  const found = rows(await session.run(`
    MATCH (source {stableId:$id})
    CALL {
      WITH source MATCH (use)-[r:RESOLVES_TO|READS_FROM|VALUE_FROM|CONSUMES_VALUE]->(source)
      WHERE NOT use:TypeDeclaration AND NOT use:TypeReference
        AND NOT (type(r)='RESOLVES_TO' AND use:ValueReference AND size($memberPath)>0
          AND EXISTS { MATCH ()-[read:READS_FROM]->(use) WHERE read.role='receiver' }
          AND NOT EXISTS { MATCH ()-[read:READS_FROM]->(use)
            WHERE read.propertyName IS NULL OR read.propertyName=$memberPath[0] })
      RETURN use.stableId AS stableId, type(r) AS relation, properties(r) AS properties, 'incoming' AS direction, null AS callSiteId
      UNION
      WITH source MATCH (source)-[r:BINDS_TO_PARAMETER]->(parameter)
      OPTIONAL MATCH (call)-[:HAS_ARGUMENT]->(source)
      RETURN parameter.stableId AS stableId, type(r) AS relation, properties(r) AS properties, 'outgoing' AS direction,
        coalesce(r.callSiteStableId, call.stableId) AS callSiteId
    }
    RETURN DISTINCT stableId, relation, properties, direction, callSiteId
    ORDER BY stableId, relation LIMIT 501`, { id: item.stableId, memberPath: item.context.memberPath || [] }));
  if (found.length > 500) return { profile: 'StateConsumers', reason: 'CONSUMER_LIMIT', children: [] };
  const compositions = rows(await session.run(`
    MATCH (source {stableId:$id})<-[r:HAS_PROPERTY|SPREADS_FROM]-(container:ObjectConstruction)
    OPTIONAL MATCH (container)-[sibling:HAS_PROPERTY|SPREADS_FROM]->(other)
    WHERE sibling.index > r.index
    RETURN container.stableId AS stableId, type(r) AS relation, properties(r) AS properties,
      'incoming' AS direction,
      collect(CASE WHEN sibling IS NULL THEN null ELSE
        {relation:type(sibling), propertyName:sibling.propertyName, index:sibling.index} END) AS later
    ORDER BY stableId, relation LIMIT 501`, { id: item.stableId }));
  if (found.length + compositions.length > 500) return { profile: 'StateConsumers', reason: 'CONSUMER_LIMIT', children: [] };
  const children = [...found, ...compositions].map(row => transferUsage(item, row)).filter(Boolean);
  return { profile: 'StateConsumers', reason: children.length ? null : 'CONSUMER_TRANSFER_REQUIRED', children };
}

export async function findContextProviders(session, readId, contextId, maxDepth = 24, frames = []) {
  frames = [...new Map(frames.filter(frame => frame.parameterId && frame.callSiteId)
    .map(frame => [frame.parameterId, { parameterId: frame.parameterId, callSiteId: frame.callSiteId }])).values()];
  const run = session.run.bind(session);
  const cache = new Map();
  session = { async run(query, parameters) {
    const key = JSON.stringify([query, parameters]);
    if (!cache.has(key)) cache.set(key, await run(query, parameters));
    return cache.get(key);
  } };
  const queue = [{ id: readId, path: [], visited: [], mode: 'ancestry', frames, memberPath: [] }];
  const providers = [];
  const gaps = [];
  let inspected = 0;
  while (queue.length) {
    const current = queue.shift();
    const visitKey = JSON.stringify([current.id, current.mode, current.memberPath, current.frames]);
    if (current.visited.includes(visitKey)) { gaps.push({ id: current.id, reason: 'PROVIDER_RECURSION' }); continue; }
    current.visited = [...current.visited, visitKey];
    if (++inspected > 500) { gaps.push({ reason: 'PROVIDER_SEARCH_LIMIT' }); break; }
    const values = rows(await session.run(`
      MATCH (field)-[provided:PROVIDES_CONTEXT]->(context {stableId:$contextId})
      WHERE provided.providerStableId=$id
      OPTIONAL MATCH (field)-[:VALUE_FROM]->(value)
      RETURN field.stableId AS fieldId, value.stableId AS stableId`, { id: current.id, contextId }));
    if (values.length) {
      for (const value of values) {
        if (value.stableId) providers.push({ ...value, providerId: current.id, path: current.path });
        else gaps.push({ id: current.id, reason: 'PROVIDER_VALUE_MISSING' });
      }
      continue;
    }
    if (current.path.length >= maxDepth) { gaps.push({ id: current.id, reason: 'PROVIDER_DEPTH_LIMIT' }); continue; }
    if (current.mode === 'ancestry') {
      const supplied = rows(await session.run(`
        MATCH (n:ComponentConstruction {stableId:$id})
        WHERE NOT EXISTS { MATCH ()-[:JSX_CHILD]->(n) }
          AND (EXISTS { MATCH ()-[:VALUE_FROM]->(n) } OR EXISTS { MATCH (n)-[:BINDS_TO_PARAMETER]->() })
        RETURN n.stableId AS stableId`, { id: current.id }));
      if (supplied.length) { queue.push({ ...current, mode: 'render-value' }); continue; }
    }
    if (current.mode === 'render-value') {
      const containers = rows(await session.run(`
        MATCH (container)-[r:RENDERS_VALUE]->(value {stableId:$id})
        RETURN container.stableId AS stableId, type(r) AS relation, properties(r) AS properties`, { id: current.id }));
      const usage = await inspectValueUsage(session, { stableId: current.id,
        context: { selection: 'usage', memberPath: current.memberPath, frames: current.frames } });
      const continuations = [...containers.map(row => ({ ...row, direction: 'incoming', mode: 'ancestry' })),
        ...usage.children.map(row => ({ ...row, mode: 'render-value' }))];
      if (!continuations.length) gaps.push({ id: current.id, reason: 'RENDER_VALUE_TRANSFER_MISSING', path: current.path });
      for (const next of continuations) {
        if (next.unresolved) { gaps.push({ id: next.stableId, reason: next.unresolved, path: current.path }); continue; }
        queue.push({ ...current, id: next.stableId, mode: next.mode,
          frames: next.context?.frames || current.frames, memberPath: next.context?.memberPath || current.memberPath,
          path: [...current.path, { from: current.id, to: next.stableId,
            relation: next.relation, direction: next.direction, properties: next.properties }] });
      }
      continue;
    }
    // Lexical JSX ancestry takes precedence over component/call-site ancestry.
    let parents = rows(await session.run(`
      MATCH (parent)-[r:JSX_CHILD|DECLARES_JSX]->(n {stableId:$id})
      RETURN parent.stableId AS stableId, type(r) AS relation, properties(r) AS properties
      ORDER BY stableId`, { id: current.id }));
    const hasLexicalParents = parents.length > 0;
    if (!parents.length) parents = rows(await session.run(`
      MATCH (n {stableId:$id})
      CALL {
        WITH n MATCH (owner:FunctionImplementation)-[r:AST_CHILD]->(n)
        WHERE r.projection='nearest-function-operation'
        RETURN owner.stableId AS stableId, type(r) AS relation, properties(r) AS properties
        UNION
        WITH n MATCH (call)-[r:CALLS]->(n)
        WHERE NOT EXISTS {
            MATCH (n)-[:ALIASES|VALUE_FROM|WRAPS*0..8]->(owner)-[:HAS_PARAMETER]->(parameter)
            WHERE any(frame IN $frames WHERE frame.parameterId=parameter.stableId
              AND frame.callSiteId IS NOT NULL AND frame.callSiteId<>call.stableId)
          }
        RETURN call.stableId AS stableId, type(r) AS relation, properties(r) AS properties
      }
      RETURN stableId, relation, properties ORDER BY stableId`, { id: current.id, frames: current.frames }));
    if (!hasLexicalParents) parents.push(...rows(await session.run(`
      MATCH (n {stableId:$id})<-[r:WRAPS|ALIASES|VALUE_FROM]-(binding)
      WHERE (type(r)<>'VALUE_FROM' OR n:FunctionImplementation OR n:ReactWrapper)
        AND EXISTS { MATCH (binding)<-[:CALLS|WRAPS|ALIASES|VALUE_FROM|RESOLVES_TO]-() }
      RETURN binding.stableId AS stableId, type(r) AS relation, properties(r) AS properties,
        'incoming' AS direction ORDER BY stableId`, { id: current.id })));
    if (!parents.length) parents = rows(await session.run(`
      MATCH (n {stableId:$id})-[r:ENCLOSED_BY]->(owner)
      WHERE NOT n:FunctionImplementation
      RETURN owner.stableId AS stableId, type(r) AS relation, properties(r) AS properties,
        'outgoing' AS direction`, { id: current.id }));
    if (!parents.length) gaps.push({ id: current.id, reason: 'COMPONENT_ANCESTRY_MISSING', path: current.path });
    for (const parent of parents) {
      queue.push({ ...current, id: parent.stableId,
        path: [...current.path, { from: current.id, to: parent.stableId,
          relation: parent.relation, direction: parent.direction || 'incoming', properties: parent.properties }] });
    }
  }
  return { providers, gaps };
}
