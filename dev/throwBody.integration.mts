import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProgram } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { createFunctionFlowExtractionContext, extractFunctionFlowGraphs, payloadForTransport } from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';
import paths from './projectPaths.cjs';

const ids = [
  'src/lib/fasttextweb/fasttext-wasm.js:8:1865:8:1895',
  'src/lib/fasttextweb/fasttext-wasm.js:8:31161:8:31194',
  'src/lib/fasttextweb/fasttext-wasm.js:8:322:8:355',
  'src/lib/fasttextweb/fasttext-wasm.js:8:63199:8:63267',
  'src/lib/fasttextweb/fasttext-wasm.js:8:63295:8:63365',
  'src/lib/gramjs/Utils.ts:10:0:12:1',
  'src/lib/gramjs/network/connection/Connection.ts:220:2:224:3',
  'src/lib/gramjs/network/connection/Connection.ts:226:2:229:3',
  'src/util/forceReflow.ts:2:15:5:1',
];
const program = createProgram();
console.log('Preparing real Telegram extraction context');
const context = createFunctionFlowExtractionContext(program);
const output = path.join(paths.dataRoot, 'checks', 'throw-body-regression');
fs.mkdirSync(output, { recursive: true });
for (const [index, id] of ids.entries()) {
  const payload = payloadForTransport(extractFunctionFlowGraphs(program, id, context, { includeParameterOrigins: false }));
  const nodes = new Map(payload.nodes.map(n => [n.stableId, n]));
  const owned = payload.nodes.filter(n => n.parentFnStableId === id);
  const throws = owned.filter(n => n.labels.includes('Throw'));
  if (!id.includes('forceReflow')) assert.equal(throws.length, 1, id);
  for (const step of owned.filter(n => n.labels.includes('Step'))) {
    assert.ok(!step.syntaxEntryStableId || nodes.has(step.syntaxEntryStableId), `Missing step target: ${step.stableId}`);
  }
  const start = owned.find(n => n.labels.includes('FunctionStart'));
  assert.ok(start, id);
  const reached = new Set([start!.stableId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of payload.edges) {
      if (['SIGNATURE_PARAMETER', 'SIGNATURE_RETURN', 'BODY_ENTRY', 'NEXT'].includes(edge.type)
          && reached.has(edge.fromId) && !reached.has(edge.toId)) {
        reached.add(edge.toId); changed = true;
      }
    }
  }
  for (const node of throws) assert.ok(reached.has(node.stableId), `Unreachable throw: ${id}`);
  if (id.includes('forceReflow')) assert.ok(reached.has('src/util/forceReflow.ts:4:2:4:21'));
  fs.writeFileSync(path.join(output, `${index}.json`), JSON.stringify(payload));
  console.log(JSON.stringify({ id, nodes: payload.nodes.length, throws: throws.length, ok: true }));
}
console.log(JSON.stringify({ output, verified: ids.length }));
