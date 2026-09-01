import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';
import { collectFiniteLiteralDomainGraph } from './functionFlowGraph.literalDomains.ts';

test('extracts checker-proven finite literal domains without classifying plain strings', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-literal-domains.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Mode = 'prompt' | 'bash';
type SetterAction<T> = T | ((previous: T) => T);
declare function setMode(value: SetterAction<Mode>): void;
declare function writeText(value: string): void;

enum Phase {
  Ready = 'ready',
  Done = 'done',
}
declare function setPhase(value: Phase): void;

export function subject() {
  setMode('prompt');
  setPhase(Phase.Ready);
  writeText('prompt');
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectFiniteLiteralDomainGraph(program);
    const domains = graph.entities.filter((entity) => entity.labels.includes('LiteralDomain'));
    const occurrences = graph.entities.filter((entity) => entity.labels.includes('LiteralOccurrence'));

    assert.deepEqual(domains.map((entity) => entity.props.name).sort(), ['Mode', 'Phase']);
    assert.equal(occurrences.filter((entity) => entity.props.raw_text === "'prompt'").length, 1);
    assert.equal(occurrences.filter((entity) => entity.props.raw_text === 'Phase.Ready').length, 1);
    assert.ok(graph.relationships.some((relationship) => relationship.type === 'RESOLVES_TO'));

    const payload = extractFunctionFlowGraphs(program);
    const uses = payload.semanticRelationships?.filter((relationship) => relationship.type === 'USES_LITERAL') || [];
    assert.ok(uses.length >= 2, 'finite literal occurrences must be owned by rendered Flow nodes');
    assert.ok(uses.every((relationship) => payload.nodes.some((node) => node.stableId.value === relationship.fromId)));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
