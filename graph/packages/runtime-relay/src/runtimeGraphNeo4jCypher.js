export const RUNTIME_GRAPH_ENVELOPE_APPLY_BODY_CYPHER = `
WITH __value,
     coalesce(
       __value.entities,
       CASE WHEN __value.nodeid IS NOT NULL
         THEN [{
           id: __value.nodeid,
           labels: coalesce(__value.labels, []),
           props: coalesce(__value.nodeProps, {})
         }]
         ELSE []
       END
     ) AS entities,
     coalesce(
       __value.relations,
       [relation IN [
         CASE WHEN coalesce(__value.updateOnly, false) = false
           AND __value.parentNodeid IS NOT NULL
           AND __value.parentNodeid <> ''
           THEN {
             fromId: __value.parentNodeid,
             toId: __value.nodeid,
             type: coalesce(__value.edgeType, 'call'),
             props: coalesce(__value.requestProps, {})
           }
         END,
         CASE WHEN coalesce(__value.hasResponse, false) = true
           AND __value.parentNodeid IS NOT NULL
           AND __value.parentNodeid <> ''
           THEN {
             fromId: __value.nodeid,
             toId: __value.parentNodeid,
             type: 'response',
             props: coalesce(__value.responseProps, {})
           }
         END
       ] WHERE relation IS NOT NULL | relation]
     ) AS relations,
     coalesce(
       __value.anchors,
       [anchor IN [
        CASE WHEN coalesce(__value.nodeProps.ownerFnStableId, __value.nodeProps.fnStableId) IS NOT NULL
           THEN {
             fromId: __value.nodeid,
             type: 'STATIC_DEF',
             target: {
               labelExpression: 'Static:Fn',
               matchProps: {
                 stableId: coalesce(__value.nodeProps.ownerFnStableId, __value.nodeProps.fnStableId)
               }
             }
           }
         END,
         CASE WHEN __value.nodeProps.decisionId IS NOT NULL
           THEN {
             fromId: __value.nodeid,
             type: 'STATIC_DEF',
             target: {
               labelExpression: 'Static:Decision',
               matchProps: { decisionId: __value.nodeProps.decisionId }
             }
           }
         END,
         CASE WHEN __value.nodeProps.predicateId IS NOT NULL
           THEN {
             fromId: __value.nodeid,
             type: 'STATIC_DEF',
             target: {
               labelExpression: 'Static:Predicate',
               matchProps: { predicateId: __value.nodeProps.predicateId }
             }
           }
         END,
         CASE WHEN __value.nodeProps.branchId IS NOT NULL
           THEN {
             fromId: __value.nodeid,
             type: 'STATIC_DEF',
             target: {
               labelExpression: 'Static:Branch',
               matchProps: { branchId: __value.nodeProps.branchId }
             }
           }
        END,
        CASE WHEN __value.nodeProps.storeKey IS NOT NULL
          THEN {
            fromId: __value.nodeid,
            type: 'STATIC_DEF',
            target: {
              labelExpression: 'Static:Store',
              matchProps: { storeKey: __value.nodeProps.storeKey }
            }
          }
         END
       ] WHERE anchor IS NOT NULL | anchor]
     ) AS anchors
CALL {
  WITH entities
  UNWIND entities AS entity
  MERGE (node:RunTime {nodeid: entity.id})
  FOREACH (key IN keys(coalesce(entity.props, {})) |
    FOREACH (_ IN CASE
      WHEN entity.props[key] IS NOT NULL
        AND NOT valueType(entity.props[key]) CONTAINS 'MAP'
        AND NOT valueType(entity.props[key]) CONTAINS 'NODE'
        AND NOT valueType(entity.props[key]) CONTAINS 'RELATIONSHIP'
        AND NOT valueType(entity.props[key]) CONTAINS 'PATH'
      THEN [1]
      ELSE []
    END | SET node[key] = entity.props[key]))
  FOREACH (_ IN CASE WHEN 'RunTime' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:RunTime)
  FOREACH (_ IN CASE WHEN 'Fn' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:Fn)
  FOREACH (_ IN CASE WHEN 'StoreAffect' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:StoreAffect)
  FOREACH (_ IN CASE WHEN 'Decision' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:Decision)
  FOREACH (_ IN CASE WHEN 'PredicateEval' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:PredicateEval)
  FOREACH (_ IN CASE WHEN 'BranchHit' IN coalesce(entity.labels, []) THEN [1] ELSE [] END | SET node:BranchHit)
  RETURN count(node) AS appliedEntities
}
CALL {
  WITH relations
  UNWIND relations AS relation
  WITH relation
  WHERE relation.fromId IS NOT NULL AND relation.toId IS NOT NULL AND relation.type IS NOT NULL
  MERGE (from:RunTime {nodeid: relation.fromId})
  MERGE (to:RunTime {nodeid: relation.toId})
  FOREACH (_ IN CASE WHEN relation.type = 'CALLS_AT_RUNTIME' THEN [1] ELSE [] END |
    MERGE (from)-[rel:CALLS_AT_RUNTIME]->(to)
    FOREACH (key IN keys(coalesce(relation.props, {})) |
      FOREACH (__ IN CASE
        WHEN relation.props[key] IS NOT NULL
          AND NOT valueType(relation.props[key]) CONTAINS 'MAP'
          AND NOT valueType(relation.props[key]) CONTAINS 'NODE'
          AND NOT valueType(relation.props[key]) CONTAINS 'RELATIONSHIP'
          AND NOT valueType(relation.props[key]) CONTAINS 'PATH'
        THEN [1]
        ELSE []
      END | SET rel[key] = relation.props[key])))
  FOREACH (_ IN CASE WHEN relation.type = 'response' THEN [1] ELSE [] END |
    MERGE (from)-[rel:response]->(to)
    FOREACH (key IN keys(coalesce(relation.props, {})) |
      FOREACH (__ IN CASE
        WHEN relation.props[key] IS NOT NULL
          AND NOT valueType(relation.props[key]) CONTAINS 'MAP'
          AND NOT valueType(relation.props[key]) CONTAINS 'NODE'
          AND NOT valueType(relation.props[key]) CONTAINS 'RELATIONSHIP'
          AND NOT valueType(relation.props[key]) CONTAINS 'PATH'
        THEN [1]
        ELSE []
      END | SET rel[key] = relation.props[key])))
  FOREACH (_ IN CASE WHEN relation.type = 'STATIC_DEF' THEN [1] ELSE [] END |
    MERGE (from)-[rel:STATIC_DEF]->(to)
    FOREACH (key IN keys(coalesce(relation.props, {})) |
      FOREACH (__ IN CASE
        WHEN relation.props[key] IS NOT NULL
          AND NOT valueType(relation.props[key]) CONTAINS 'MAP'
          AND NOT valueType(relation.props[key]) CONTAINS 'NODE'
          AND NOT valueType(relation.props[key]) CONTAINS 'RELATIONSHIP'
          AND NOT valueType(relation.props[key]) CONTAINS 'PATH'
        THEN [1]
        ELSE []
      END | SET rel[key] = relation.props[key])))
  RETURN count(*) AS appliedRelations
}
CALL {
  WITH anchors
  UNWIND anchors AS anchor
  WITH anchor
  WHERE anchor.fromId IS NOT NULL
    AND anchor.type IS NOT NULL
    AND anchor.target.labelExpression IS NOT NULL
  MERGE (from:RunTime {nodeid: anchor.fromId})
  WITH from, anchor
  OPTIONAL MATCH (targetFn:Static:Fn)
    WHERE anchor.target.labelExpression = 'Static:Fn'
      AND targetFn.stableId = anchor.target.matchProps.stableId
  OPTIONAL MATCH (targetDecision:Static:Decision)
    WHERE anchor.target.labelExpression = 'Static:Decision'
      AND targetDecision.decisionId = anchor.target.matchProps.decisionId
  OPTIONAL MATCH (targetPredicate:Static:Predicate)
    WHERE anchor.target.labelExpression = 'Static:Predicate'
      AND targetPredicate.predicateId = anchor.target.matchProps.predicateId
  OPTIONAL MATCH (targetBranch:Static:Branch)
    WHERE anchor.target.labelExpression = 'Static:Branch'
      AND targetBranch.branchId = anchor.target.matchProps.branchId
  OPTIONAL MATCH (targetStore:Static:Store)
    WHERE anchor.target.labelExpression = 'Static:Store'
      AND targetStore.storeKey = anchor.target.matchProps.storeKey
  WITH from, anchor, coalesce(targetFn, targetDecision, targetPredicate, targetBranch, targetStore) AS target
  WHERE target IS NOT NULL
  FOREACH (_ IN CASE WHEN anchor.type = 'STATIC_DEF' THEN [1] ELSE [] END |
    MERGE (from)-[rel:STATIC_DEF]->(target)
    FOREACH (key IN keys(coalesce(anchor.props, {})) |
      FOREACH (__ IN CASE
        WHEN anchor.props[key] IS NOT NULL
          AND NOT valueType(anchor.props[key]) CONTAINS 'MAP'
          AND NOT valueType(anchor.props[key]) CONTAINS 'NODE'
          AND NOT valueType(anchor.props[key]) CONTAINS 'RELATIONSHIP'
          AND NOT valueType(anchor.props[key]) CONTAINS 'PATH'
        THEN [1]
        ELSE []
      END | SET rel[key] = anchor.props[key])))
  RETURN count(target) AS appliedAnchors
}
RETURN 1 AS applied
`;