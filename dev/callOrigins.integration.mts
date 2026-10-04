import assert from 'node:assert/strict';
import ts from 'typescript';
import { classifyCallOrigin } from '../graph/static-extract/ts/functionFlowGraph.callOrigins.ts';
import { createProgram, isTrackedSourceFile } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

const program = createProgram();
const checker = program.getTypeChecker();
const counts: Record<string, number> = {};
let outsideScopeProjectCalls = 0;
for (const source of program.getSourceFiles()) {
  if (!isTrackedSourceFile(source)) continue;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const origin = classifyCallOrigin(checker, node);
      counts[origin.kind] = (counts[origin.kind] || 0) + 1;
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (origin.kind === 'unknown') {
        assert.ok(!declaration || origin.declarationPath?.startsWith('../'));
      } else {
        assert.ok(declaration && origin.declarationStableId && origin.declarationPath);
      }
      if (origin.kind === 'project' && declaration && !isTrackedSourceFile(declaration.getSourceFile())) {
        outsideScopeProjectCalls++;
      }
      if (node.expression.getText(source) === 'formatCurrency') {
        assert.equal(origin.kind, 'project');
        assert.equal(origin.declarationPath, 'src/util/formatCurrency.tsx');
      }
      if (origin.kind === 'framework') assert.ok(origin.packageName);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.ok(outsideScopeProjectCalls > 0);
console.log(JSON.stringify({ ok: true, counts, outsideScopeProjectCalls, writesGraph: false }));
