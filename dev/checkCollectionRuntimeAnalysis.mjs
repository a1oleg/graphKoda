import { buildCollectionRuntimeAnalysis } from '../graph/packages/runtime-relay/src/collectionRuntimeAnalysis.js';

const stableId = 'source.ts:10:0:10:20';
const sessionId = 'analysis-test';
let score = 1;
const records = [];
let previous;

function append(role, staticId, props = {}) {
  const nodeId = `event-${score}`;
  records.push({
    nodeId,
    parentNodeId: previous || null,
    functionStableId: staticId,
    sessionId,
    score,
    raw: { nodeProps: { role, ...props } },
  });
  previous = nodeId;
  score += 1;
}

append('collection-method', stableId, { methodName: 'find' });
for (let index = 0; index < 3; index += 1) {
  append('collection-pop', `${stableId}:pop`, { iterationIndex: index, itemPreview: `item-${index}` });
  append('predicate-stage', `${stableId}:enabled`, { iterationIndex: index, stageName: 'enabled', outcome: true });
  append('collection-predicate', `${stableId}:callback`, { iterationIndex: index, outcome: index === 2, matched: index === 2 });
}
append('collection-result', `${stableId}:result`, {
  itemPreview: 'item-2',
  outcome: true,
  continuesAfterResult: true,
});
append('predicate-stage', `${stableId}:outer-predicate`, {
  stageName: 'type === local-jsx',
  outcome: true,
});
append('flow-join', `${stableId}:true-join`, { stageName: 'true destination' });

const analysis = buildCollectionRuntimeAnalysis(records, { stableId, sessionId });
if (analysis.totalIterations !== 3 || analysis.matchedIterations !== 1 || analysis.rejectedIterations !== 2) {
  throw new Error(`Unexpected iteration summary: ${JSON.stringify(analysis)}`);
}
if (analysis.segments.length !== 2 || analysis.segments[0].count !== 2) {
  throw new Error(`Expected two path segments with one repeated path: ${JSON.stringify(analysis.segments)}`);
}
if (!analysis.iterations[0].staticStableIds.includes(`${stableId}:enabled`)) {
  throw new Error('Iteration projection lost a static predicate stableId');
}
const matchedIteration = analysis.iterations.find((iteration) => iteration.outcome === 'matched');
if (
  !matchedIteration?.staticStableIds.includes(`${stableId}:outer-predicate`)
  || !matchedIteration.staticStableIds.includes(`${stableId}:true-join`)
  || !matchedIteration.branchPath.some((stage) => stage.stageName === 'type === local-jsx' && stage.outcome)
) {
  throw new Error(`Matched iteration lost post-result continuation: ${JSON.stringify(matchedIteration)}`);
}
if (!matchedIteration.edgePairs.some((edge) => (
  edge.sourceStableId === `${stableId}:outer-predicate`
  && edge.targetStableId === `${stableId}:true-join`
  && edge.edgeType === 'TRUE'
))) {
  throw new Error(`Matched iteration lost the terminal TRUE edge: ${JSON.stringify(matchedIteration.edgePairs)}`);
}
const edgeKeys = matchedIteration.edgePairs.map((edge) => (
  `${edge.sourceStableId}|${edge.targetStableId}|${edge.edgeType || ''}`
));
if (new Set(edgeKeys).size !== edgeKeys.length) {
  throw new Error(`Matched iteration contains duplicate edge pairs: ${JSON.stringify(matchedIteration.edgePairs)}`);
}

console.log(JSON.stringify({
  ok: true,
  totalIterations: analysis.totalIterations,
  segmentCounts: analysis.segments.map((segment) => segment.count),
}, null, 2));
