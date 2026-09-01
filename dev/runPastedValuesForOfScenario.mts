import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOOP_STABLE_ID = 'screens/REPL.tsx:3443:8:3468:9';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const SESSION_ID = `pasted-values-for-of-${Date.now()}`;
const ARTIFACT_PATH = path.resolve('graph/runtime/onSubmit-3443-for-of.analysis.json');

process.env.GRAPH_NODE_LOGGING = '1';
process.env.GRAPH_RUNTIME_SESSION_ID = SESSION_ID;
process.env.GRAPH_NODE_LOGGING_BATCH_MS = '0';

const manifest = JSON.parse(await readFile(
  path.resolve('graph/instrumentation/node-pass-targets.json'),
  'utf8',
));
const target = (stableId: string) => manifest.targets.find((candidate: { stableId: string }) => (
  candidate.stableId === stableId
));
const loopTarget = target(LOOP_STABLE_ID);
const predicateTarget = target('screens/REPL.tsx:3444:14:3444:37');
const sourceTarget = target('screens/REPL.tsx:3445:18:3445:24');
const imageContentPushTarget = target('screens/REPL.tsx:3450:12:3453:14');
const imageRemotePushTarget = target('screens/REPL.tsx:3454:12:3457:14');
const textContentPushTarget = target('screens/REPL.tsx:3459:12:3462:14');
const textRemotePushTarget = target('screens/REPL.tsx:3463:12:3466:14');
if (
  !loopTarget
  || !predicateTarget
  || !sourceTarget
  || !imageContentPushTarget
  || !imageRemotePushTarget
  || !textContentPushTarget
  || !textRemotePushTarget
) {
  throw new Error('The for-of graph instrumentation targets are incomplete');
}

const {
  evaluateNode,
  flushPendingNodePassEvents,
  installRuntimeNodePassReporter,
  wrapForOfIterable,
} = await import('./runtimeNodePassReporter.mjs');

if (!installRuntimeNodePassReporter()) throw new Error('Runtime node-pass reporter was not installed');

const runtimeDataUrl = new URL('/runtime-data', RELAY_URL);
const clearResponse = await fetch(runtimeDataUrl, { method: 'DELETE' });
if (!clearResponse.ok) throw new Error(`Could not clear runtime events: HTTP ${clearResponse.status}`);

const pastedValues: Array<{
  id: string;
  type: 'image' | 'text';
  mediaType?: string;
  content: string;
}> = [
  { id: 'image-1', type: 'image', mediaType: 'image/jpeg', content: 'image-one' },
  { id: 'text-1', type: 'text', content: 'alpha' },
  { id: 'image-2', type: 'image', content: 'image-two' },
];
const contentBlocks: Array<Record<string, unknown>> = [];
const remoteBlocks: Array<Record<string, unknown>> = [];

for (const pasted of wrapForOfIterable(loopTarget, pastedValues)) {
  if (evaluateNode(predicateTarget, () => pasted.type === 'image')) {
    const source = evaluateNode(sourceTarget, () => ({
      type: 'base64' as const,
      media_type: pasted.mediaType ?? 'image/png',
      data: pasted.content,
    }));
    evaluateNode(imageContentPushTarget, () => contentBlocks.push({ type: 'image', source }));
    evaluateNode(imageRemotePushTarget, () => remoteBlocks.push({ type: 'image', source }));
  } else {
    evaluateNode(textContentPushTarget, () => contentBlocks.push({ type: 'text', text: pasted.content }));
    evaluateNode(textRemotePushTarget, () => remoteBlocks.push({ type: 'text', text: pasted.content }));
  }
}
await flushPendingNodePassEvents();

const analysisUrl = new URL('/runtime-analysis', RELAY_URL);
analysisUrl.searchParams.set('stableId', LOOP_STABLE_ID);
analysisUrl.searchParams.set('sessionId', SESSION_ID);
const analysisResponse = await fetch(analysisUrl);
if (!analysisResponse.ok) throw new Error(`Runtime analysis failed: HTTP ${analysisResponse.status}`);
const { analysis } = await analysisResponse.json();

const imagePath = [imageContentPushTarget.stableId, imageRemotePushTarget.stableId];
const textPath = [textContentPushTarget.stableId, textRemotePushTarget.stableId];
const pathPresent = (iteration: { staticStableIds: string[] }, expected: string[]) => (
  expected.every((stableId) => iteration.staticStableIds.includes(stableId))
);
if (
  contentBlocks.length !== 3
  || remoteBlocks.length !== 3
  || contentBlocks.map((block) => block.type).join(',') !== 'image,text,image'
  || analysis.totalIterations !== 3
  || analysis.matchedIterations !== 2
  || analysis.rejectedIterations !== 1
  || analysis.segments.length !== 2
  || !analysis.iterations.filter((iteration: { outcome: string }) => iteration.outcome === 'matched')
    .every((iteration: { staticStableIds: string[] }) => pathPresent(iteration, [sourceTarget.stableId, ...imagePath]))
  || !analysis.iterations.filter((iteration: { outcome: string }) => iteration.outcome === 'rejected')
    .every((iteration: { staticStableIds: string[] }) => pathPresent(iteration, textPath))
) {
  throw new Error(`Unexpected for-of runtime analysis: ${JSON.stringify({ contentBlocks, remoteBlocks, analysis })}`);
}

const matchedSegment = analysis.segments.find((segment: { outcome: string }) => segment.outcome === 'matched');
const rejectedSegment = analysis.segments.find((segment: { outcome: string }) => segment.outcome === 'rejected');
const hasEdge = (segment: { edgePairs: Array<Record<string, unknown>> } | undefined, expected: Record<string, unknown>) => (
  segment?.edgePairs.some((edge) => Object.entries(expected).every(([key, value]) => edge[key] === value)) === true
);
if (
  !hasEdge(matchedSegment, {
    sourceStableId: predicateTarget.stableId,
    targetStableId: sourceTarget.stableId,
    edgeType: 'TRUE',
  })
  || !hasEdge(matchedSegment, {
    sourceStableId: sourceTarget.stableId,
    targetStableId: imageContentPushTarget.stableId,
  })
  || !hasEdge(matchedSegment, {
    sourceStableId: imageRemotePushTarget.stableId,
    targetStableId: loopTarget.pullStableId,
    edgeType: 'REPEATS',
  })
  || !hasEdge(rejectedSegment, {
    sourceStableId: textRemotePushTarget.stableId,
    targetStableId: loopTarget.pullStableId,
    edgeType: 'REPEATS',
  })
) {
  throw new Error(`For-of analysis lost a graph edge: ${JSON.stringify(analysis.segments)}`);
}

const artifact = {
  sessionId: SESSION_ID,
  stableId: LOOP_STABLE_ID,
  inputIds: pastedValues.map((value) => value.id),
  contentBlocks,
  remoteBlocks,
  analysis,
};
await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  sessionId: SESSION_ID,
  iterations: analysis.totalIterations,
  matched: analysis.matchedIterations,
  rejected: analysis.rejectedIterations,
  segments: analysis.segments.map((segment: { label: string; count: number }) => ({
    label: segment.label,
    count: segment.count,
  })),
  artifactPath: ARTIFACT_PATH,
}, null, 2));
