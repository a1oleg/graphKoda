// A selector is a call-site value constraint. Keep the returned member identity
// instead of following the gateway declaration to all of its other callers.
// All evidence below consists of existing source-backed graph paths.
export async function loadProjectionDependencies(session, stableIds) {
  const result = await session.run(`
    UNWIND $stableIds AS stableId
    MATCH path=(subject {stableId: stableId})-[:VALUE_FROM]->(call:Call)
      -[argument:HAS_ARGUMENT]->(selector:FunctionImplementation)
      -[:RETURNS_VALUE]->(read:MemberReference)
    WHERE argument.index IN coalesce(call.valueProjectionCallbackIndexes, [])
    MATCH (read)-[:READS_FROM*1..8]->(receiver:ValueReference)-[:RESOLVES_TO]->(parameter:Parameter)
    MATCH (selector)-[:HAS_PARAMETER]->(parameter)
    OPTIONAL MATCH (read)-[resolution:RESOLVES_TO]->(member:MemberDeclaration)
    WHERE resolution.contextCallSiteStableIds IS NULL OR call.stableId IN resolution.contextCallSiteStableIds
    RETURN stableId, call.stableId AS selectorId, member.stableId AS memberId,
      [node IN nodes(path) | node.stableId] AS nodeIds,
      [edge IN relationships(path) | type(edge)] AS relationshipTypes
  `, { stableIds });
  const byId = new Map();
  for (const row of result.records) {
    const id = row.get('stableId');
    const rows = byId.get(id) || [];
    if (!rows.some(item => item.stableId === row.get('selectorId'))) rows.push({
      stableId: row.get('selectorId'), annotationKind: 'Projection', recurse: true,
      role: 'selected-return', dependencyKind: 'value-provenance', ordinal: rows.length,
      evidencePath: { nodeIds: row.get('nodeIds'), relationshipTypes: row.get('relationshipTypes') },
    });
    byId.set(id, rows);
  }
  return byId;
}

export const projectionProfiles = {
  Projection: {
    id: 'selected-return', version: 1, compositionContext: false, accumulateToSystemBoundary: true,
    async contextMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (call:Call {stableId: stableId})-[argument:HAS_ARGUMENT]->(selector:FunctionImplementation)
          -[:RETURNS_VALUE]->(read:MemberReference)
        WHERE argument.index IN coalesce(call.valueProjectionCallbackIndexes, [])
        MATCH (read)-[:READS_FROM*1..8]->(:ValueReference)-[:RESOLVES_TO]->(parameter:Parameter)
        MATCH (selector)-[:HAS_PARAMETER]->(parameter)
        OPTIONAL MATCH (read)-[resolution:RESOLVES_TO]->(member:MemberDeclaration)
        WHERE resolution.contextCallSiteStableIds IS NULL OR call.stableId IN resolution.contextCallSiteStableIds
        WITH stableId, call, collect(DISTINCT {syntax: selector.syntax, selectorStableId: selector.stableId,
          selectedReferenceStableId: read.stableId, selectedMemberStableId: member.stableId,
          resolutionStatus: CASE WHEN member IS NULL THEN 'unresolved-member' ELSE 'resolved' END
          }) AS selections
        RETURN stableId, {stableId: stableId, invocationSyntax: call.syntax, selections: selections} AS context
      `, { stableIds });
      return new Map(result.records.map(r => [r.get('stableId'), r.get('context')]));
    },
    async dependenciesMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH path=(call:Call {stableId: stableId})-[argument:HAS_ARGUMENT]->(selector:FunctionImplementation)
          -[:RETURNS_VALUE]->(read:MemberReference)
          -[resolution:RESOLVES_TO]->(member:MemberDeclaration)
        WHERE argument.index IN coalesce(call.valueProjectionCallbackIndexes, [])
          AND (resolution.contextCallSiteStableIds IS NULL OR call.stableId IN resolution.contextCallSiteStableIds)
        MATCH (read)-[:READS_FROM*1..8]->(:ValueReference)-[:RESOLVES_TO]->(parameter:Parameter)
        MATCH (selector)-[:HAS_PARAMETER]->(parameter)
        RETURN stableId, member.stableId AS memberId,
          [node IN nodes(path) | node.stableId] AS nodeIds,
          [edge IN relationships(path) | type(edge)] AS relationshipTypes
      `, { stableIds });
      const map = new Map(stableIds.map(id => [id, []]));
      for (const r of result.records) map.get(r.get('stableId')).push({
        stableId: r.get('memberId'), annotationKind: 'SelectedMember', recurse: true,
        role: 'selected-member', dependencyKind: 'value-provenance', ordinal: 0,
        evidencePath: { nodeIds: r.get('nodeIds'), relationshipTypes: r.get('relationshipTypes') },
      });
      return map;
    },
  },
  SelectedMember: {
    id: 'selected-member-provenance', version: 1, compositionContext: false,
    async contextMany(session, stableIds) {
      const result = await session.run(`
        UNWIND $stableIds AS stableId
        MATCH (member:MemberDeclaration {stableId: stableId})
        CALL (member) {
          MATCH p=(object:ObjectConstruction)-[:HAS_PROPERTY]->(value:PropertyValue)-[:SATISFIES_MEMBER]->(member)
          OPTIONAL MATCH (owner:FunctionImplementation)-[:AST_CHILD]->(object)
          RETURN value, owner, [n IN nodes(p) | n.stableId] AS nodeIds,
            [r IN relationships(p) | type(r)] AS relationshipTypes
          UNION
          MATCH p=(value)-[:WRITES_TO]->(:MemberReference)-[:RESOLVES_TO]->(member)
          OPTIONAL MATCH (owner:FunctionImplementation)-[:AST_CHILD]->(value)
          RETURN value, owner, [n IN nodes(p) | n.stableId] AS nodeIds,
            [r IN relationships(p) | type(r)] AS relationshipTypes
        }
        OPTIONAL MATCH ownerPath=(enclosing:FunctionImplementation)-[:AST_CHILD|HAS_ARGUMENT*1..4]->(owner)
        WHERE none(n IN nodes(ownerPath)[1..-1] WHERE n:FunctionImplementation)
        WITH member, value, nodeIds, relationshipTypes, ownerPath,
          coalesce(enclosing, owner) AS owner
        CALL (owner) {
          OPTIONAL MATCH (owner)-[:AST_CHILD]->(operation:Call)-[:CALLS]->(callee)
          RETURN collect(DISTINCT CASE WHEN operation IS NULL THEN null ELSE {
            stableId: operation.stableId, syntax: operation.syntax,
            calleeStableId: callee.stableId, calleeName: callee.name
          } END) AS calls
        }
        CALL (owner) {
          OPTIONAL MATCH (caller:FunctionImplementation)-[:AST_CHILD]->(site:Call)-[:CALLS]->(owner)
          RETURN collect(DISTINCT CASE WHEN site IS NULL THEN null ELSE {
            stableId: site.stableId, syntax: site.syntax, ownerStableId: caller.stableId,
            ownerSyntax: caller.syntax
          } END) AS callSites
        }
        RETURN member.stableId AS stableId, member.syntax AS syntax,
          collect(DISTINCT {stableId: value.stableId, syntax: value.syntax,
            ownerStableId: owner.stableId, ownerSyntax: owner.syntax,
            ownerPath: [n IN nodes(ownerPath) | n.stableId],
            evidencePath: {nodeIds: nodeIds, relationshipTypes: relationshipTypes},
            calls: calls, callSites: callSites}) AS writes
      `, { stableIds });
      const map = new Map(stableIds.map(id => [id, {stableId:id, writes:[], resolutionStatus:'no-proven-writers'}]));
      for (const r of result.records) map.set(r.get('stableId'), {
        stableId:r.get('stableId'), syntax:r.get('syntax'), writes:r.get('writes'),
        resolutionStatus:'resolved-writers',
      });
      return map;
    },
    async dependenciesMany(_session, stableIds) { return new Map(stableIds.map(id => [id, []])); },
  },
};
