import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';

function stableIdOf(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return '';
}

test('horizontal call arguments retain semantics without repeating variable names visually', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-argument-frame.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function expandPastedTextRefs(input: string, pastedContents: Record<string, unknown>): string;

export function subject(input: string, pastedContents: Record<string, unknown>) {
  return expandPastedTextRefs(input, pastedContents).trim();
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
    const opening = payload.nodes.find((node) => (
      String(node.actionTextRaw || '').startsWith('expandPastedTextRefs(')
      && node.callBoundaryRole === 'open'
    ));
    assert.ok(opening, 'call opening was not extracted');

    const closure = payload.nodes.find((node) => (
      node.callBoundaryRole === 'close'
      && node.sourceCallStableId === stableIdOf(opening.stableId)
    ));
    assert.ok(closure, 'call closure was not extracted');
    assert.equal(closure.diaName, ')');

    const argumentEdges = payload.edges.filter((edge) => (
      (edge.type === 'ARG' && edge.fromId === stableIdOf(opening.stableId))
      || (edge.type === 'ArgJoin' && edge.toId === stableIdOf(closure.stableId))
    ));
    assert.equal(argumentEdges.length, 4);
    assert.ok(argumentEdges.every((edge) => edge.layoutFrame === 'horizontal'));
    assert.deepEqual(
      [...new Set(argumentEdges.map((edge) => edge.argumentName))].sort(),
      ['input', 'pastedContents'],
    );
    assert.ok(argumentEdges.every((edge) => edge.displayLabel === ''));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('argument labels do not repeat the terminal field of a passed member expression', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-member-argument-frame.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type SpeculationAccept = { setAppState: (value: unknown) => void };
declare function accept(input: string, setAppState: (value: unknown) => void): void;

export function subject(input: string, speculationAccept: SpeculationAccept) {
  accept(input, speculationAccept.setAppState);
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
    const memberArgument = payload.edges.find((edge) => (
      edge.type === 'ARG'
      && edge.argumentName === 'setAppState'
    ));
    assert.ok(memberArgument, 'member-expression argument was not extracted');
    assert.equal(memberArgument.displayLabel, '');
    assert.equal(memberArgument.argumentName, 'setAppState');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
