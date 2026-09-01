import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.js';

test('materializes source-backed mosaic parts and logical port facets as graph relationships', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-syntax-composition.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function consume(value: number): void {}
export function subject(input: number) {
  consume(input + 1);
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      skipLibCheck: true,
    });
    const payload = extractFunctionFlowGraphs(program);
    const composition = (payload.semanticRelationships || []).filter((relationship) => (
      relationship.type === 'COMPOSES_SYNTAX'
    ));
    assert.ok(composition.length > 0);
    assert.ok(composition.every((relationship) => relationship.fromId !== relationship.toId));
    assert.ok(composition.every((relationship) => relationship.props.layer === 'syntax-composition'));
    assert.ok(composition.every((relationship) => relationship.props.renderHidden === true));
    assert.ok(composition.every((relationship) => relationship.props.fromFacet === 'mosaicOwner'));
    assert.ok(composition.every((relationship) => Boolean(relationship.props.toFacet)));
    assert.ok(composition.every((relationship) => Boolean(relationship.props.sourcePortRole)));
    assert.ok(composition.every((relationship) => Boolean(relationship.props.targetPortRole)));

    const entityById = new Map((payload.semanticEntities || []).map((entity) => [entity.stableId, entity]));
    for (const relationship of composition) {
      const part = entityById.get(relationship.toId);
      assert.ok(part?.labels.includes('CodeEntity'));
      assert.ok(part?.labels.includes('SyntaxPart'));
      assert.ok(part?.props.sourceBacked);
      assert.doesNotMatch(part?.stableId || '', /:render-part:/);
    }
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
