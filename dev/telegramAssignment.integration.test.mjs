import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import projectPaths from './projectPaths.cjs';
import { extractFunctionFlowGraphs } from '../graph/static-extract/ts/fromASTtoPreGraphFlow.ts';
import { getStableId } from '../graph/static-extract/ts/functionFlowGraph.infrastructure.ts';

test('Telegram callback object assignment uses its contextual container ID', () => {
  const file = path.join(projectPaths.sourceRoot, 'src/util/debugOverlay.ts');
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    skipLibCheck: true,
  });
  const source = program.getSourceFile(file);
  assert.ok(source, 'Run against the real Telegram source repository');
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setupOverlay');
  assert.ok(fn);
  const graph = extractFunctionFlowGraphs(program, getStableId(source, fn));
  const assignments = graph.nodes.filter(node => node.operationSubjectText === 'counters' && node.labels.includes('ValueWrite'));
  assert.equal(assignments.length, 1);
  const id = typeof assignments[0].stableId === 'string' ? assignments[0].stableId : assignments[0].stableId.value;
  assert.match(id, /horizontal-owner/);
  assert.ok(graph.edges.some(edge => edge.fromId === id || edge.toId === id), 'Assignment must be connected');
});
