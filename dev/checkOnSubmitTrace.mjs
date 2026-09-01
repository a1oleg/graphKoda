import fs from 'node:fs';

const tracePath = 'graph/runtime/onSubmit.trace.json';
const diagramPath = 'graph/draw/generated/onSubmit-REPL.tsx-3142.drawio';
const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
const brokenLinks = [];
for (let index = 1; index < trace.chain.length; index += 1) {
  if (trace.chain[index].predecessorEventIds[0] !== trace.chain[index - 1].eventId) {
    brokenLinks.push(index);
  }
}

const xml = fs.readFileSync(diagramPath, 'utf8');
const observedCellCount = [...xml.matchAll(/runtimeObserved="1"/g)].length;
const edgePairs = trace.runtimeSelection?.edgePairs || [];
const attachedFalseEdge = edgePairs.some((edge) => (
  edge.sourceStableId === 'screens/REPL.tsx:3154:8:3154:28'
  && edge.targetStableId === 'screens/REPL.tsx:3154:32:3154:49'
  && edge.edgeType === 'FALSE'
));
const canonicalStableIdPattern = /^screens\/REPL\.tsx:\d+:\d+:\d+:\d+$/;
const nonCanonicalChainStableIds = trace.chain
  .map((event) => event.stableId)
  .filter((stableId) => !canonicalStableIdPattern.test(stableId));
const requiredCoverage = {
  next: edgePairs.some((edge) => edge.edgeType === 'NEXT'),
  trueBranch: edgePairs.some((edge) => edge.edgeType === 'TRUE'),
  falseBranch: edgePairs.some((edge) => edge.edgeType === 'FALSE'),
  objectFields: edgePairs.some((edge) => edge.edgeType === 'FIELD'),
  objectFieldJoins: edgePairs.some((edge) => edge.edgeType === 'FieldJoin'),
  predicateHighlights: trace.runtimeSelection?.nodeHighlights?.some((node) => node.role === 'predicate-stage'),
  joinHighlights: trace.runtimeSelection?.nodeHighlights?.some((node) => node.role === 'join-stage'),
};
if (
  brokenLinks.length
  || trace.chain.length < 3
  || !trace.involvedEdgeIds.length
  || !edgePairs.length
  || !attachedFalseEdge
  || nonCanonicalChainStableIds.length
  || Object.values(requiredCoverage).some((covered) => !covered)
  || !xml.startsWith('<mxfile')
  || observedCellCount !== 0
) {
  throw new Error(JSON.stringify({
    brokenLinks,
    nonCanonicalChainStableIds,
    observedCellCount,
    edgePairCount: edgePairs.length,
    attachedFalseEdge,
    requiredCoverage,
  }, null, 2));
}

console.log(JSON.stringify({
  ok: true,
  sessionId: trace.sessionId,
  eventCount: trace.eventCount,
  chainLength: trace.chain.length,
  highlightedEdgeCount: trace.involvedEdgeIds.length,
  edgePairCount: edgePairs.length,
  attachedFalseEdge,
  nonCanonicalChainStableIds,
  requiredCoverage,
  observedCellCount,
  brokenLinks,
  firstStableId: trace.chain[0].stableId,
  lastStableId: trace.chain.at(-1).stableId,
}, null, 2));
