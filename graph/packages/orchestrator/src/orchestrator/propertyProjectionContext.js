// A destructured field is not the aggregate from which it was selected.
// Carry the source-backed key through aliases and parameter forwarding. Never
// fall back to visiting sibling properties when a route cannot be resolved.
export async function loadPropertyProjectionContexts(session, stableIds) {
  const initial = await session.run(`
    UNWIND $stableIds AS id
    MATCH (subject:PropertyProjection {stableId: id})-[read:READS_FROM]->(source)
    WHERE read.propertyName IS NOT NULL
      AND NOT EXISTS { MATCH (subject)-[:SELECTS_RETURN_PROPERTY]->() }
    RETURN id, subject.syntax AS syntax, read.propertyName AS key, source.stableId AS sourceId,
      elementId(source) AS sourceElementId
  `, { stableIds });
  const results = new Map();
  let frontier = [];
  for (const record of initial.records) {
    const {id, syntax, key, sourceId, sourceElementId} = record.toObject();
    results.set(id, {stableId: id, syntax, selectedProperty: key,
      selections: [], unresolved: [], dependencies: []});
    frontier.push({root: id, id: sourceId, elementId: sourceElementId, key, path: [id, sourceId], relationships: ['READS_FROM']});
  }
  const visited = new Set();
  for (let hop = 0; frontier.length && hop < 12; hop++) {
    const states = frontier.filter(s => {
      const key = JSON.stringify([s.root, s.id, s.key]);
      if (visited.has(key)) return false;
      visited.add(key); return true;
    });
    frontier = [];
    if (!states.length) break;
    const response = await session.run(`
      UNWIND $states AS state
      MATCH (source) WHERE elementId(source) = state.elementId
      CALL (source, state) {
        OPTIONAL MATCH (source)-[field:HAS_PROPERTY]->(selected)
        WHERE field.propertyName = state.key
        OPTIONAL MATCH p=(selected)-[:AST_CHILD|VALUE_FROM|RESOLVES_TO|CALLS|CALLS_VALUE*0..6]->(candidate)
        WHERE (candidate:DeveloperDefined OR candidate:Call OR candidate:Request)
          AND none(n IN nodes(p)[0..-1] WHERE n:DeveloperDefined OR n:System OR n:Call OR n:Request)
        RETURN collect(DISTINCT CASE WHEN selected IS NULL THEN null ELSE {
          stableId: selected.stableId, syntax: coalesce(selected.syntax, selected.action_text_raw),
          propertyName: field.propertyName,
          candidate: CASE WHEN candidate IS NULL THEN null ELSE {
            stableId: candidate.stableId, labels: labels(candidate), annotationKind: candidate.annotationKind,
            path: [n IN nodes(p) | n.stableId], relationships: [r IN relationships(p) | type(r)]
          } END
        } END) AS selectedFields
      }
      CALL (source) {
        OPTIONAL MATCH (source)-[r:VALUE_FROM|RESOLVES_TO]->(next)
        RETURN collect(CASE WHEN next IS NULL THEN null ELSE {id: next.stableId, elementId: elementId(next), relation: type(r)} END) AS aliases
      }
      CALL (source) {
        OPTIONAL MATCH (source)<-[r:BINDS_TO_PARAMETER]-(next)
        WHERE source:Parameter
        RETURN collect(CASE WHEN next IS NULL THEN null ELSE {id: next.stableId, elementId: elementId(next), relation: type(r)} END) AS origins
      }
      RETURN state, selectedFields, aliases + origins AS nextStates
    `, { states });
    const progressed = new Set();
    const allStates = new Map();
    for (const record of response.records) {
      const {state, selectedFields, nextStates} = record.toObject();
      const stateKey = JSON.stringify([state.root, state.id, state.key]);
      allStates.set(stateKey, state);
      const result = results.get(state.root);
      if (selectedFields.length) {
        progressed.add(stateKey);
        for (const field of selectedFields) {
          const evidencePath = {nodeIds: [...state.path, ...(field.candidate?.path || [field.stableId])],
            relationshipTypes: [...state.relationships, 'HAS_PROPERTY', ...(field.candidate?.relationships || [])]};
          if (!result.selections.some(s => s.stableId === field.stableId)) result.selections.push({
            stableId: field.stableId, syntax: field.syntax, propertyName: field.propertyName, evidencePath});
          if (field.candidate && !result.dependencies.some(d => d.stableId === field.candidate.stableId)) {
            result.dependencies.push({...field.candidate, evidencePath});
          }
        }
      } else for (const next of nextStates) {
        progressed.add(stateKey);
        frontier.push({...state, id: next.id, elementId: next.elementId, path: [...state.path, next.id], relationships: [...state.relationships, next.relation]});
      }
    }
    for (const [key, state] of allStates) if (!progressed.has(key)) {
      results.get(state.root).unresolved.push({stableId: state.id, propertyName: state.key, reason: 'no-source-backed-selected-field'});
    }
  }
  for (const state of frontier) results.get(state.root).unresolved.push({stableId: state.id, propertyName: state.key, reason: 'projection-hop-limit'});
  return results;
}
