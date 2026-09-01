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

test('local function declaration owns its body and void invocation is an ordinary call mosaic', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-local-function.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject() {
  const executeImmediateCommand = async (): Promise<void> => {
    let doneWasCalled = false;
    console.log('run');
  };
  void executeImmediateCommand();
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
    const subject = payload.functions.find((fn) => fn.name === 'subject');
    assert.ok(subject);
    const subjectStableId = stableIdOf(subject.stableId);
    const nodes = payload.nodes.filter((node) => node.parentFnStableId.value === subjectStableId);

    const declaration = nodes.find((node) => node.labels.includes('FnDeclaration'));
    assert.ok(declaration);
    assert.equal(declaration.annotationKind, 'Callable');
    const declarationStableId = stableIdOf(declaration.stableId);
    const localFunctionStableId = stableIdOf(declaration.calleeStableId);
    assert.ok(localFunctionStableId);
    assert.ok(payload.functions.some((fn) => stableIdOf(fn.stableId) === localFunctionStableId));
    const declarationParts = JSON.parse(String(declaration.renderPartsJson || '[]'));
    assert.deepEqual(
      declarationParts.map((part: { text: string }) => part.text),
      ['executeImmediateCommand', 'declares'],
    );
    assert.equal(declarationParts[0].kind, 'function-container');
    assert.ok(declarationParts[1].labels.includes('Virtual'));
    assert.ok(!nodes.some((node) => node.labels.includes('LocalFunctionProxy')));
    const booleanContainer = nodes.find((node) => node.operationSubjectText === 'doneWasCalled');
    assert.ok(booleanContainer);
    assert.equal(booleanContainer.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(
      JSON.parse(String(booleanContainer.renderPartsJson || '[]')).map((part: { text: string }) => part.text),
      ['doneWasCalled', 'set(', 'false', ')'],
    );
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === declarationStableId
      && edge.type === 'DECLARES_FUNCTION'
      && edge.toId !== declarationStableId
    )));

    const invocation = nodes.find((node) => node.labels.includes('FireAndForget'));
    assert.ok(invocation);
    assert.ok(invocation.labels.includes('Call'));
    assert.ok(!invocation.labels.includes('DetachedAsyncCall'));
    assert.deepEqual(
      JSON.parse(String(invocation.renderPartsJson || '[]')).map((part: { text: string }) => part.text),
      ['void', 'executeImmediateCommand()'],
    );
    assert.ok(!payload.edges.some((edge) => edge.type === 'DETACHES_ASYNC'));
    const functionStart = nodes.find((node) => (
      node.labels.length === 1
      && node.labels[0] === 'FunctionStart'
      && node.parentLocalFunctionStableId === declarationStableId
    ));
    assert.ok(functionStart);
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === declarationStableId
      && edge.toId === stableIdOf(functionStart.stableId)
      && edge.type === 'DECLARES_FUNCTION'
    )));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
