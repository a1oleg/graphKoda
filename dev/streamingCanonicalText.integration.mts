import assert from 'node:assert/strict';
import { createProgram } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';
import { writeFunctionFlowArtifacts } from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';

const expected = new Map([
  ['src/components/common/AnimatedCounter.tsx:16:2:16:15', ['text', 'text: string;']],
  ['src/components/modals/gift/craft/GiftCraftModal.tsx:382:8:382:42', ['cubeRef', 'cubeRef = useRef<HTMLDivElement>()']],
  ['src/lib/fasterdom/fasterdom.ts:64:2:64:31', ['pendingMutationTasks.push', 'pendingMutationTasks.push(cb)']],
]);
const writes = new Map<string, number>();
const functions = new Set<string>();
const selected = new Set([
  'src/components/common/AnimatedCounter.tsx:31:38:67:1',
  'src/components/modals/gift/craft/GiftCraftModal.tsx:269:23:1636:1',
]);
console.log('Streaming actual Telegram functions and canonical catalog');
writeFunctionFlowArtifacts(createProgram(), {
  writeFunction: row => { functions.add(row.stableId.value); },
  writeNode() {}, writeEdge() {}, writeResource() {}, writeResourceEdge() {}, writeResourceLink() {},
  writeSemanticRelationship() {},
  writeSemanticEntity: row => {
    const text = expected.get(row.stableId);
    if (!text) return;
    assert.deepEqual([row.props.name, row.props.syntax], text, `Canonical text overwritten: ${row.stableId}`);
    writes.set(row.stableId, (writes.get(row.stableId) || 0) + 1);
  },
}, false, selected);
for (const id of expected.keys()) assert.ok((writes.get(id) || 0) > 1, `Composition not exercised: ${id}`);
for (const id of selected) assert.ok(functions.has(id), `Function not streamed: ${id}`);
console.log(JSON.stringify({ canonicalWrites: [...writes], ok: true }));
