import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';

test('branches use orthogonal Flow and Data domain labels', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-branch-domains.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(index: number, fallback: string) {
  const selected = index === -1 ? 'first' : fallback;
  if (selected.length > 0) return selected;
  return fallback;
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
    const dataBranch = payload.nodes.find((node) => (
      node.labels?.includes('Branch')
      && node.conditionRaw === 'index === -1'
    ));
    const flowBranch = payload.nodes.find((node) => (
      node.labels?.includes('Branch')
      && node.conditionRaw === 'selected.length > 0'
    ));

    assert.ok(dataBranch, 'conditional-expression branch was not extracted');
    assert.ok(dataBranch.labels.includes('Data'));
    assert.ok(dataBranch.labels.includes('Operand'));
    assert.ok(!dataBranch.labels.includes('Flow'));

    const literalAlternative = payload.nodes.find((node) => node.actionTextRaw === "'first'");
    assert.ok(literalAlternative, 'literal data alternative was not extracted');
    assert.ok(literalAlternative.labels.includes('Literal'));
    assert.ok(literalAlternative.labels.includes('Value'));
    assert.ok(!literalAlternative.labels.includes('Action'));

    assert.ok(flowBranch, 'if branch was not extracted');
    assert.ok(flowBranch.labels.includes('Flow'));
    assert.ok(!flowBranch.labels.includes('Data'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
