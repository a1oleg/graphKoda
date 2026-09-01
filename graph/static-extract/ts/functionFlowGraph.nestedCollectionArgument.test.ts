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

test('a chained collection stage consumes the materialized result of the previous stage', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-chained-collection.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(input: string) {
  const values = input
    .split(/\\r?\\n/)
    .map(value => value.trim())
    .filter(value => value.length > 0);
  return values;
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
    const map = payload.nodes.find((node) => (
      node.collectionMethod === 'map' && node.diaName === 'map' && node.labels?.includes('SubStep')
    ));
    const filter = payload.nodes.find((node) => (
      node.collectionMethod === 'filter' && node.diaName === 'filter' && node.labels?.includes('SubStep')
    ));
    assert.ok(map, 'map protocol was not extracted');
    assert.ok(filter, 'filter protocol was not extracted');
    const previousStageStableId = String(filter.collectionPreviousStageStableId || '');
    assert.ok(previousStageStableId, 'filter does not identify the result consumed from map');
    assert.ok(
      payload.nodes.some((node) => stableIdOf(node.stableId) === previousStageStableId),
      `filter source was not materialized: ${previousStageStableId}`,
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a collection transform used as one call argument is extracted as its protocol, not as a text argument', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-nested-collection-argument.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Message = { content: string; isMeta: boolean };
declare function createUserMessage(value: Message): Message;

export function subject(newMessages: Message[], doneOptions: { metaMessages: string[] }) {
  newMessages.push(...doneOptions.metaMessages.map(content => createUserMessage({
    content,
    isMeta: true,
  })));
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

    assert.equal(
      payload.nodes.some((node) => String(node.diaName || '').includes('metaMessages.map(content')),
      false,
      'the complete map expression must not survive as an argument tile',
    );

    const map = payload.nodes.find((node) => node.collectionMethod === 'map' && node.diaName === 'map');
    assert.ok(map, 'map protocol header was not extracted');
    assert.ok(map.labels?.includes('SubStep'));
    const mapStableId = stableIdOf(map.stableId);
    const outerCall = payload.nodes.find((node) => (
      node.diaName === 'newMessages.\npush('
      || String(node.actionTextRaw || '').startsWith('newMessages.push(')
    ));
    assert.ok(outerCall, 'outer push call was not extracted');
    const incomingMapEdges = payload.edges.filter((edge) => (
      edge.fromId === stableIdOf(outerCall.stableId)
      && edge.toId === mapStableId
    ));
    assert.deepEqual(
      incomingMapEdges.map((edge) => edge.type),
      ['EVAL'],
      'the enclosing call must enter the collection computation once',
    );

    const source = payload.nodes.find((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>;
      return node.labels?.includes('Collection')
        && node.actionTextRaw === 'doneOptions.metaMessages'
        && parts[1]?.text === 'shift';
    });
    assert.ok(source, 'spread source collection was not extracted');
    assert.deepEqual(
      (JSON.parse(source.renderPartsJson || '[]') as Array<{ text?: string }>).map((part) => part.text),
      ['...doneOptions.metaMessages', 'shift'],
    );

    const content = payload.nodes.find((node) => (
      node.diaName === 'content'
      && node.labels?.includes('Iteration')
      && node.labels?.includes('Set')
    ));
    assert.ok(content, 'callback parameter container was not extracted');
    const submethods = JSON.parse(map.submethodsJson || '[]') as Array<{
      headerStableId?: string;
      memberStableIds?: string[];
      attachments?: Array<{ stableId?: string }>;
    }>;
    assert.equal(submethods.length, 1, 'the collection protocol must publish one renderable submethod');
    assert.equal(submethods[0]?.headerStableId, mapStableId);
    assert.ok(
      submethods[0]?.memberStableIds?.includes(stableIdOf(content.stableId)),
      'the callback parameter must be on the extracted submethod axis',
    );
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === mapStableId
      && edge.toId === stableIdOf(content.stableId)
      && edge.type === 'NEXT'
    )), 'map axis must continue to its callback parameter container');
    assert.equal(
      payload.nodes.some((node) => node.labels?.includes('CallbackFn') && node.diaName === 'content =>'),
      false,
      'the callback parameter must not be duplicated as an arrow-function tile',
    );

    assert.equal(payload.nodes.some((node) => node.labels?.includes('IterationGuard')), false);

    const result = payload.nodes.find((node) => (
      node.diaName === 'result'
      && node.labels?.includes('CallbackResult')
      && node.labels?.includes('Collection')
    ));
    assert.ok(result, 'map result collection was not extracted');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'ArgJoin'
      && edge.fromId === stableIdOf(result.stableId)
    )), 'the map result must feed the enclosing call argument');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === stableIdOf(content.stableId)
    )), 'the callback parameter set must continue directly into the next callback substep');
    assert.equal(
      payload.edges.some((edge) => (
        edge.type === 'PRODUCES_VALUE'
        && edge.toId === stableIdOf(result.stableId)
      )),
      false,
      'map must not produce a second value when its callback result is consumed by result.push',
    );
    assert.equal(
      payload.edges.some((edge) => (
        edge.type === 'EMITS_VALUE'
        && edge.toId === stableIdOf(result.stableId)
      )),
      false,
      'the callback call is already the argument of result.push and must not emit into it again',
    );

    const createMessage = payload.nodes.find((node) => (
      node.diaName === 'createUserMessage('
      && node.memberOfSubmethodStableId === mapStableId
    ));
    assert.ok(createMessage, 'callback call was not extracted');
    assert.equal(
      payload.nodes.some((node) => (
        node.sourceCallStableId === stableIdOf(createMessage.stableId)
        && node.labels?.includes('Result')
      )),
      false,
      'a callback call consumed by result.push must not materialize a separate result node',
    );
    assert.equal(result.callMosaicRole, 'open');
    assert.equal(createMessage.callMosaicRole, 'argument');
    assert.equal(createMessage.callMosaicOwnerStableId, stableIdOf(result.stableId));
    const resultClose = payload.nodes.find((node) => (
      node.callMosaicOwnerStableId === stableIdOf(result.stableId)
      && node.callMosaicRole === 'close'
    ));
    assert.ok(resultClose, 'result.push closing boundary was not extracted');
    assert.ok(resultClose.labels?.includes('CallBoundary'));
    assert.equal(resultClose.labels?.includes('FnVisualProxy'), false);
    assert.equal(
      payload.nodes.some((node) => (
        node.sourceCallStableId === mapStableId
        && node.labels?.includes('FnVisualProxy')
      )),
      false,
      'compact map must not create a second visual proxy for its method header',
    );
    assert.ok(
      submethods[0]?.attachments?.some((attachment) => attachment.stableId === stableIdOf(createMessage.stableId)),
      'the callback body must be an extracted attachment of the collection submethod',
    );
    assert.equal(
      payload.nodes.some((node) => String(node.stableId).includes(':execution:binding:')),
      false,
      'the called function implementation must not be expanded inside the callback',
    );
    assert.ok(payload.edges.some((edge) => edge.type === 'FIELD' && edge.argumentName === undefined));
    assert.equal(
      payload.nodes.some((node) => node.diaName === 'complete'),
      false,
      'compact collection protocols must not create a technical completion node',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
