import assert from 'node:assert/strict';
import { createProgram } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { createFunctionFlowExtractionContext, extractFunctionFlowGraphs, payloadForTransport } from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';

const program = createProgram();
console.log('Preparing actual Telegram extraction context');
const context = createFunctionFlowExtractionContext(program);
for (const [fn, step] of [
  ['src/components/left/LeftColumn.tsx:146:38:388:3', 'flow-step:execution:src/components/left/LeftColumn.tsx:377:10:377:16'],
  ['src/util/deeplink.ts:13:31:276:1', 'flow-step:execution:src/util/deeplink.ts:125:8:125:14'],
]) {
  const payload = payloadForTransport(extractFunctionFlowGraphs(program, fn, context, { includeParameterOrigins: false }));
  const merged = payload.nodes.find(node => node.stableId === step);
  assert.ok(merged?.combinedStepFlowBlock, `Missing merged step: ${step}`);
  assert.equal(merged.parentFnStableId, fn);
  assert.ok(payload.edges.some(edge => edge.type === 'HAS_FLOW_BLOCK' && edge.toId === step));
  const nested = payload.edges.filter(edge => edge.type === 'NESTED_IN');
  assert.ok(nested.length > 0, `Lost all containment: ${fn}`);
  for (const edge of nested) assert.notEqual(edge.fromId, edge.toId, `Self containment: ${edge.fromId}`);
  console.log(JSON.stringify({ fn, step, nestedEdges: nested.length, ok: true }));
}
