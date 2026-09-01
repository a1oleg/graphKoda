import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REDUCE_STABLE_ID = 'screens/REPL.tsx:3197:32:3197:119';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const SESSION_ID = `collection-reduce-${Date.now()}`;
const ARTIFACT_PATH = path.resolve('graph/runtime/onSubmit-3197-reduce.analysis.json');

process.env.GRAPH_NODE_LOGGING = '1';
process.env.GRAPH_RUNTIME_SESSION_ID = SESSION_ID;
process.env.GRAPH_NODE_LOGGING_BATCH_MS = '0';

const manifest = JSON.parse(await readFile(
  path.resolve('graph/instrumentation/node-pass-targets.json'),
  'utf8',
));
const reduceTarget = manifest.targets.find((target: { stableId: string }) => (
  target.stableId === REDUCE_STABLE_ID
));
if (!reduceTarget) throw new Error('Reduce instrumentation target is missing from the graph-derived manifest');
const valuePathTargets = manifest.targets.filter((target: { role?: string; startLine?: number }) => (
  (target.role === 'value-source' || target.role === 'value-stage') && target.startLine === 3197
));
const contributionTarget = valuePathTargets.find((target: { stageName?: string }) => (
  target.stageName === 'content length or zero'
));
if (!contributionTarget) {
  throw new Error('Reduce value-path instrumentation targets are missing from the graph-derived manifest');
}

const {
  evaluateCollectionCall,
  evaluateNode,
  flushPendingNodePassEvents,
  installRuntimeNodePassReporter,
  wrapCollectionCallback,
} = await import('./runtimeNodePassReporter.mjs');

if (!installRuntimeNodePassReporter()) throw new Error('Runtime node-pass reporter was not installed');

const runtimeDataUrl = new URL('/runtime-data', RELAY_URL);
const clearResponse = await fetch(runtimeDataUrl, { method: 'DELETE' });
if (!clearResponse.ok) throw new Error(`Could not clear runtime events: HTTP ${clearResponse.status}`);

const pastedTextRefs = [{ id: 1 }, { id: 3 }, { id: 5 }];
const pastedContents: Record<number, { content?: string }> = {
  1: { content: 'alpha' },
  3: { content: 'truncated text' },
  5: {},
};
const callback = wrapCollectionCallback(
  reduceTarget,
  (sum: number, reference: { id: number }) => {
    const contribution = evaluateNode(
      contributionTarget,
      () => pastedContents[reference.id]?.content?.length ?? 0,
    );
    return sum + contribution;
  },
);
const result = evaluateCollectionCall(
  reduceTarget,
  () => pastedTextRefs.reduce(callback, 0),
);
await flushPendingNodePassEvents();

const analysisUrl = new URL('/runtime-analysis', RELAY_URL);
analysisUrl.searchParams.set('stableId', REDUCE_STABLE_ID);
analysisUrl.searchParams.set('sessionId', SESSION_ID);
const analysisResponse = await fetch(analysisUrl);
if (!analysisResponse.ok) throw new Error(`Runtime analysis failed: HTTP ${analysisResponse.status}`);
const { analysis } = await analysisResponse.json();
const accumulatorStates = analysis.iterations.map((iteration: { accumulatorState: string }) => (
  iteration.accumulatorState
));
const firstEdgePairs = analysis.iterations[0]?.edgePairs || [];
const hasNextToExpression = firstEdgePairs.some((pair: { sourceStableId: string; targetStableId: string }) => (
  pair.sourceStableId === reduceTarget.iterationValueStableId
    && pair.targetStableId === contributionTarget.stableId
));
const hasValueToAccumulator = firstEdgePairs.some((pair: { sourceStableId: string; targetStableId: string }) => (
  pair.sourceStableId === contributionTarget.stableId
    && pair.targetStableId === reduceTarget.accumulatorStableId
));

if (result !== 19) throw new Error(`Unexpected reduce result: ${result}`);
if (
  analysis.totalIterations !== 3
  || analysis.iterations.some((iteration: { outcome: string }) => iteration.outcome !== 'accumulated')
  || accumulatorStates.join(',') !== '5,19,19'
  || analysis.accumulatorName !== 'pastedTextBytes'
  || !hasNextToExpression
  || !hasValueToAccumulator
) {
  throw new Error(`Unexpected reduce statistics: ${JSON.stringify(analysis)}`);
}

const artifact = {
  sessionId: SESSION_ID,
  stableId: REDUCE_STABLE_ID,
  inputIds: pastedTextRefs.map((reference) => reference.id),
  result,
  analysis,
};
await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  sessionId: SESSION_ID,
  iterations: analysis.totalIterations,
  accumulatorStates,
  traceContinuesThroughNextAndValue: hasNextToExpression && hasValueToAccumulator,
  result,
  segments: analysis.segments.map((segment: { label: string; count: number }) => ({
    label: segment.label,
    count: segment.count,
  })),
  artifactPath: ARTIFACT_PATH,
}, null, 2));
