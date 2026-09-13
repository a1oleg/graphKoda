:param fnStableId => 'screens/REPL.tsx:3142:31:3533:3';
:param experiment => 'onSubmit-grid-v1';

// Experimental in-graph layout for Neo4j Browser/Explorer inspection.
// Central flow is discovered structurally:
//   local :FlowNode -> local :FlowNode
// No OWNS edge and no relationship-type whitelist are used for the central graph.
//
// Written properties:
//   node.layoutDraftX
//   node.layoutDraftY
//   node.layoutDraftRole
//   node.layoutDraftReason
//   rel.layoutDraftCentral
//   rel.layoutDraftDx
//   rel.layoutDraftBranchRole

// 1. Clear previous run.
MATCH (n)
WHERE n.layoutExperiment = $experiment
REMOVE
  n.layoutExperiment,
  n.layoutDraftX,
  n.layoutDraftY,
  n.layoutDraftRole,
  n.layoutDraftReason;

MATCH ()-[r]->()
WHERE r.layoutExperiment = $experiment
REMOVE
  r.layoutExperiment,
  r.layoutDraftCentral,
  r.layoutDraftDx,
  r.layoutDraftBranchRole,
  r.layoutDraftBranchLen,
  r.layoutDraftMergeOp;

// 2. Mark the function head and local central flow nodes.
MATCH (fn:Fn {stableId: $fnStableId})
SET
  fn.layoutExperiment = $experiment,
  fn.layoutDraftX = 0,
  fn.layoutDraftY = 0,
  fn.layoutDraftRole = 'head',
  fn.layoutDraftReason = 'Function head';

MATCH (n:FlowNode {parentFnStableId: $fnStableId})
SET
  n.layoutExperiment = $experiment,
  n.layoutDraftY = coalesce(n.operation_index, n.start_line, 0) + 1,
  n.layoutDraftRole =
    CASE
      WHEN n:Branch THEN 'branch'
      WHEN n:Merge THEN 'merge'
      WHEN n:FunctionEnd THEN 'end'
      ELSE 'step'
    END,
  n.layoutDraftReason = 'Y from operation_index/start_line: head=0, next=1; X is propagated from flow head';

// 3. Mark central edges without listing flow relationship types.
MATCH (a:FlowNode {parentFnStableId: $fnStableId})-[r]->(b:FlowNode {parentFnStableId: $fnStableId})
SET
  r.layoutExperiment = $experiment,
  r.layoutDraftCentral = true,
  r.layoutDraftDx = 0,
  r.layoutDraftBranchRole = 'down';

// 4. Set first local FlowNode below the function head.
MATCH (fn:Fn {stableId: $fnStableId})-->(head:FlowNode {parentFnStableId: $fnStableId})
WITH head
ORDER BY coalesce(head.operation_index, 999999), head.start_line, head.start_column
LIMIT 1
SET
  head.layoutDraftX = 0,
  head.layoutDraftY = 1,
  head.layoutDraftRole = coalesce(head.layoutDraftRole, 'entry'),
  head.layoutDraftReason = 'Entry FlowNode selected as first local target of Fn';

// 5. For every Branch, rank outgoing central targets.
//    The shorter branch keeps parent X; longer branches get X + rank.
//    Merge is approximated as:
//      a directly targeted Merge if present, otherwise the nearest following Merge by operation_index.
MATCH (b:Branch:FlowNode {parentFnStableId: $fnStableId})-[r]->(t:FlowNode {parentFnStableId: $fnStableId})
WHERE r.layoutDraftCentral = true
WITH b, collect({rel: r, target: t, targetOp: coalesce(t.operation_index, 999999)}) AS outs
WHERE size(outs) >= 2
OPTIONAL MATCH (b)-[:TRUE|FALSE|NEXT|OPTION_CASE|OPTION_DEFAULT|MERGES_TO]->(directMerge:Merge:FlowNode {parentFnStableId: $fnStableId})
WITH b, outs, min(directMerge.operation_index) AS directMergeOp
OPTIONAL MATCH (followingMerge:Merge:FlowNode {parentFnStableId: $fnStableId})
WHERE followingMerge.operation_index > b.operation_index
WITH b, outs, directMergeOp, min(followingMerge.operation_index) AS followingMergeOp
WITH b, outs, coalesce(directMergeOp, followingMergeOp) AS mergeOp
UNWIND outs AS outgoing
WITH
  b,
  outgoing,
  mergeOp,
  CASE
    WHEN mergeOp IS NULL THEN 999999
    WHEN outgoing.targetOp > mergeOp THEN 0
    ELSE mergeOp - outgoing.targetOp
  END AS branchLen
ORDER BY b.stableId, branchLen ASC, outgoing.targetOp ASC
WITH b, collect({rel: outgoing.rel, len: branchLen, mergeOp: mergeOp}) AS ranked
UNWIND range(0, size(ranked) - 1) AS rank
WITH ranked[rank].rel AS rel, ranked[rank] AS item, rank
SET
  rel.layoutDraftDx = rank,
  rel.layoutDraftBranchRole = CASE WHEN rank = 0 THEN 'down-shorter' ELSE 'right-longer' END,
  rel.layoutDraftBranchLen = item.len,
  rel.layoutDraftMergeOp = item.mergeOp;

// 6. Propagate X from the entry down/right through central flow.
//    Merge collapses back left because the chosen candidate is min(parentX + dx).
CALL apoc.periodic.commit(
  "
  MATCH (a:FlowNode {layoutExperiment: $experiment})-[r]->(b:FlowNode {layoutExperiment: $experiment})
  WHERE r.layoutDraftCentral = true
    AND a.layoutDraftX IS NOT NULL
    AND coalesce(b.operation_index, 999999) >= coalesce(a.operation_index, -1)
  WITH
    b,
    min(a.layoutDraftX + coalesce(r.layoutDraftDx, 0)) AS nextX,
    collect(DISTINCT a.stableId)[0..6] AS parentSamples
  WHERE b.layoutDraftX IS NULL OR nextX < b.layoutDraftX
  WITH b, nextX, parentSamples
  LIMIT 1000
  SET
    b.layoutDraftX = nextX,
    b.layoutDraftReason = 'X propagated from central FlowNode parents; sample parents=' + apoc.convert.toJson(parentSamples)
  RETURN count(*) AS updates
  ",
  {experiment: $experiment}
);

// 7. Give disconnected/orphaned local FlowNodes a visible fallback column.
MATCH (n:FlowNode {layoutExperiment: $experiment})
WHERE n.layoutDraftX IS NULL
SET
  n.layoutDraftX = 0,
  n.layoutDraftReason = 'Fallback X=0: not reached by central propagation from function entry';

// 8. Summary for quick Browser feedback.
MATCH (n {layoutExperiment: $experiment})
WITH labels(n) AS labels, count(*) AS count
RETURN labels, count
ORDER BY count DESC, labels;
