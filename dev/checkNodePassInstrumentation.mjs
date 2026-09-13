import { readFileSync } from 'node:fs';
import path from 'node:path';
import projectPaths from './projectPaths.cjs';

import { getNodePassTargetsForFile, instrumentNodePassSource } from './instrumentNodePassSource.mjs';
import { createNodePassPayload } from './runtimeNodePassReporter.mjs';

const root = projectPaths.sourceRoot;
const filePath = path.join(root, 'screens', 'REPL.tsx');
const source = readFileSync(filePath, 'utf8');
const transformed = await instrumentNodePassSource(source, filePath);
const targets = getNodePassTargetsForFile(filePath);
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const expectedOccurrencesByStableId = new Map();
for (const target of targets) {
  const contribution = target.instrumentationKind === 'collection-iteration' ? 2 : 1;
  expectedOccurrencesByStableId.set(
    target.stableId,
    (expectedOccurrencesByStableId.get(target.stableId) || 0) + contribution,
  );
}
for (const [stableId, expectedOccurrences] of expectedOccurrencesByStableId) {
  const occurrences = [...transformed.matchAll(
    new RegExp(`stableId:\\s*["']${escapeRegExp(stableId)}["']`, 'g'),
  )].length;
  if (occurrences !== expectedOccurrences) {
    throw new Error(`Expected ${expectedOccurrences} injected ${stableId}, found ${occurrences}`);
  }
}
if (!/feature\(['\"]PROACTIVE['\"]\)\s*\|\|\s*feature\(['\"]KAIROS['\"]\)/.test(transformed)) {
  throw new Error('Target condition changed during Babel instrumentation');
}
if (!transformed.includes('__coldKodeEvaluateCollectionCall') || !transformed.includes('__coldKodeWrapCollectionCallback')) {
  throw new Error('Collection iteration callback was not instrumented');
}
if (!transformed.includes('__coldKodeWrapForOfIterable')) {
  throw new Error('The for-of iterable was not instrumented');
}
if (!transformed.includes('__coldKodeWrapForOfIterable({') || !transformed.includes('pastedValues')) {
  throw new Error('The native pastedValues for-of loop was replaced instead of wrapping its iterable');
}
if (!transformed.includes('commands.find')) {
  throw new Error('Native commands.find execution was replaced instead of wrapped');
}
if (!transformed.includes('parseReferences(input).filter')) {
  throw new Error('Native parseReferences(input).filter execution was replaced instead of wrapped');
}
if (!/stageName:\s*["']type === text["']/.test(transformed)) {
  throw new Error('Filter predicate stage was not instrumented from its graph target');
}
const negatedKeybindingStableId = 'screens/REPL.tsx:3316:9:3316:32';
const negatedKeybindingIndex = transformed.indexOf(negatedKeybindingStableId);
const negatedKeybindingSnippet = transformed.slice(
  negatedKeybindingIndex,
  negatedKeybindingIndex + 600,
);
if (
  negatedKeybindingIndex < 0
  || !negatedKeybindingSnippet.includes('()=>!options?.fromKeybinding')
) {
  throw new Error('Negated if predicate was instrumented below its complete AST expression');
}

for (const conditionalStableId of [
  'screens/REPL.tsx:3318:17:3318:90',
  'screens/REPL.tsx:3319:24:3319:63',
]) {
  const conditionalIndex = transformed.indexOf(conditionalStableId);
  const conditionalSnippet = transformed.slice(conditionalIndex, conditionalIndex + 700);
  if (
    conditionalIndex < 0
    || !conditionalSnippet.includes('()=>speculationAccept')
    || conditionalSnippet.includes('()=>speculationAccept?')
  ) {
    throw new Error(`Conditional predicate ${conditionalStableId} must instrument only its test`);
  }
}

const nullishStableId = 'screens/REPL.tsx:3294:38:3294:90';
const nullishIndex = transformed.indexOf(nullishStableId);
const nullishSnippet = transformed.slice(nullishIndex, nullishIndex + 1000);
if (
  nullishIndex < 0
  || !/predicateOutcomeMode\s*:\s*["']non-nullish["']/.test(nullishSnippet)
  || !/\(\)\s*=>\s*process\.env\.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES/.test(nullishSnippet)
  || /\(\)\s*=>\s*process\.env\.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES\s*\?\?\s*75/.test(nullishSnippet)
) {
  throw new Error('Nullish coalescing must instrument its left operand with non-nullish outcome semantics');
}

const legacyStableId = 'flow-step:condition:screens/REPL.tsx:3154:8:3154:49';
const stableId = 'screens/REPL.tsx:3154:8:3154:49';
const predecessorEventId = 'visit:previous';
const [envelope] = createNodePassPayload({
  stableId: legacyStableId,
  ownerFnStableId: 'screens/REPL.tsx:3142:31:3533:3',
  filePath: 'screens/REPL.tsx',
  startLine: 3154,
  startColumn: 8,
  endLine: 3154,
  endColumn: 49,
  role: 'step',
}, 1, {
  eventId: 'visit:current',
  predecessorEventIds: [predecessorEventId],
  outcome: false,
});
if (envelope.flat.stableId !== stableId || envelope.flat.kind !== 'node-visit') {
  throw new Error('Node-pass runtime envelope does not expose the static step identity');
}
if (envelope.parentNodeid !== predecessorEventId || envelope.nodeProps.outcome !== false) {
  throw new Error('Node-pass runtime envelope does not preserve causality and outcome');
}

console.log(JSON.stringify({
  ok: true,
  stableId,
  instrumentedTargetCount: targets.length,
  runtimeKind: envelope.flat.kind,
}, null, 2));
