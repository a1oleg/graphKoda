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

const blockPrefixes = [
  'flow-block:alternative:false:src/components/modals/gift/craft/GiftCraftModal.tsx:790:15:793:9',
  'flow-block:side:true:src/components/modals/gift/craft/GiftCraftModal.tsx:786:34:790:9',
];
const owners = new Map<string, Set<string>>();
const instances = new Map(blockPrefixes.map(prefix => [prefix, new Set<string>()]));
for (const fn of [
  'src/components/modals/gift/craft/GiftCraftModal.tsx:772:19:811:5',
  'src/components/modals/gift/craft/GiftCraftModal.tsx:764:45:814:3',
  'src/components/modals/gift/craft/GiftCraftModal.tsx:269:23:1636:1',
]) {
  const payload = payloadForTransport(extractFunctionFlowGraphs(program, fn, context, { includeParameterOrigins: false }));
  const nodes = new Map(payload.nodes.map(node => [node.stableId, node]));
  if (fn === 'src/components/modals/gift/craft/GiftCraftModal.tsx:269:23:1636:1') {
    const update = payload.nodes.find(node => node.stableId.startsWith(
      'src/components/modals/gift/craft/GiftCraftModal.tsx:581:32:581:35:horizontal-owner-',
    ));
    assert.ok(update, 'Missing contextual loop update');
    assert.ok(payload.edges.some(edge => edge.type === 'NEXT' && edge.toId === update.stableId));
    assert.ok(payload.edges.some(edge => edge.type === 'REPEATS' && edge.fromId === update.stableId));
  }
  for (const prefix of blockPrefixes) {
    const blocks = payload.nodes.filter(node => node.stableId === prefix || node.stableId.startsWith(`${prefix}:local-function-`));
    assert.ok(blocks.length, `Missing block ${prefix} in ${fn}`);
    for (const block of blocks) {
      instances.get(prefix)!.add(block.stableId);
      const parents = owners.get(block.stableId) || new Set<string>();
      for (const edge of payload.edges.filter(edge => edge.type === 'NESTED_IN' && edge.fromId === block.stableId)) {
        parents.add(edge.toId);
        const parent = nodes.get(edge.toId);
        assert.ok(parent, `Missing owner ${edge.toId}`);
        assert.equal(parent.parentFnStableId, block.parentFnStableId);
        assert.equal(parent.parentLocalFunctionStableId, block.parentLocalFunctionStableId);
      }
      assert.equal(parents.size, 1, `Conflicting merged owners: ${block.stableId}`);
      assert.ok(parents.has(block.parentFlowBlockStableId!), `Property/edge disagreement: ${block.stableId}`);
      owners.set(block.stableId, parents);
    }
  }
  console.log(JSON.stringify({ fn, contextualBlocksVerified: true }));
}
for (const [prefix, ids] of instances) assert.equal(ids.size, 3, `Context collision: ${prefix}`);
console.log(JSON.stringify({ mergedBlockInstances: owners.size, uniqueOwners: true }));
