import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILTER_STABLE_ID = 'screens/REPL.tsx:3195:31:3195:104';
const PREDICATE_STABLE_ID = 'screens/REPL.tsx:3195:66:3195:103';
const RELAY_URL = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const SESSION_ID = `collection-filter-${Date.now()}`;
const ARTIFACT_PATH = path.resolve('graph/runtime/onSubmit-3195-filter.analysis.json');
const INPUT = [
  '[Pasted text #1]',
  '[Image #2]',
  '[...Truncated text #3]',
  '[Pasted text #4 +2 lines]',
].join(' ');

// Kept isolated from history.ts because that application module imports Bun-only runtime APIs.
function parseReferences(input: string): Array<{ id: number; match: string; index: number }> {
  const referencePattern = /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g;
  return [...input.matchAll(referencePattern)]
    .map((match) => ({
      id: Number.parseInt(match[2] || '0', 10),
      match: match[0],
      index: match.index,
    }))
    .filter((match) => match.id > 0);
}

process.env.GRAPH_NODE_LOGGING = '1';
process.env.GRAPH_RUNTIME_SESSION_ID = SESSION_ID;
process.env.GRAPH_NODE_LOGGING_BATCH_MS = '0';

const manifest = JSON.parse(await readFile(
  path.resolve('graph/instrumentation/node-pass-targets.json'),
  'utf8',
));
const filterTarget = manifest.targets.find((target: { stableId: string }) => (
  target.stableId === FILTER_STABLE_ID
));
const predicateTarget = manifest.targets.find((target: { stableId: string }) => (
  target.stableId === PREDICATE_STABLE_ID
));
if (!filterTarget || !predicateTarget) {
  throw new Error('Filter instrumentation targets are missing from the graph-derived manifest');
}

const {
  evaluateCollectionCall,
  evaluateNode,
  flushPendingNodePassEvents,
  installRuntimeNodePassReporter,
  wrapCollectionCallback,
} = await import('./runtimeNodePassReporter.mjs');

if (!installRuntimeNodePassReporter()) {
  throw new Error('Runtime node-pass reporter was not installed');
}

const runtimeDataUrl = new URL('/runtime-data', RELAY_URL);
const clearResponse = await fetch(runtimeDataUrl, { method: 'DELETE' });
if (!clearResponse.ok) {
  throw new Error(`Could not clear runtime events: HTTP ${clearResponse.status}`);
}

const pastedContents: Record<number, { id: number; type: 'text' | 'image'; content: string }> = {
  1: { id: 1, type: 'text', content: 'alpha' },
  2: { id: 2, type: 'image', content: 'image-bytes' },
  3: { id: 3, type: 'text', content: 'truncated text' },
  4: { id: 4, type: 'image', content: 'other-image-bytes' },
};
const references = parseReferences(INPUT);
const callback = wrapCollectionCallback(filterTarget, (reference: { id: number }) => (
  evaluateNode(predicateTarget, () => pastedContents[reference.id]?.type === 'text')
));
const result = evaluateCollectionCall(filterTarget, () => references.filter(callback));
await flushPendingNodePassEvents();

const analysisUrl = new URL('/runtime-analysis', RELAY_URL);
analysisUrl.searchParams.set('stableId', FILTER_STABLE_ID);
analysisUrl.searchParams.set('sessionId', SESSION_ID);
const analysisResponse = await fetch(analysisUrl);
if (!analysisResponse.ok) {
  throw new Error(`Runtime analysis failed: HTTP ${analysisResponse.status}`);
}
const { analysis } = await analysisResponse.json();

if (references.length !== 4 || result.map((reference) => reference.id).join(',') !== '1,3') {
  throw new Error(`Unexpected filter result: ${JSON.stringify({ references, result })}`);
}
if (
  analysis.totalIterations !== 4
    || analysis.acceptedIterations !== 2
    || analysis.rejectedIterations !== 2
    || analysis.segments.length !== 2
) {
  throw new Error(`Unexpected filter statistics: ${JSON.stringify(analysis)}`);
}

const artifact = {
  input: INPUT,
  sessionId: SESSION_ID,
  stableId: FILTER_STABLE_ID,
  resultIds: result.map((reference) => reference.id),
  analysis,
};
await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  sessionId: SESSION_ID,
  parsedReferences: references.length,
  acceptedReferences: result.length,
  rejectedReferences: references.length - result.length,
  segments: analysis.segments.map((segment: { label: string; count: number }) => ({
    label: segment.label,
    count: segment.count,
  })),
  artifactPath: ARTIFACT_PATH,
}, null, 2));
