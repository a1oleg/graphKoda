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

test('canonical operations are owned by their immediate Step instead of the function', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-step-operation.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: { ready: boolean }): void;
export function subject(ready: boolean) {
  const value = { ready };
  consume(value);
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
    const nodeById = new Map(payload.nodes.map((node) => [stableIdOf(node.stableId), node]));
    const entityById = new Map((payload.semanticEntities || []).map((entity) => [entity.stableId, entity]));
    const ownership = (payload.semanticRelationships || []).filter((relationship) => (
      relationship.type === 'HAS_OPERATION'
    ));
    assert.ok(ownership.length > 0, 'Step operation ownership was not extracted');
    for (const relationship of ownership) {
      assert.ok(nodeById.get(relationship.fromId)?.labels.includes('Step'), `owner is not a Step: ${relationship.fromId}`);
      assert.ok(entityById.get(relationship.toId)?.labels.includes('Operation'), `target is not an Operation: ${relationship.toId}`);
      assert.equal(relationship.props?.ownership, 'immediate-step');
    }
    const functionIds = new Set(payload.functions.map((fn) => stableIdOf(fn.stableId)));
    assert.equal(
      ownership.some((relationship) => functionIds.has(relationship.fromId)),
      false,
      'function-to-operation ownership bypasses the immediate Step',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('nested boolean conditions expand collection callbacks and preserve negation', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-deep-condition.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Item = { name: string; aliases?: string[]; type: string };
function canonicalName(item: Item) { return item.name; }
function isEnabled(item: Item) { return Boolean(item); }
export function subject(
  remote: { enabled: boolean },
  isCommand: boolean,
  items: Item[],
  input: string,
) {
  if (remote.enabled && !(isCommand && items.find(item => {
    const name = input.trim().slice(1).split(/\\s/)[0];
    return isEnabled(item) && (
      item.name === name
      || item.aliases?.includes(name!)
      || canonicalName(item) === name
    );
  })?.type === 'local')) {
    return true;
  }
  return false;
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
    const conditionStep = payload.nodes.find((node) => (
      node.labels?.includes('Step') && node.flowStepKind === 'condition'
    ));
    assert.ok(conditionStep, 'condition Step was not extracted');
    const conditionStepStableId = stableIdOf(conditionStep.stableId);
    const nodes = payload.nodes.filter((node) => node.parentStepStableId === conditionStepStableId);
    const nodeIds = new Set(nodes.map((node) => stableIdOf(node.stableId)));
    const edges = payload.edges.filter((edge) => nodeIds.has(edge.fromId) || nodeIds.has(edge.toId));

    const outerCondition = nodes.find((node) => node.conditionRaw === 'remote.enabled');
    assert.ok(outerCondition, 'outer condition was not extracted');
    assert.deepEqual(conditionStep.headStableIds, [stableIdOf(outerCondition.stableId)]);

    assert.equal(
      nodes.some((node) => (
        node.operationCode === 'logical-not'
        || node.labels?.includes('PredicateGroup')
        || node.labels?.includes('ShortCircuitOperator')
      )),
      false,
      'negated compound predicates must not retain wrapper/operator nodes beside their extracted combinations',
    );
    assert.equal(
      nodes.some((node) => (
        node.labels?.includes('PredicateVariantJoin')
        || node.labels?.includes('LogicalOutcomeJoin')
        || node.labels?.includes('DeMorganVariantJoin')
        || node.labels?.includes('ValueOutcome')
      )),
      false,
      'logical negation must swap the extracted short-circuit exits without synthetic outcomes or joins',
    );
    const loop = nodes.find((node) => node.collectionMethod === 'find' && node.labels?.includes('SubStep'));
    const pull = nodes.find((node) => node.collectionMethod === 'find' && node.labels?.includes('Pull'));
    const item = nodes.find((node) => node.collectionMethod === 'find' && node.labels?.includes('Element'));
    const candidate = item;
    assert.ok(loop && pull && item, 'find execution stages were not extracted');
    const isCommand = nodes.find((node) => node.conditionRaw === 'isCommand');
    assert.ok(isCommand, 'the short-circuit guard before find was not extracted');
    assert.equal(loop.flowLaneRole, 'optional',
      'the collection prefix must retain the optional lane of the predicate it evaluates');
    assert.ok(edges.some((edge) => (
      edge.fromId === stableIdOf(outerCondition.stableId)
      && edge.toId === stableIdOf(isCommand.stableId)
      && edge.type === 'TRUE'
    )), 'the right operand of the outer && must run only after its left operand succeeds');
    assert.ok(edges.some((edge) => (
      edge.fromId === stableIdOf(isCommand.stableId)
      && edge.toId === stableIdOf(loop.stableId)
      && edge.type === 'TRUE'
    )), 'find must run only for a slash command');
    assert.equal(loop.substepColumnOffset, 1,
      'a collection SubStep inside an optional flow must occupy its next sub-column');
    assert.equal(loop.substepRowOffset, 0.5,
      'a direct collection SubStep must use a compact half-row descent');
    assert.equal(edges.some((edge) => (
      edge.type === 'PASSES_VALUE'
      && edge.fromId === stableIdOf(item.stableId)
      && edge.toId === stableIdOf(loop.stableId)
    )), false, 'the callback item must not be passed back into the collection-method header');
    assert.equal(edges.some((edge) => edge.type === 'ON_RECEIVER'), false,
      'receiver composition must be encoded by its extracted nodes, not a technical relation');
    assert.ok(loop.labels?.includes('Method'), 'the collection iterator header must retain its method semantics');
    assert.ok(edges.some((edge) => edge.type === 'YIELDS_VALUE'
      && edge.fromId === stableIdOf(pull.stableId)
      && edge.toId === stableIdOf(candidate.stableId)
      && edge.label === 'value'
      && edge.protocolRole === 'iteration-pass'));
    assert.equal(nodes.some((node) => (
      node.collectionMethod === 'find' && node.labels?.includes('CandidateValue')
    )), false, 'the arrow variable must not be preceded by a technical candidate node');
    assert.equal(edges.some((edge) => (
      edge.type === 'ITEM_AVAILABLE' || edge.type === 'EXTRACTS_VALUE'
    )), false, 'the arrow variable is initialized directly by pop');
    assert.equal(edges.some((edge) => (
      edge.type === 'EXHAUSTED' && edge.fromId === stableIdOf(pull.stableId)
    )), false, 'find must not generate an undefined completion edge');
    assert.ok(pull.labels?.includes('Method'));
    assert.equal(pull.labels?.includes('BooleanFlag'), false, 'pop yields a value; it is not the exhaustion predicate');
    assert.equal(
      nodes.some((node) => node.collectionMethod === 'find' && node.labels?.includes('Exhausted')),
      false,
      'find must not generate an x/undefined terminal marker',
    );
    assert.equal(nodes.some((node) => (
      node.collectionMethod === 'find' && node.labels?.includes('CallbackParams')
    )), false, 'the decomposed callback expression must not survive beside its extracted axis');
    const callbackResultNodes = nodes.filter((node) => (
      node.collectionMethod === 'find'
      && node.labels?.includes('CallbackResult')
      && (
        stableIdOf(node.stableId).endsWith(':callback-result')
        || node.diaName === 'result'
        || node.diaName === 'x'
      )
    ));
    assert.equal(callbackResultNodes.length, 0, `a block-bodied find predicate must return through its predicate exits without a callback result node: ${JSON.stringify(
      callbackResultNodes.map((node) => ({ stableId: stableIdOf(node.stableId), diaName: node.diaName, labels: node.labels })),
    )}`);
    assert.ok(nodes.some((node) => node.collectionMethod === 'find' && node.labels?.includes('Element') && node.diaName === 'item'));
    assert.ok(nodes.some((node) => (
      node.labels?.includes('Set')
      && (JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>).some((part) => part.text === 'set')
    )));
    assert.ok(nodes.some((node) => node.labels?.includes('PredicateCall') && String(node.diaName).startsWith('isEnabled(')));
    assert.ok(nodes.some((node) => node.labels?.includes('PredicateCall') && String(node.diaName).includes('includes(')));
    const renderParts = nodes.map((node) => ({
      node,
      parts: JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>,
    }));
    assert.equal(
      renderParts.some(({ parts }) => (
        parts.length > 1 && parts.some((part) => part.text === '&&' || part.text === '||')
      )),
      false,
      'a render-part structure must not cross an && or || control-flow boundary',
    );
    assert.ok(renderParts.some(({ parts }) => parts.some((part) => part.text.startsWith('canonicalName('))));
    const methodChain = renderParts.find(({ parts }) => (
      parts.map((part) => part.text).join('|') === 'input|trim()|slice(|1|)|split(|/\\s/|)|[|0|]'
    ));
    assert.ok(methodChain, 'the chained initializer must be represented by one graph node');
    assert.deepEqual(
      methodChain?.parts.map((part) => part.text),
      ['input', 'trim()', 'slice(', '1', ')', 'split(', '/\\s/', ')', '[', '0', ']'],
      'the graph node must retain the ordered AST-derived render structure',
    );
    const systemMethodParts = methodChain?.parts.filter((part) => (
      part.text === 'trim()' || part.text === 'slice(' || part.text === 'split('
    )) as Array<{ labels?: string[] }> | undefined;
    assert.equal(systemMethodParts?.length, 3);
    assert.ok(systemMethodParts?.every((part) => part.labels?.includes('System')),
      'built-in method tiles must retain their system origin inside a mixed expression mosaic');
    const redundantMethodChainNodes = nodes.filter((node) => [
      'input.trim()',
      'input.trim().slice(1)',
      'input.trim().slice(1).split(/\\s/)',
    ].includes(String(node.actionTextRaw || '')));
    assert.equal(redundantMethodChainNodes.length, 0,
      `a flat horizontal mosaic must not also generate nodes for its intermediate calls: ${JSON.stringify(
        redundantMethodChainNodes.map((node) => ({ labels: node.labels, action: node.actionTextRaw, stableId: stableIdOf(node.stableId) })),
      )}`);
    const nameAssignment = nodes.find((node) => (
      node.diaName === 'name'
      && node.labels?.includes('Set')
      && node.labels?.includes('Assignment')
    ));
    assert.ok(nameAssignment, 'the callback-local name assignment was not extracted');
    assert.equal(nodes.some((node) => node.labels?.includes('ExpressionMosaic')), false);

    const protocolRoles = new Map<string, string>();
    for (const node of nodes.filter((candidate) => (
      candidate.executionProtocolStableId === stableIdOf(loop.stableId)
    ))) {
      for (const role of node.executionRoles || []) {
        protocolRoles.set(String(role), stableIdOf(node.stableId));
      }
    }
    assert.ok(protocolRoles.has('result'), 'find result was not registered in the extracted protocol');
    assert.equal(
      protocolRoles.get('result'),
      protocolRoles.get('item'),
      'find must expose the selected callback item as data instead of creating a synthetic result value',
    );
    assert.equal(protocolRoles.has('complete'), false, 'find must not expose a synthetic completion stage');
    assert.equal(
      nodes.some((node) => stableIdOf(node.stableId) === `${stableIdOf(loop.stableId).replace(/:collection-loop$/u, '')}:result`),
      false,
      'find must not materialize a separate synthetic result node',
    );
    assert.equal(
      nodes.some((node) => node.labels?.includes('Complete') && node.collectionMethod === 'find'),
      false,
      'find must not retain a hidden synthetic complete node',
    );
    assert.deepEqual(
      [...protocolRoles.keys()].filter((role) => /^predicate\d+$/.test(role)),
      ['predicate1', 'predicate2', 'predicate3', 'predicate4'],
      'the callback predicate graph was collapsed or incompletely registered',
    );
    assert.equal(nodes.some((node) => node.labels?.includes('ExecutionJunction')), false);
    assert.equal(edges.some((edge) => edge.type === 'HAS_STAGE'), false);
    const selectedValuePredicate = nodes.find((node) => (
      node.labels?.includes('PredicateOperator')
      && (() => {
        const texts = (JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text);
        return texts.includes('item?') && texts.includes('.type');
      })()
    ));
    assert.ok(selectedValuePredicate, 'the selected collection value predicate was not extracted');
    assert.equal(loop.flowLaneStableId, selectedValuePredicate?.flowLaneStableId,
      'a collection prefix and its resulting predicate must belong to the same extracted flow lane');
    assert.equal(
      selectedValuePredicate?.labels.includes('Collection'),
      false,
      'a field of the selected item is a predicate mosaic tile, not a collection backing',
    );
    assert.equal(
      selectedValuePredicate?.renderPartsLayout,
      'horizontal',
      'the selected item field comparison must remain one horizontal predicate mosaic',
    );
    const aliasesPredicate = nodes.find((node) => (
      node.labels?.includes('PredicateCall')
      && (() => {
        const texts = (JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text);
        return texts.includes('item.aliases') && texts.includes('includes(');
      })()
    ));
    assert.ok(aliasesPredicate, 'the aliases predicate mosaic was not extracted');
    const aliasesParts = JSON.parse(aliasesPredicate.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      labels?: string[];
    }>;
    assert.deepEqual(
      aliasesParts.map((part) => part.text),
      ['item.aliases', 'includes(', 'name', ')'],
      'a collection-valued field must remain one backing instead of leaking its field into the method mosaic',
    );
    assert.equal(aliasesParts[0].kind, 'collection-container');
    assert.ok(aliasesParts[0].labels?.includes('Collection'));
    assert.equal(aliasesParts.some((part) => part.labels?.includes('FieldAccess')), false);
    assert.equal(aliasesPredicate.renderPartsLayout, 'container-overlay-side');
    assert.equal(
      nodes.some((node) => (
        node.sourceCallStableId === stableIdOf(aliasesPredicate.stableId)
        && node.labels?.includes('Receiver')
      )),
      false,
      'a receiver embedded in a predicate mosaic must not also become an orphan graph node',
    );
    const submethods = JSON.parse(String(loop.submethodsJson || '[]'));
    assert.equal(submethods[0]?.kind, 'collection-method');
    assert.deepEqual(
      submethods[0]?.memberStableIds,
      [
        stableIdOf(item.stableId),
        stableIdOf(nameAssignment.stableId),
        ...['predicate1', 'predicate2', 'predicate3', 'predicate4'].map((role) => protocolRoles.get(role)),
        stableIdOf(selectedValuePredicate?.stableId),
      ],
      'the find SubStep must contain its item binding, callback, and selected-value predicate',
    );
    assert.equal(loop.submethodRelativeColumn, 0);
    assert.equal(loop.submethodRelativeRow, 0);
    const expectedSubstepCoordinates = new Map([
      [stableIdOf(item.stableId), [0, 1]],
      [stableIdOf(nameAssignment.stableId), [0, 2]],
      [protocolRoles.get('predicate1'), [0, 3]],
      [protocolRoles.get('predicate2'), [0, 4]],
      [protocolRoles.get('predicate3'), [1, 4]],
      [protocolRoles.get('predicate4'), [2, 4]],
      [stableIdOf(selectedValuePredicate?.stableId), [0, 5]],
    ]);
    expectedSubstepCoordinates.forEach(([column, row], stableId) => {
      const member = nodes.find((node) => stableIdOf(node.stableId) === stableId);
      assert.ok(member, `SubStep member was not extracted: ${stableId}`);
      assert.equal(member?.submethodRelativeColumn, column, `unexpected SubStep column: ${stableId}`);
      assert.equal(member?.submethodRelativeRow, row, `unexpected SubStep row: ${stableId}`);
    });
    const submethodAttachments = submethods[0]?.attachments?.map((attachment: { stableId: string; placement: string }) => [
        attachment.stableId,
        attachment.placement,
      ]);
    assert.ok(submethodAttachments.some(([stableId, placement]: [string, string]) => (
      stableId === protocolRoles.get('source') && placement === 'right'
    )));
    assert.equal(
      new Set(submethodAttachments.map(([stableId]: [string, string]) => stableId)).size,
      submethodAttachments.length,
      'one collection source/shift node must occupy one attachment placement',
    );
    assert.ok(submethodAttachments.some(([stableId, placement]: [string, string]) => (
      stableId === stableIdOf(methodChain?.node.stableId) && placement === 'right'
    )), 'the callback-local initializer must be attached to its assignment inside the find SubStep');
    assert.equal(methodChain?.node.submethodAnchorStableId, stableIdOf(nameAssignment.stableId));
    assert.equal(methodChain?.node.submethodRelativeRow, nameAssignment.submethodRelativeRow);
    submethods[0]?.attachments?.forEach((attachment: { stableId: string }) => {
      const node = nodes.find((candidate) => stableIdOf(candidate.stableId) === attachment.stableId);
      assert.ok(node, `SubStep attachment was not extracted: ${attachment.stableId}`);
      assert.equal(node?.submethodRelativeColumn, 1, `SubStep attachment must stay in column 1: ${attachment.stableId}`);
      assert.ok(Number(node?.submethodRelativeRow) >= 1, `SubStep attachment row must be extractor-defined: ${attachment.stableId}`);
    });
    assert.ok(edges.some((edge) => (
      edge.type === 'YIELDS_VALUE'
      && edge.fromId === stableIdOf(pull.stableId)
      && edge.toId === stableIdOf(item.stableId)
      && edge.label === 'value'
      && edge.protocolRole === 'iteration-pass'
    )), 'pop must pass the callback item directly into its set method');
    assert.equal(edges.some((edge) => (
      edge.type === 'TRUE' && edge.toId === protocolRoles.get('result')
    )), false, 'control outcomes must not enter the selected item or its set method');
    const terminalFalseEdges = edges.filter((edge) => (
      edge.type === 'FALSE' && edge.toId === stableIdOf(pull.stableId)
    ));
    assert.equal(terminalFalseEdges.length, 2, `every terminal rejected path must request the next collection item: ${JSON.stringify(
      edges.filter((edge) => edge.type === 'FALSE').map((edge) => ({ from: edge.fromId, to: edge.toId, label: edge.label })),
    )}`);

    const selectedProperties = nodes.filter((node) => (
      node.labels?.includes('PredicateOperator')
      && (() => {
        const texts = (JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text);
        return texts.includes('item?') && texts.includes('.type');
      })()
    ));
    assert.ok(selectedProperties.length, `the selected collection item property was not retained: ${JSON.stringify(
      nodes.filter((node) => node.labels?.includes('PredicateOperator')).map((node) => JSON.parse(node.renderPartsJson || '[]')),
    )}`);
    const selectedPropertyIds = new Set(selectedProperties.map((node) => stableIdOf(node.stableId)));
    assert.equal(edges.filter((edge) => (
      edge.type === 'TRUE' && selectedPropertyIds.has(edge.toId)
    )).length, 3, 'every successful callback path must continue directly into the outer predicate');
    assert.equal(edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === stableIdOf(loop.stableId)
      && selectedPropertyIds.has(edge.toId)
    )), false, 'the collection header must not bypass its callback and continue directly to the selected-item predicate');
    const consequentReturn = payload.nodes.find((node) => (
      node.labels?.includes('Return') && String(node.actionTextRaw || '').includes('return true')
    ));
    assert.ok(consequentReturn, 'the condition consequent was not extracted');
    const trueOutcomeJoin = nodes.find((node) => node.mergeLabel === 'condition-true-merge');
    assert.ok(trueOutcomeJoin,
      'matching short-circuit outcomes must converge before entering the consequent');
    assert.equal(trueOutcomeJoin.flowLaneRole, 'optional');
    assert.ok(Number(trueOutcomeJoin.flowLaneDepth) > 0);
    const trueOutcomeJoinId = stableIdOf(trueOutcomeJoin.stableId);
    assert.ok(edges.some((edge) => (
      edge.fromId === stableIdOf(isCommand.stableId)
      && edge.toId === trueOutcomeJoinId
      && edge.type === 'FALSE'
    )), 'the short-circuited false guard must enter the consequent convergence');
    assert.ok(selectedProperties.some((predicate) => edges.some((edge) => (
      edge.fromId === stableIdOf(predicate.stableId)
      && edge.toId === trueOutcomeJoinId
      && edge.type === 'FALSE'
    ))), 'a non-local selected command must enter the consequent convergence through the final comparison FALSE exit');
    assert.ok(edges.some((edge) => (
      edge.fromId === trueOutcomeJoinId
      && edge.toId === stableIdOf(consequentReturn.stableId)
      && edge.type === 'NEXT'
    )), 'the condition convergence must enter the consequent through one NEXT edge');
    assert.equal(selectedProperties.some((predicate) => edges.some((edge) => (
      edge.fromId === stableIdOf(predicate.stableId)
      && edge.toId === stableIdOf(consequentReturn.stableId)
      && edge.type === 'TRUE'
    ))), false, 'a local selected command must not enter the consequent');
    assert.equal(edges.some((edge) => (
      edge.type === 'PASSES_VALUE'
      && edge.fromId === stableIdOf(item.stableId)
      && selectedPropertyIds.has(edge.toId)
    )), false, 'the selected item must be part of the predicate mosaic instead of travelling through a synthetic data edge');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('single-argument predicate call is one graph mosaic without call boundaries', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-predicate-call-mosaic.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(input: string) {
  if (input.trim().startsWith('/')) return true;
  return false;
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
    assert.equal(payload.nodes.some((node) => node.renderHidden !== undefined), false);
    assert.equal(payload.edges.some((edge) => edge.renderHidden !== undefined), false);
    const predicate = payload.nodes.find((node) => (
      node.labels?.includes('PredicateCall')
      && node.actionTextRaw === "input.trim().startsWith('/')"
    ));
    assert.ok(predicate, 'predicate call mosaic was not extracted');
    const predicateStableId = stableIdOf(predicate.stableId);
    const parts = JSON.parse(predicate.renderPartsJson || '[]') as Array<{ text: string }>;
    assert.deepEqual(parts.map((part) => part.text), ['input', 'trim()', 'startsWith(', "'/'", ')']);
    assert.equal(predicate.callBoundaryDesign, 'mosaic');
    assert.equal(predicate.callBoundaryRole, undefined);
    assert.equal(predicate.callMosaicRole, undefined);
    assert.equal(
      payload.nodes.filter((node) => node.labels?.includes('ArgumentOccurrence') && node.diaName === "'/'").length,
      0,
      'the literal belongs to the call render parts, not to another graph node',
    );
    assert.equal(payload.edges.some((edge) => (
      (edge.type === 'ARG' || edge.type === 'ArgJoin')
      && (edge.fromId === predicateStableId || edge.toId === predicateStableId)
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('primitive single-argument calls retain literal mosaic tiles', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-primitive-call-mosaic.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function setInputValue(value: string): void;
declare const helpers: { setCursorOffset(value: number): void };
declare const text: { slice(start: number, end: number): string };
export function subject() {
  setInputValue('');
  const offset = 0;
  helpers.setCursorOffset(offset);
  text.slice(1, offset);
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
    const expectedParts = new Map([
      ["setInputValue('')", ['setInputValue(', "''", ')']],
      ['helpers.setCursorOffset(offset)', ['helpers', 'setCursorOffset(', 'offset', ')']],
    ]);

    for (const [actionTextRaw, expected] of expectedParts) {
      const call = payload.nodes.find((node) => node.actionTextRaw === actionTextRaw);
      assert.ok(call, `${actionTextRaw} was not extracted`);
      assert.equal(call.callBoundaryDesign, 'mosaic');
      assert.equal(call.renderPartsLayout, 'horizontal');
      assert.equal(String(call.diaName).includes(actionTextRaw.slice(actionTextRaw.indexOf('(') + 1, -1)), false);
      const parts = JSON.parse(call.renderPartsJson || '[]') as Array<{ text: string }>;
      assert.deepEqual(parts.map((part) => part.text), expected);
    }
    const splitCall = payload.nodes.find((node) => node.actionTextRaw === 'text.slice(1, offset)');
    assert.ok(splitCall);
    assert.equal(splitCall.callBoundaryDesign, 'split');
    assert.deepEqual(
      (JSON.parse(splitCall.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['text', 'slice('],
    );
    const offsetArgument = payload.nodes.find((node) => node.diaName === 'offset' && node.labels?.includes('ArgumentOccurrence'));
    assert.ok(offsetArgument);
    const referenceEdge = payload.semanticRelationships?.find((edge) => (
      edge.fromId === stableIdOf(offsetArgument.stableId)
      && edge.type === 'USES_REFERENCE'
    ));
    assert.ok(referenceEdge);
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(offsetArgument.stableId)
      && (edge.type === 'READS_VALUE' || edge.type === 'PASSES_VALUE')
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('object field binding reads do not create reverse PASSES_VALUE edges to declarations', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-object-field-binding.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: { commandName: string; fixed: boolean }): void;
export function subject(matching: { name: string }) {
  consume({ commandName: matching.name, fixed: true });
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
    const field = payload.nodes.find((node) => (
      node.labels?.includes('Field')
      && node.diaName === 'matching.name'
    ));
    assert.ok(field, `object field value occurrence was not extracted: ${JSON.stringify(
      payload.nodes
        .filter((node) => node.labels?.includes('Field'))
        .map((node) => ({ diaName: node.diaName, actionTextRaw: node.actionTextRaw })),
    )}`);
    const fieldStableId = stableIdOf(field.stableId);
    const referenceEdge = payload.semanticRelationships?.find((edge) => (
      edge.fromId === fieldStableId && edge.type === 'USES_REFERENCE'
    ));
    assert.ok(referenceEdge, 'object field must retain its binding reference');
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === fieldStableId
      && (edge.type === 'READS_VALUE' || edge.type === 'PASSES_VALUE')
    )), false, 'object field must not jump backwards into its declaration');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('shorthand object fields retain binding metadata without declaration-directed READS_VALUE edges', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-shorthand-object-field.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: { type: string; source: object }): void;
export function subject() {
  const source = {};
  consume({ type: 'image', source });
  consume({ type: 'image', source });
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
    const sourceFields = payload.nodes.filter((node) => (
      node.labels?.includes('Field')
      && node.actionTextRaw === 'source'
    ));
    assert.equal(sourceFields.length, 2);
    for (const field of sourceFields) {
      const fieldStableId = stableIdOf(field.stableId);
      assert.equal(field.valueName, 'source');
      assert.ok(field.valueSlotStableId, 'the shorthand field must retain its binding identity');
      assert.equal(payload.edges.some((edge) => (
        edge.fromId === fieldStableId && edge.type === 'READS_VALUE'
      )), false, 'the shorthand field already embodies the binding read');
    }
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('direct assignment values do not create declaration-directed READS_VALUE edges', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-direct-assignment-read.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject() {
  const remoteBlocks: Array<{ type: string }> = [];
  let remoteContent: unknown = '';
  remoteContent = remoteBlocks;
  return remoteContent;
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
    const assignment = payload.nodes.find((node) => (
      String(node.actionTextRaw || '').includes('remoteContent = remoteBlocks')
    ));
    assert.ok(assignment, 'assignment must be extracted');
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(assignment.stableId)
      && edge.type === 'READS_VALUE'
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('direct calls do not classify their callable as captured application data', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-direct-call-value-access.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(callback: () => void): void;
export function subject() {
  const repinScroll = () => {};
  consume(() => {
    repinScroll();
  });
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
    const call = payload.nodes.find((node) => node.actionTextRaw === 'repinScroll()');
    assert.ok(call, 'direct captured-function call was not extracted');
    const callStableId = stableIdOf(call.stableId);

    assert.equal(call.labels?.includes('Call'), true);
    assert.equal(call.labels?.includes('ValueAccess'), false);
    assert.equal(call.labels?.includes('ValueRead'), false);
    assert.equal(call.labels?.includes('ValueCapture'), false);
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === callStableId
      && (edge.type === 'READS_VALUE' || edge.type === 'CAPTURES_VALUE')
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a predicate value produced by one embedded call remains an annotatable call site', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-embedded-predicate-call.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function getConfig(): { disabled: boolean };
export function subject() {
  if (!getConfig().disabled) return true;
  return false;
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
    const predicate = payload.nodes.find((node) => (
      node.conditionRaw === 'getConfig().disabled'
      && node.labels?.includes('Branch')
    ));
    assert.ok(predicate, 'embedded-call predicate was not extracted');
    assert.ok(predicate.labels?.includes('PredicateCall'));
    assert.equal(predicate.annotationKind, 'CallSite');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('destructured result fields do not become captured bindings of return type members', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-destructured-result-capture.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function run(): Promise<{ stdout: string; code: number }>;
export async function subject() {
  const { stdout: output, code } = await run();
  return output || String(code);
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
    const capturedNames = payload.nodes
      .filter((node) => node.labels?.includes('CapturedBinding'))
      .map((node) => node.diaName);
    assert.equal(capturedNames.includes('stdout'), false);
    assert.equal(capturedNames.includes('code'), false);
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'CAPTURES_VALUE'
      && (edge.fromId.includes(':stdout') || edge.fromId.includes(':code'))
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a named function expression does not capture its own declaration name', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-named-expression-capture.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function owner() {
  return async function subject() {
    return subject;
  };
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
    const declarationStableId = payload.functions.find((fn) => fn.name === 'subject')?.stableId;
    assert.ok(declarationStableId, 'named function expression was not extracted');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'CAPTURES_VALUE'
      && edge.fromId.endsWith(':subject')
      && edge.toId.includes(`:captured-in:${declarationStableId}`)
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('captured bindings are not repeated as capture facts on argument occurrences', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-captured-argument.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(prefix: string, value: unknown): void;
const pastedContents = {};
export function subject() {
  consume('value', pastedContents);
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
    const argument = payload.nodes.find((node) => (
      node.labels?.includes('ArgumentOccurrence') && node.diaName === 'pastedContents'
    ));
    assert.ok(argument, 'captured argument occurrence was not extracted');
    const argumentStableId = stableIdOf(argument.stableId);

    assert.equal(argument.labels?.includes('ValueRead'), true);
    assert.equal(argument.labels?.includes('ValuePass'), true);
    assert.equal(argument.labels?.includes('ValueCapture'), false);
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === argumentStableId && edge.type === 'CAPTURES_VALUE'
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('captured bindings materialize as distinct proxies without changing the original declaration', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-captured-proxy.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function source(): string;
declare function consume(value: string): void;
export function subject() {
  const original = source();
  const middle = () => {
    consume(original);
    const inner = () => consume(original);
    inner();
  };
  middle();
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
    const original = payload.nodes.find((node) => (
      node.operationSubjectText === 'original'
      && node.labels?.includes('Assignment')
    ));
    assert.ok(original, 'the original declaration was not extracted');
    const originalStableId = stableIdOf(original.stableId);
    assert.equal(original.labels?.includes('Set'), true);
    assert.equal(original.labels?.includes('CapturedBinding'), false);

    const proxies = payload.nodes.filter((node) => (
      node.diaName === 'original' && node.labels?.includes('CapturedBinding')
    ));
    assert.equal(proxies.length, 2, 'each capturing function must own a distinct proxy');
    assert.equal(
      new Set(payload.nodes.map((node) => stableIdOf(node.stableId))).size,
      payload.nodes.length,
      'graph materializations must not share stable IDs',
    );
    assert.equal(new Set(proxies.map((node) => stableIdOf(node.stableId))).size, proxies.length);
    for (const proxy of proxies) {
      assert.notEqual(stableIdOf(proxy.stableId), originalStableId);
      assert.equal(proxy.originalStableId, originalStableId);
      assert.equal(proxy.canonicalStableId, originalStableId);
      assert.equal(proxy.bindingStableId, originalStableId);
    }

    const proxyStableIds = new Set(proxies.map((node) => stableIdOf(node.stableId)));
    const captureEdges = payload.edges.filter((edge) => (
      edge.type === 'CAPTURES_VALUE' && proxyStableIds.has(edge.toId)
    ));
    assert.equal(captureEdges.length, 2);
    assert.equal(captureEdges.every((edge) => edge.contextOnly === true), true);
    const firstHop = captureEdges.find((edge) => edge.fromId === originalStableId);
    assert.ok(firstHop, 'the capture chain must start at the original declaration');
    assert.equal(
      captureEdges.some((edge) => edge.fromId === firstHop.toId),
      true,
      'the nested capture must continue through the already materialized parent proxy',
    );
    assert.equal(
      payload.edges.some((edge) => edge.type === 'READS_VALUE' && edge.toId === originalStableId),
      false,
      'nested reads must address their local proxy, not the original declaration directly',
    );
    for (const proxy of proxies) {
      assert.equal(
        payload.edges.some((edge) => edge.type === 'READS_VALUE' && edge.toId === stableIdOf(proxy.stableId)),
        false,
      );
    }
    assert.ok(payload.semanticRelationships?.some((edge) => edge.type === 'USES_REFERENCE'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('captured parameters originate at the typed parameter entity rather than its name token', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-captured-parameter.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: string): void;
export function subject(input: string) {
  const nested = () => consume(input);
  nested();
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
    const parameter = payload.nodes.find((node) => (
      node.labels?.includes('Parameter') && node.diaName === 'input'
    ));
    assert.ok(parameter, 'typed parameter entity was not extracted');
    const parameterStableId = stableIdOf(parameter.stableId);
    const capture = payload.edges.find((edge) => (
      edge.type === 'CAPTURES_VALUE' && edge.toId.includes(':captured-in:')
    ));
    assert.ok(capture, 'captured parameter provenance was not extracted');
    assert.equal(capture.fromId, parameterStableId);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('terminal statements own an extracted Step inside their FlowBlock', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-terminal-step.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(): void;
export function subject(enabled: boolean) {
  if (enabled) {
    consume();
    return;
  }
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
    const call = payload.nodes.find((node) => node.actionTextRaw === 'consume()');
    const returnNode = payload.nodes.find((node) => node.labels?.includes('Return'));
    assert.ok(call, 'preceding call was not extracted');
    assert.ok(returnNode, 'return was not extracted');
    assert.ok(returnNode.parentStepStableId, 'return must belong to an extracted Step');
    assert.notEqual(returnNode.parentStepStableId, call.parentStepStableId);
    assert.equal(returnNode.parentFlowBlockStableId, call.parentFlowBlockStableId);
    const flowBlock = payload.nodes.find((node) => (
      node.flowBlockRole === 'side'
      && node.labels?.includes('Block')
    ));
    assert.ok(flowBlock, 'a side flow containing two Steps must retain its own FlowBlock node');
    assert.equal(flowBlock.labels?.includes('Step'), false);
    assert.equal(flowBlock.combinedStepFlowBlock, undefined);
    const returnStep = payload.nodes.find((node) => (
      stableIdOf(node.stableId) === returnNode.parentStepStableId
      && node.labels?.includes('Step')
    ));
    assert.ok(returnStep, 'return Step node was not materialized by extraction');
    assert.deepEqual(returnStep.headStableIds, [stableIdOf(returnNode.stableId)]);
    assert.deepEqual(returnStep.tailStableIds, [stableIdOf(returnNode.stableId)]);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a FlowBlock containing one Step is extracted as one combined graph node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-single-step-block.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(): void;
export function subject(enabled: boolean) {
  if (enabled) {
    consume();
  }
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
    const call = payload.nodes.find((node) => node.actionTextRaw === 'consume()');
    assert.ok(call?.parentStepStableId, 'the side-flow call must belong to a Step');
    const stepStableId = String(call.parentStepStableId);
    const combined = payload.nodes.find((node) => stableIdOf(node.stableId) === stepStableId);
    assert.ok(combined, 'the owning Step was not extracted');
    assert.ok(combined.labels?.includes('Step'));
    assert.equal(combined.labels?.includes('Flow'), false);
    assert.ok(combined.labels?.includes('Block'));
    assert.equal(combined.combinedStepFlowBlock, true);
    assert.equal(call.parentFlowBlockStableId, stepStableId);
    assert.equal(
      payload.nodes.some((node) => stableIdOf(node.stableId).startsWith('flow-block:side:true:')),
      false,
      'a one-Step FlowBlock must not generate a separate graph node',
    );
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'HAS_FLOW_BLOCK'
      && edge.toId === stepStableId
    )), 'the combined node must remain discoverable as a FlowBlock');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a for-of loop is one Step without a materialized exhaustion check', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-for-of-status.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Item = { kind: 'image' | 'text'; content: string };
export function subject(values: Item[]) {
  const local: unknown[] = [];
  const remote: unknown[] = [];
  if (values.length > 0) {
    for (const item of values) {
      if (item.kind === 'image') {
        const source = { data: item.content };
        local.push({ source });
        remote.push({ source });
      } else {
        local.push({ text: item.content });
        remote.push({ text: item.content });
      }
    }
  }
  return local;
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
    const loop = payload.nodes.find((node) => node.labels?.includes('Loop') && node.collectionMethod === 'for-of');
    assert.ok(loop, 'for-of loop was not extracted');
    const loopStableId = stableIdOf(loop.stableId);
    const loopStep = payload.nodes.find((node) => (
      node.labels?.includes('Step')
      && stableIdOf(node.stableId) === `flow-step:loop:${loopStableId}`
    ));
    assert.ok(loopStep, 'the for-of loop Step was not extracted');
    assert.deepEqual(loopStep.headStableIds, [loopStableId], 'the source `for` token must remain the loop Step head');
    assert.equal(loopStep.syntaxEntryStableId, loopStableId, 'the loop syntax entry must be extractor-defined');
    assert.equal(payload.nodes.some((node) => (
      node.collectionMethod === 'for-of' && node.labels?.includes('Status')
    )), false, 'for-of must not materialize an iteration exhaustion check');
    const collection = payload.nodes.find((node) => (
      node.collectionMethod === 'for-of'
      && node.labels?.includes('Collection')
      && node.labels?.includes('Shift')
      && node.diaName === 'shift'
    ));
    assert.ok(collection, 'the source collection and shift method must be one graph node');
    assert.equal(collection.operationSubjectText, 'values');
    assert.deepEqual(
      JSON.parse(collection.renderPartsJson || '[]').map((part: { text?: string }) => part.text),
      ['values', 'shift'],
    );
    const collectionStableId = stableIdOf(collection.stableId);
    const iterator = payload.nodes.find((node) => (
      node.collectionMethod === 'for-of'
      && node.labels?.includes('Iterator')
      && node.diaName === 'item'
    ));
    assert.ok(iterator, 'the awaiting iterator variable was not extracted');
    const iteratorStableId = stableIdOf(iterator.stableId);
    assert.equal(iterator.containerState, 'awaiting-assignment');
    assert.deepEqual(
      JSON.parse(iterator.renderPartsJson || '[]').map((part: { text?: string }) => part.text),
      ['item', 'set'],
    );
    const bodyPredicate = payload.nodes.find((node) => {
      if (!node.labels?.includes('Branch')) return false;
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>;
      return parts.some((part) => part.text === 'item')
        && parts.some((part) => part.text === '.kind')
        && parts.some((part) => part.text === "'image'");
    });
    assert.ok(bodyPredicate, 'the loop body predicate was not extracted');
    assert.ok(
      Number(bodyPredicate.structureRelativeColumn) > Number(iterator.structureRelativeColumn),
      'a branch inside the loop body must start in the next pre-aggregated syntax column',
    );

    assert.equal(payload.nodes.some((node) => (
      stableIdOf(node.stableId).startsWith(`${loopStableId}:iterator:primitive`)
      || stableIdOf(node.stableId).includes(':branch:true:header')
      || stableIdOf(node.stableId).includes(':branch:false:header')
      || stableIdOf(node.stableId).includes(':pull:value')
    )), false, 'for-of must not generate hidden dispatch or exhaustion scaffolding');
    assert.ok(payload.edges.some((edge) => edge.fromId === loopStableId
      && edge.toId === iteratorStableId
      && edge.type === 'NEXT'));
    assert.ok(payload.edges.some((edge) => edge.fromId === iteratorStableId
      && edge.toId === collectionStableId
      && edge.type === 'EVAL'
      && edge.oneWay === true
      && edge.protocolRole === 'collection-shift-eval'));
    assert.ok(payload.edges.some((edge) => edge.fromId === collectionStableId
      && edge.toId === iteratorStableId
      && edge.type === 'YIELDS_VALUE'
      && edge.displayLabel === 'value'
      && edge.protocolRole === 'iteration-pass'));
    assert.ok(payload.edges.some((edge) => edge.fromId === iteratorStableId
      && edge.type === 'NEXT'));
    assert.equal(payload.edges.some((edge) => edge.type === 'EXITS'), false);
    const repeatEdges = payload.edges.filter((edge) => edge.toId === collectionStableId && edge.type === 'REPEATS');
    assert.ok(repeatEdges.length > 0);
    assert.ok(repeatEdges.every((edge) => edge.protocolRole === 'iteration-repeat'));
    assert.ok(repeatEdges.every((edge) => edge.repeatOrigin === 'sequence'));

    for (const callName of ['local.push', 'remote.push']) {
      const calls = payload.nodes.filter((node) => String(node.actionTextRaw || '').startsWith(callName));
      assert.equal(calls.length, 2, `expected both ${callName} calls`);
      for (const call of calls) {
        const step = payload.nodes.find((node) => stableIdOf(node.stableId) === call.parentStepStableId);
        assert.ok(step?.labels?.includes('Step'));
        assert.equal(stableIdOf(step!.stableId), stableIdOf(loopStep.stableId));
      }
    }
    const branchStepIds = new Set(payload.nodes
      .filter((node) => ['local.push', 'remote.push'].some((name) => String(node.actionTextRaw || '').startsWith(name)))
      .map((node) => node.parentStepStableId)
      .filter(Boolean));
    assert.deepEqual(
      [...branchStepIds],
      [stableIdOf(loopStep.stableId)],
      'the loop header, condition, and both branches must belong to one Step',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('signed numeric literals remain one render part inside predicates', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-signed-literal.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(spaceIndex: number) {
  return spaceIndex === -1 ? 'missing' : 'present';
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
    const predicate = payload.nodes.find((node) => {
      if (!node.labels?.includes('PredicateOperator')) return false;
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>;
      return parts.map((part) => part.text).join(' ') === 'spaceIndex === -1';
    });
    assert.ok(predicate, 'signed-number predicate was not extracted');
    const parts = JSON.parse(predicate.renderPartsJson || '[]') as Array<{ text: string; kind: string }>;
    assert.deepEqual(parts.map((part) => part.text), ['spaceIndex', '===', '-1']);
    assert.equal(parts[2]?.kind, 'literal');
    assert.equal(parts.some((part) => part.text === '-'), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('find return value and container set are one extracted container node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-find-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Command = { enabled: boolean };
function isCommandEnabled(command: Command) { return command.enabled; }
export function subject(commands: Command[]) {
  const commandCount = commands.length;
  const matchingCommand = commands.find(cmd => cmd.enabled === true);
  return matchingCommand;
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
    const directAssignment = payload.nodes.find((node) => (
      node.operationSubjectText === 'commandCount' && node.labels?.includes('Set')
    ));
    assert.ok(directAssignment, 'the named computed value must own its virtual set method');
    assert.equal(directAssignment.renderPartsLayout, 'container-overlay');
    assert.deepEqual(
      (JSON.parse(directAssignment.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['commandCount', 'set'],
    );
    const assignment = payload.nodes.find((node) => (
      node.labels?.includes('Set')
      && node.labels?.includes('ValuePass')
      && node.collectionMethod === undefined
    ));
    assert.ok(assignment, 'the declared container must also own its virtual set method');
    const assignmentStableId = stableIdOf(assignment.stableId);
    const parts = JSON.parse(assignment.renderPartsJson || '[]') as Array<{ text: string; kind: string }>;
    assert.equal(assignment.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(parts.map((part) => part.text), ['matchingCommand', 'set(', 'cmd', ')']);
    assert.equal(parts[2]?.kind, 'value', 'the real callback parameter must not be rendered as a virtual value');
    assert.deepEqual(parts.map((part) => part.fillState || ''), ['empty', '', 'filled', '']);
    assert.equal(assignment.containerState, 'awaiting-assignment');
    assert.equal(assignment.operationSubjectText, 'matchingCommand');
    const assignmentStep = payload.nodes.find((node) => (
      node.labels?.includes('Step')
      && node.stableId !== undefined
      && stableIdOf(node.stableId) === assignment.parentStepStableId
    ));
    assert.ok(assignmentStep, 'the find assignment must belong to an extracted Step');
    assert.deepEqual(assignmentStep.headStableIds, [assignmentStableId]);
    const pull = payload.nodes.find((node) => node.labels?.includes('Pull') && node.collectionMethod === 'find');
    const iteration = payload.nodes.find((node) => node.labels?.includes('Iteration') && node.labels?.includes('ContainerMethod'));
    assert.ok(pull && iteration, 'find shift and its virtual iteration variable were not extracted');
    assert.equal(pull.diaName, 'shift');
    assert.equal(pull.operationSubjectText, 'commands');
    assert.equal(pull.labels.includes('Op'), true);
    assert.equal(pull.labels.includes('Shift'), true);
    assert.equal(pull.labels.includes('Read'), false);
    assert.equal(pull.labels.includes('ValueRead'), false);
    assert.equal(pull.operationCode, 'collection-shift');
    assert.equal(pull.valueAction, undefined);
    assert.equal(pull.submethodAnchorStableId, stableIdOf(iteration.stableId));
    assert.equal(pull.submethodRelativeRow, 0, 'commands/shift must align with the waiting matchingCommand container');
    assert.deepEqual(
      (JSON.parse(pull.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['commands', 'shift'],
    );
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'PULLS_VALUE' && edge.toId === stableIdOf(pull.stableId)
    )), false, 'a collection/shift mosaic must not be connected by pull-next scaffolding');
    const findHeader = payload.nodes.find((node) => (
      node.collectionMethod === 'find' && node.primitiveKind === 'iterate'
    ));
    assert.ok(findHeader, 'find header was not extracted');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === stableIdOf(iteration.stableId)
    )), 'the first predicate must follow the iterator variable through NEXT');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'ARROW'
      && edge.fromId === stableIdOf(iteration.stableId)
    )), false, 'direct collection submethods must not invent an arrow edge');
    const submethods = JSON.parse(
      payload.nodes.find((node) => stableIdOf(node.stableId) === stableIdOf(pull.collectionLoopStableId))?.submethodsJson
        || '[]',
    ) as Array<{ parentStableId?: string }>;
    assert.equal(
      submethods[0]?.parentStableId,
      assignmentStableId,
      'find must be extracted as a child submethod of its waiting result container',
    );
    assert.equal(
      (submethods[0] as { memberStableIds?: string[] } | undefined)?.memberStableIds?.includes(assignmentStableId),
      false,
      'the waiting result container must anchor the submethod without becoming one of its members',
    );
    assert.deepEqual(
      (JSON.parse(iteration.renderPartsJson || '[]') as Array<{ text: string; fillState?: string }>),
      [
        {
          stableId: stableIdOf(iteration.stableId),
          text: 'cmd',
          kind: 'value-container',
          labels: ['Iteration', 'Value', 'Element', 'Variable', 'ValueSlot'],
          order: 0,
          fillState: 'empty',
        },
        {
          stableId: stableIdOf(iteration.stableId),
          text: 'set',
          kind: 'method',
          labels: ['Assignment', 'ContainerMethod', 'Method', 'Set'],
          order: 1,
        },
      ],
    );
    assert.equal(iteration.renderPartsLayout, 'container-overlay');
    assert.equal(iteration.containerState, 'awaiting-assignment');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === assignmentStableId
      && edge.toId === String(pull.collectionLoopStableId)
      && edge.oneWay === true
    )), 'the empty matchingCommand container must initiate find with a one-way EVAL');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === stableIdOf(iteration.stableId)
      && edge.toId === stableIdOf(pull.stableId)
      && edge.oneWay === true
    )), 'the empty cmd container must initiate shift with a one-way EVAL');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'YIELDS_VALUE'
      && edge.fromId === stableIdOf(pull.stableId)
      && edge.toId === stableIdOf(iteration.stableId)
      && edge.label === 'value'
      && edge.protocolRole === 'iteration-pass'
      && edge.sourcePort === undefined
      && edge.lockPortCandidates !== true
    )), 'shift value routing must be selected from its semantic role, not fixed by extraction');
    assert.deepEqual(
      payload.edges
        .filter((edge) => edge.fromId === stableIdOf(pull.stableId))
        .map((edge) => edge.type),
      ['YIELDS_VALUE'],
      'shift must only yield its value; exhaustion is checked after cmd.set',
    );
    assert.equal(payload.nodes.some((node) => (
      node.collectionMethod === 'find' && node.labels?.includes('IterationGuard')
    )), false, 'find must not materialize an iteration exhaustion check');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === stableIdOf(iteration.stableId)
    )), 'cmd.set must continue directly into the first predicate substep');
    assert.equal(payload.nodes.some((node) => node.labels?.includes('CollectionExit')), false);
    assert.ok(assignmentStep.tailStableIds.includes(assignmentStableId));
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'TRUE'
      && edge.toId === assignmentStableId
    )), 'the successful iterator path must enter the combined matchingCommand/set node directly');
    assert.ok(payload.edges.filter((edge) => (
      edge.type === 'FALSE'
      && edge.toId === stableIdOf(pull.stableId)
    )).every((edge) => (
      edge.diaName === 'repeat'
      && edge.protocolRole === 'iteration-repeat'
    )), 'iteration returns must retain FALSE semantics while displaying repeat');
    assert.equal(payload.nodes.some((node) => (
      stableIdOf(node.stableId).endsWith(':assign')
    )), false);
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === assignmentStableId
      && edge.toId === assignmentStableId
      && (edge.type === 'TARGETS_VALUE' || edge.type === 'WRITES_VALUE')
    )), false);
    assert.equal(payload.nodes.some((node) => (
      stableIdOf(node.stableId).endsWith(':selected-value')
    )), false);
    assert.equal(payload.nodes.some((node) => (
      stableIdOf(node.stableId).endsWith(':value:undefined')
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('filter and reduce use awaiting result containers and child collection submethods', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-filter-reduce.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Item = { enabled: boolean; id: string };
declare function load(): Item[];
export function subject(contents: Record<string, { content: { length: number } }>) {
  const selected = load().filter(entry => entry.enabled);
  const total = selected.reduce((sum, entry) => sum + (contents[entry.id]?.content.length ?? 0), 0);
  const sink: Item[] = [];
  sink.push(selected[0]);
  return total;
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
    const resultContainer = (name: string) => payload.nodes.find((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>;
      return node.labels.includes('Assignment') && parts[0]?.text === name;
    });
    const selected = resultContainer('selected');
    const total = resultContainer('total');
    assert.ok(selected && total, 'filter/reduce result containers were not extracted');

    const selectedParts = JSON.parse(selected.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      fillState?: string;
    }>;
    const totalParts = JSON.parse(total.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      fillState?: string;
    }>;
    assert.equal(selected.containerState, 'awaiting-assignment');
    assert.equal(total.containerState, 'awaiting-assignment');
    assert.equal(selected.renderPartsLayout, 'container-overlay-side');
    assert.equal(total.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(selectedParts.map((part) => part.text), ['selected', 'push(', 'entry', ')']);
    assert.deepEqual(totalParts.map((part) => part.text), ['total', 'add']);
    assert.equal(selectedParts[0].kind, 'collection-container');
    assert.equal(selectedParts[0].fillState, 'empty');
    assert.equal(selectedParts[2].kind, 'value', 'the callback parameter passed to push is a real variable');
    assert.equal(totalParts[0].fillState, 'empty');

    const filter = payload.nodes.find((node) => (
      node.collectionMethod === 'filter' && node.primitiveKind === 'iterate'
    ));
    const reduce = payload.nodes.find((node) => (
      node.collectionMethod === 'reduce' && node.primitiveKind === 'iterate'
    ));
    assert.ok(filter && reduce, 'filter/reduce method submethods were not extracted');
    assert.equal(reduce.labels.includes('Method'), true);
    assert.equal(reduce.labels.includes('Collection'), false, 'reduce header must render as a method, not a collection');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'READS_VALUE'
      && [stableIdOf(filter.stableId), stableIdOf(reduce.stableId)].includes(edge.fromId)
    )), false, 'collection method receivers must not create declaration-directed READS_VALUE edges');
    const push = payload.nodes.find((node) => (
      node.labels.includes('Collection')
      && node.labels.includes('Method')
      && (JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>)
        .some((part) => part.text === 'push(')
    ));
    assert.ok(push, 'the direct collection push was not extracted');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'READS_VALUE' && edge.fromId === stableIdOf(push.stableId)
    )), false, 'a collection push composite must not read from its own declaration');
    const loadCall = payload.nodes.find((node) => (
      node.actionTextRaw === 'load()'
      && !node.labels.includes('Result')
      && !node.labels.includes('VisualProxy')
    ));
    const filterSource = payload.nodes.find((node) => (
      node.collectionMethod === 'filter'
      && node.labels.includes('Collection')
      && node.labels.includes('Pull')
    ));
    const filterItem = payload.nodes.find((node) => (
      node.memberOfSubmethodStableId === stableIdOf(filter.stableId)
      && node.labels.includes('Iteration')
      && node.labels.includes('Variable')
    ));
    assert.ok(loadCall && filterSource && filterItem, 'load call, result collection, or iteration variable was not extracted');
    assert.equal(
      filter.submethodAnchorStableId,
      stableIdOf(loadCall.stableId),
      'a collection method fed by a call must be anchored below that producer call',
    );
    assert.equal(filter.substepRowOffset, 1);
    assert.equal(
      filterSource.submethodAnchorStableId,
      stableIdOf(filterItem.stableId),
      'the produced virtual collection must sit beside the iteration variable',
    );
    assert.equal(filterSource.submethodRelativeColumn, 1);
    assert.equal(filterSource.submethodRelativeRow, 0);
    const filterSourceParts = JSON.parse(filterSource.renderPartsJson || '[]') as Array<{ text?: string }>;
    assert.equal(filterSourceParts[0]?.text, 'load\nresult');
    assert.equal(payload.edges.filter((edge) => (
      edge.fromId === stableIdOf(loadCall.stableId)
      && edge.toId === stableIdOf(filterSource.stableId)
      && edge.type === 'YIELDS_VALUE'
      && edge.label === 'value'
      && edge.protocolRole === 'collection-source-value'
    )).length, 1, 'a chained call must yield exactly one value edge to its virtual result collection');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(loadCall.stableId)
      && edge.toId === stableIdOf(filter.stableId)
      && edge.type === 'NEXT'
    )), 'the receiver call must continue to filter through NEXT');
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(loadCall.stableId)
      && edge.toId === stableIdOf(filterSource.stableId)
      && (edge.type === 'RESULT' || edge.type === 'PRODUCES_VALUE')
    )), false, 'the chained-call value edge must not be duplicated by generic result edges');
    assert.equal(payload.nodes.some((node) => (
      ['filter', 'reduce'].includes(node.collectionMethod || '')
      && node.labels.includes('Exhausted')
    )), false, 'filter/reduce completion must leave pop directly without an x marker');
    assert.equal(payload.nodes.some((node) => (
      ['filter', 'reduce'].includes(node.collectionMethod || '')
      && node.labels.includes('Pull')
      && node.labels.includes('Collection')
    )), true, 'pop and its collection must be extracted as one graph node');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'PULLS_VALUE'
      && ['filter', 'reduce'].includes(
        payload.nodes.find((node) => stableIdOf(node.stableId) === edge.toId)?.collectionMethod || '',
      )
    )), false, 'direct collection methods must not generate pull-next edges');
    assert.equal(payload.edges.some((edge) => (
      ['next item', 'collection complete', 'accumulator complete'].includes(edge.label || '')
    )), false, 'direct collection methods must not invent iteration lifecycle edges');
    assert.equal(
      payload.edges.some((edge) => edge.type === 'PULLS_VALUE'),
      false,
      'collection protocols must express produced values without invented pull/next relations',
    );
    const filterSubmethod = JSON.parse(filter.submethodsJson || '[]')[0];
    const reduceSubmethod = JSON.parse(reduce.submethodsJson || '[]')[0];
    assert.equal(filterSubmethod.parentStableId, stableIdOf(selected.stableId));
    assert.equal(reduceSubmethod.parentStableId, stableIdOf(total.stableId));
    const reduceParts = JSON.parse(reduce.renderPartsJson || '[]') as Array<{ text: string }>;
    assert.deepEqual(reduceParts.map((part) => part.text), ['reduce(', '0', ')']);
    assert.equal(reduce.renderPartsLayout, 'horizontal');
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('Arg') && node.diaName === '0'
    )), false, 'the reduce initial value must be part of its header mosaic, not a separate Arg node');

    const reduceItem = payload.nodes.find((node) => (
      node.collectionMethod === 'reduce'
      && node.labels.includes('Iteration')
      && node.labels.includes('ValueSlot')
    ));
    const contribution = payload.nodes.find((node) => (
      node.collectionMethod === 'reduce'
      && node.labels.includes('BinaryResult')
    ));
    assert.ok(
      reduceItem && contribution,
      'reduce axis contribution was not extracted',
    );
    assert.equal(payload.nodes.some((node) => (
      node.collectionMethod === 'reduce'
      && node.labels.includes('Receiver')
      && node.diaName === 'contents'
    )), false, 'the captured collection must not be emitted as a separate graph node');
    assert.equal(contribution.labels.includes('Branch'), false);
    assert.equal(contribution.labels.includes('SignificantExpression'), true);
    assert.equal(contribution.labels.includes('Collection'), true);
    assert.equal(contribution.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(reduceSubmethod.memberStableIds, [
      stableIdOf(reduceItem.stableId),
      stableIdOf(contribution.stableId),
    ]);
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(reduceItem.stableId)
      && edge.toId === stableIdOf(contribution.stableId)
      && edge.type === 'NEXT'
    )), 'reduce item set must continue directly into the collection-backed contribution');
    assert.equal(reduceSubmethod.attachments.some((attachment: { stableId: string }) => (
      attachment.stableId === stableIdOf(contribution.stableId)
    )), false, 'the collection-backed contribution is an axis member, not an attachment');
    const contributionParts = JSON.parse(contribution.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
    }>;
    assert.deepEqual(
      contributionParts.map((part) => part.text),
      ['contents', '[', 'entry', '.id', ']?', '.content', '.length', '??', '0'],
    );
    assert.equal(contributionParts[0].kind, 'collection-container');
    const reduceStableId = stableIdOf(reduce.stableId);
    const reduceItemStableId = stableIdOf(reduceItem.stableId);
    const contributionStableId = stableIdOf(contribution.stableId);
    assert.equal(payload.nodes.some((node) => node.labels.includes('CollectionExit')), false);
    assert.equal(payload.nodes.some((node) => (
      ['filter', 'reduce'].includes(node.collectionMethod || '')
      && node.labels.includes('Loop')
    )), false, 'direct collection methods must not create a temporary Loop node');
    assert.equal(payload.nodes.some((node) => (
      ['filter', 'reduce'].includes(node.collectionMethod || '')
      && node.labels.includes('CallbackParams')
    )), false, 'direct collection methods must not create temporary CallbackParams');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'ITERATES_VALUE'
      && edge.fromId === `${reduceStableId}:receiver`
      && edge.toId === reduceStableId
    )), false, 'submethod membership must replace the collection-to-reduce ITERATES_VALUE edge');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'ON_RECEIVER'
      && edge.toId === contributionStableId
    )), false, 'the collection backing must not require an ON_RECEIVER edge');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'PASSES_VALUE'
      && edge.fromId === reduceItemStableId
      && edge.toId === contributionStableId
    )), false, 'the item tile inside the expression must replace its PASSES_VALUE edge');
    const reduceSource = payload.nodes.find((node) => (
      node.collectionMethod === 'reduce'
      && node.labels.includes('Pull')
      && node.labels.includes('Collection')
    ));
    assert.ok(reduceSource, 'reduce collection/shift mosaic was not extracted');
    assert.equal(payload.edges.filter((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === reduceItemStableId
      && edge.toId === stableIdOf(reduceSource.stableId)
      && edge.protocolRole === 'collection-shift-eval'
    )).length, 1, 'the iteration item must directly create one EVAL entry into pull');
    assert.equal(payload.nodes.some((node) => node.primitiveKind === 'emit'), false);
    assert.equal(payload.nodes.some((node) => node.primitiveKind === 'accumulate'), false);
    assert.equal(payload.edges.some((edge) => edge.type === 'EMITS_VALUE'), false);
    assert.equal(payload.edges.some((edge) => edge.type === 'ACCUMULATES_VALUE'), false);
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(selected.stableId)
      && edge.type === 'EVAL'
      && edge.oneWay === true
      && edge.producerRouteRole === 'entry'
    )), 'selected must initiate its producer chain with one-way EVAL');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(total.stableId)
      && edge.toId === stableIdOf(reduce.stableId)
      && edge.type === 'EVAL'
      && edge.oneWay === true
    )), 'total must initiate reduce with one-way EVAL');
    assert.ok(payload.edges.some((edge) => (
      edge.toId === stableIdOf(selected.stableId)
      && edge.type === 'TRUE'
      && edge.protocolRole === 'assignment-return'
      && edge.targetRenderPartStableId === `${stableIdOf(selected.stableId)}:push`
      && edge.lockPortCandidates !== true
    )), 'accepted filter path must return into selected.push');
    assert.ok(payload.edges.some((edge) => (
      edge.toId === stableIdOf(total.stableId)
      && edge.type === 'PASSES_VALUE'
      && edge.protocolRole === 'assignment-return'
      && edge.producerRouteRole === 'return-bottom'
      && edge.label === 'value'
      && edge.sourcePort === 'left'
      && edge.targetPort === 'right'
    )), 'reduce callback result must return into total.add');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('call boundaries are classified from nested expressions inside out', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-call-boundary.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function leaf(first: unknown, second: unknown): string { return String(first || second); }
function outer(value?: unknown): void {}
function send(payload: unknown, options: { uuid: unknown }): void {}
function log(name: string, metadata: unknown): void {}
export function subject(value: unknown) {
  const items: unknown[] = [];
  outer();
  outer(value);
  outer({ one: value });
  outer(leaf(value, 1));
  outer({ one: value, two: 1 });
  outer({ one: leaf(value, 1) });
  outer({ one: { nested: value, second: 1 } });
  send(value, { uuid: value });
  log('event', { one: value, two: 1 });
  items.push({ one: value, two: 1 });
  const source = { one: value, two: 1 };
  leaf(value, 1).trim();
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
    const callNode = (text: string) => payload.nodes.find((node) => (
      node.actionTextRaw === text
      && (node.callBoundaryRole === 'open' || !node.callBoundaryRole)
    ));

    for (const text of ['outer()', 'outer(value)', 'outer({ one: value })']) {
      const node = callNode(text);
      assert.ok(node, `${text} was not extracted`);
      assert.equal(node.callBoundaryDesign, 'mosaic', `${text} must remain one graph mosaic`);
      const stableId = stableIdOf(node.stableId);
      assert.equal(payload.edges.some((edge) => (
        (edge.type === 'ARG' || edge.type === 'ArgJoin')
        && (edge.fromId === stableId || edge.toId === stableId)
      )), false, `${text} must not have materialized argument boundaries`);
    }

    for (const text of [
      'outer(leaf(value, 1))',
      'outer({ one: value, two: 1 })',
      'outer({ one: leaf(value, 1) })',
      'outer({ one: { nested: value, second: 1 } })',
    ]) {
      const node = callNode(text);
      assert.ok(node, `${text} was not extracted`);
      assert.equal(node.callBoundaryDesign, 'split', `${text} must inherit its nested vertical expansion`);
      assert.equal(node.callBoundaryRole, 'open');
      const stableId = stableIdOf(node.stableId);
      if (text.startsWith('outer({')) {
        const openingBrace = payload.nodes.find((candidate) => (
          candidate.labels.includes('ObjectBrace')
          && candidate.objectBraceSide === 'left'
          && candidate.objectBraceMosaicNeighborStableId === stableId
        ));
        if (openingBrace) {
          assert.ok(payload.edges.some((edge) => (
            edge.type === 'FIELD'
            && edge.fromId === stableIdOf(openingBrace.stableId)
          )));
          assert.equal(payload.edges.some((edge) => (
            edge.type === 'FIELD'
            && edge.fromId === stableId
            && edge.toId === stableIdOf(openingBrace.stableId)
          )), false, `${text} must not duplicate its whole-object ARG as FIELD`);
          const objectArgumentEdge = payload.edges.find((edge) => (
            edge.type === 'ARG'
            && edge.fromId === stableId
            && edge.toId === stableIdOf(openingBrace.stableId)
          ));
          assert.ok(objectArgumentEdge, `${text} must retain the whole-object argument role`);
        } else {
          assert.ok(payload.edges.some((edge) => edge.type === 'FIELD' && edge.fromId === stableId));
          assert.equal(payload.edges.some((edge) => edge.type === 'ARG' && edge.fromId === stableId), false);
        }
      } else {
        assert.ok(payload.edges.some((edge) => edge.type === 'ARG' && edge.fromId === stableId));
      }
    }

    const nestedCall = callNode('outer(leaf(value, 1))');
    assert.ok(nestedCall);
    const nestedCallStableId = stableIdOf(nestedCall.stableId);
    const nestedOpeningEdge = payload.edges.find((edge) => (
      edge.type === 'ARG' && edge.fromId === nestedCallStableId
    ));

    const compactObject = payload.nodes.find((node) => (
      node.actionTextRaw === '{ uuid: value }'
      && node.labels.includes('CompactObject')
    ));
    assert.ok(compactObject, 'a simple one-field object must be extracted as one compact object node');
    assert.deepEqual(
      (JSON.parse(compactObject.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['{', 'uuid:', 'value', '}'],
    );
    const compactObjectStableId = stableIdOf(compactObject.stableId);
    assert.equal(payload.nodes.some((node) => (
      node.actionTextRaw === 'value'
      && node.labels.includes('Field')
      && payload.edges.some((edge) => (
        (edge.type === 'FIELD' || edge.type === 'FieldJoin')
        && (edge.fromId === compactObjectStableId || edge.toId === compactObjectStableId)
      ))
    )), false, 'the compact object must not materialize a separate field node');
    assert.equal(payload.edges.some((edge) => (
      (edge.type === 'FIELD' || edge.type === 'FieldJoin')
      && (edge.fromId === compactObjectStableId || edge.toId === compactObjectStableId)
    )), false, 'the compact object must not materialize field boundary edges');
    assert.ok(nestedOpeningEdge, 'the parent call must retain its extracted nested argument');
    const nestedOpening = payload.nodes.find((node) => (
      stableIdOf(node.stableId) === nestedOpeningEdge.toId
    ));
    assert.ok(nestedOpening);
    assert.equal(nestedOpening.callMosaicOwnerStableId, nestedCallStableId);
    assert.equal(nestedOpening.callMosaicRole, 'argument');
    const nestedClosingEdge = payload.edges.find((edge) => (
      edge.type === 'ArgJoin'
      && edge.callSiteStableId === nestedCallStableId
    ));
    assert.ok(nestedClosingEdge, 'the nested call must return into its parent closing boundary');
    const nestedClosing = payload.nodes.find((node) => (
      stableIdOf(node.stableId) === nestedClosingEdge.fromId
    ));
    assert.ok(nestedClosing);
    assert.equal(nestedClosing.callMosaicOwnerStableId, nestedCallStableId);
    assert.equal(nestedClosing.callMosaicRole, 'argument-close');

    const objectCall = callNode('outer({ one: value, two: 1 })');
    assert.ok(objectCall);
    const objectCallStableId = stableIdOf(objectCall.stableId);
    assert.equal(objectCall.representationMode, 'expanded-family');
    assert.ok((objectCall.representationEstimatedColumns || 0) >= 2);
    assert.ok((objectCall.representationEstimatedRows || 0) >= 2);
    const objectMosaicRoles = payload.nodes
      .filter((node) => node.callMosaicOwnerStableId === objectCallStableId)
      .map((node) => node.callMosaicRole)
      .sort();
    assert.deepEqual(
      objectMosaicRoles,
      ['close', 'open'],
      'a multi-field sole object argument must fold both seams into the call mosaics',
    );
    assert.deepEqual(
      (JSON.parse(objectCall.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['outer('],
      'an expanded object uses a shaped brace beside the owner call mosaic',
    );
    assert.equal(objectCall.renderPartsLayout, 'horizontal');
    assert.equal(payload.nodes.some((node) => (
      node.diaName === '{'
      && node.callMosaicOwnerStableId === objectCallStableId
    )), false, 'the folded object opening must not survive as a separate graph node');
    const objectCallClosing = payload.nodes.find((node) => (
      node.callMosaicOwnerStableId === objectCallStableId
      && node.callMosaicRole === 'close'
    ));
    assert.ok(objectCallClosing, 'the folded object call must retain a closing graph node');
    assert.ok(objectCallClosing.labels.includes('FnVisualProxy'));
    assert.equal(objectCallClosing.renderPartsLayout, 'horizontal');
    assert.deepEqual(
      (JSON.parse(objectCallClosing.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      [')'],
    );
    const objectClosingParts = JSON.parse(objectCallClosing.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      labels?: string[];
    }>;
    assert.equal(objectClosingParts[0].kind, 'method');
    assert.ok(objectClosingParts[0].labels?.includes('Method'));
    const objectOpeningBrace = payload.nodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.objectBraceSide === 'left'
      && node.objectBraceMosaicNeighborStableId === objectCallStableId
    ));
    const objectClosingBrace = payload.nodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.objectBraceSide === 'right'
      && node.objectBraceMosaicNeighborStableId === stableIdOf(objectCallClosing.stableId)
    ));
    assert.ok(objectOpeningBrace && objectClosingBrace, 'expanded objects must use shaped braces at both seams');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'FIELD' && edge.fromId === stableIdOf(objectOpeningBrace.stableId)
    )), 'object fields must start at the opening shaped brace');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'FieldJoin' && edge.toId === stableIdOf(objectClosingBrace.stableId)
    )), 'object fields must converge into the closing shaped brace');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'FIELD'
      && edge.fromId === objectCallStableId
      && edge.toId === stableIdOf(objectOpeningBrace.stableId)
    )), false, 'the whole-object argument must not also be a FIELD');
    const foldedObjectArgumentEdge = payload.edges.find((edge) => (
      edge.type === 'ARG'
      && edge.fromId === objectCallStableId
      && edge.toId === stableIdOf(objectOpeningBrace.stableId)
    ));
    assert.ok(foldedObjectArgumentEdge, 'the expanded object family must retain its whole-argument role');
    const foldedObjectClosingEdge = payload.edges.find((edge) => (
      edge.type === 'ArgJoin'
      && edge.fromId === stableIdOf(objectClosingBrace.stableId)
      && edge.toId === stableIdOf(objectCallClosing.stableId)
    ));
    assert.ok(foldedObjectClosingEdge, 'a folded object call must leave its closing brace before invoking the callee');

    const metadataCall = callNode("log('event', { one: value, two: 1 })");
    assert.ok(metadataCall);
    const eventArgument = payload.nodes.find((node) => (
      node.actionTextRaw === "'event'"
      && node.argumentIndex === 0
      && node.labels.includes('Arg')
    ));
    assert.ok(eventArgument?.labels.includes('Literal'), 'literal call arguments must retain their AST literal role');
    const metadataArgumentEdge = payload.edges.find((edge) => (
      edge.type === 'ARG'
      && edge.fromId === stableIdOf(metadataCall.stableId)
      && edge.argumentIndex === 1
    ));
    assert.ok(metadataArgumentEdge, 'the object argument must start at its opening brace');
    const metadataOpeningBrace = payload.nodes.find((node) => (
      stableIdOf(node.stableId) === metadataArgumentEdge.toId
      && node.labels.includes('ObjectBrace')
      && node.objectBraceSide === 'left'
    ));
    assert.ok(metadataOpeningBrace, 'ARG must target the opening brace directly');
    assert.equal(payload.nodes.some((node) => (
      node.actionTextRaw === '{ one: value, two: 1 }'
      && node.argumentIndex === 1
      && !node.labels.includes('ObjectBrace')
    )), false, 'expanded object arguments must not create a separate brace tile node');
    const metadataBraces = payload.nodes.filter((node) => (
      node.labels.includes('ObjectBrace')
      && node.objectFamilyStableId === metadataOpeningBrace.objectFamilyStableId
    ));
    assert.equal(metadataBraces.length, 2, 'a two-field object argument must have one brace pair');

    const collectionCall = callNode('items.push({ one: value, two: 1 })');
    assert.ok(collectionCall, 'the collection method call was not extracted');
    assert.ok(collectionCall.labels.includes('Collection'));
    assert.equal(collectionCall.renderPartsLayout, 'container-overlay-side');
    const collectionParts = JSON.parse(collectionCall.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
    }>;
    assert.deepEqual(collectionParts.map((part) => part.text), ['items', 'push(']);
    assert.equal(collectionParts[0].kind, 'collection-container');
    const collectionCallClosing = payload.nodes.find((node) => (
      node.callMosaicOwnerStableId === stableIdOf(collectionCall.stableId)
      && node.callMosaicRole === 'close'
    ));
    assert.ok(collectionCallClosing, 'the expanded collection call must retain its object/call closing mosaic');
    assert.equal(
      collectionCallClosing.labels.includes('Collection'),
      false,
      'an object closing boundary must not be classified as a collection merely because its call receiver is one',
    );
    const collectionClosingParts = JSON.parse(collectionCallClosing.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      labels?: string[];
    }>;
    assert.deepEqual(collectionClosingParts.map((part) => part.text), [')']);
    assert.equal(collectionClosingParts[0]?.kind, 'method');

    const sourceAssignment = payload.nodes.find((node) => (
      node.diaName === 'source'
      && node.labels.includes('Assignment')
      && node.containerMethodKind === 'set'
    ));
    assert.ok(sourceAssignment, 'the object assignment container was not extracted');
    const sourceAssignmentStableId = stableIdOf(sourceAssignment.stableId);
    assert.equal(sourceAssignment.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(
      (JSON.parse(sourceAssignment.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['source', 'set('],
    );
    assert.equal(payload.nodes.some((node) => (
      node.diaName === '{'
      && payload.edges.some((edge) => edge.type === 'EVAL'
        && edge.fromId === sourceAssignmentStableId
        && edge.toId === stableIdOf(node.stableId))
    )), false, 'object assignment opening must be part of the virtual set mosaic');
    const sourceClosing = payload.nodes.find((node) => (
      node.diaName === ')'
      && payload.edges.some((edge) => edge.type === 'ASSIGNS_VALUE'
        && edge.fromId === stableIdOf(node.stableId)
        && edge.toId === sourceAssignmentStableId)
    ));
    assert.ok(sourceClosing, 'object assignment must retain the combined object/method closing');
    assert.deepEqual(
      (JSON.parse(sourceClosing.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      [')'],
    );
    const sourceOpeningBrace = payload.nodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.objectBraceSide === 'left'
      && node.objectBraceMosaicNeighborStableId === sourceAssignmentStableId
    ));
    assert.ok(sourceOpeningBrace);
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'FIELD' && edge.fromId === stableIdOf(sourceOpeningBrace.stableId)
    )), 'assignment fields must start at the shaped brace beside set');

    const trim = callNode('leaf(value, 1).trim()');
    assert.ok(trim, 'zero-argument method continuation was not extracted');
    assert.equal(trim.callBoundaryDesign, 'mosaic');
    assert.equal(trim.callBoundaryRole, undefined);
    const trimParts = JSON.parse(trim.renderPartsJson || '[]') as Array<{ text: string }>;
    assert.deepEqual(trimParts.map((part) => part.text), ['trim()']);
    const trimStableId = stableIdOf(trim.stableId);
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('FnVisualProxy')
      && node.sourceCallStableId === trimStableId
    )), false, 'zero-argument continuation must not create another closing proxy');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('materialized Steps preserve their local function scope', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-local-function-scope.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function consume(value: string): void {}
export function subject(input: string) {
  const executeImmediateCommand = async (): Promise<void> => {
    const localValue = input.trim();
    consume(localValue);
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
    const localScopedNodes = payload.nodes.filter((node) => node.parentLocalFunctionStableId);
    const localBodyCall = localScopedNodes.find((node) => node.actionTextRaw?.includes('consume'));
    assert.ok(localBodyCall?.parentLocalFunctionStableId, `local function body was not extracted in its own scope: ${JSON.stringify(localScopedNodes.map((node) => ({ labels: node.labels, text: node.actionTextRaw, step: node.parentStepStableId })))}`);
    assert.ok(localBodyCall.parentStepStableId, 'local function body node has no owning Step');
    const localStep = payload.nodes.find((node) => (
      node.labels.includes('Step')
      && stableIdOf(node.stableId) === localBodyCall.parentStepStableId
    ));
    assert.ok(localStep, `local function body Step was not materialized: ${localBodyCall.parentStepStableId}`);
    assert.equal(localStep.parentLocalFunctionStableId, localBodyCall.parentLocalFunctionStableId);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('materialized Steps keep the source function when an external member sorts first', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-external-step-owner.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
import * as remoteModule from './missing-remote.js';
export function subject(input: string) {
  remoteModule.resume(input);
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
    const call = payload.nodes.find((node) => node.actionTextRaw?.includes('remoteModule.resume'));
    assert.ok(subject && call?.parentStepStableId, 'external call or its source function was not extracted');
    const step = payload.nodes.find((node) => (
      node.labels.includes('Step')
      && stableIdOf(node.stableId) === call.parentStepStableId
    ));
    assert.ok(step, `Step was not materialized: ${call.parentStepStableId}`);
    assert.equal(stableIdOf(step.parentFnStableId), stableIdOf(subject.stableId));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('single negated predicate stays attached to its predicate node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-single-negation.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(isReady: boolean, input: string) {
  const options = { fromKeybinding: isReady };
  if (!isReady) {
    return 'blocked';
  }
  if (!options?.fromKeybinding) {
    return 'key';
  }
  if (!input.trim()) {
    return 'empty';
  }
  return 'ready';
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
    const directPredicate = payload.nodes.find((node) => (
      node.logicalNotPrefix === true && node.diaName === '!isReady'
    ));
    assert.ok(directPredicate, 'negation prefix was not attached to the direct predicate');
    const conditionStepStableId = String(directPredicate.parentStepStableId || '');
    assert.ok(conditionStepStableId, 'direct predicate has no owning condition Step');
    const nodes = payload.nodes.filter((node) => node.parentStepStableId === conditionStepStableId);
    const nodeIds = new Set(nodes.map((node) => stableIdOf(node.stableId)));
    const edges = payload.edges.filter((edge) => nodeIds.has(edge.fromId) || nodeIds.has(edge.toId));

    assert.equal(
      nodes.some((node) => node.renderHidden !== true && node.label === 'logical-not'),
      false,
      'single negation must not be split into a standalone predicate operator',
    );
    const directParts = JSON.parse(directPredicate?.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.deepEqual(
      directParts.slice(0, 2).map((part) => ({ text: part.text, kind: part.kind })),
      [
        { text: '!', kind: 'operator' },
        { text: 'isReady', kind: 'value' },
      ],
      'single negation must be a separate operator tile before its variable',
    );
    assert.ok(
      directParts[0]?.labels?.includes('System') && directParts[0]?.labels?.includes('LogicalNot'),
      'logical-not tile must use the system operator palette',
    );
    assert.ok(edges.some((edge) => (
      edge.fromId === stableIdOf(directPredicate?.stableId)
      && edge.type === 'TRUE'
    )), 'the negated predicate must expose a TRUE branch from the original falsy outcome');
    assert.ok(edges.some((edge) => (
      edge.fromId === stableIdOf(directPredicate?.stableId)
      && edge.type === 'FALSE'
    )), 'the negated predicate must expose a FALSE branch from the original truthy outcome');

    const optionalChainPredicate = payload.nodes.find((node) => (
      node.logicalNotPrefix === true
      && node.diaName === '!options?.fromKeybinding'
    ));
    assert.ok(optionalChainPredicate, 'negation prefix was not attached to the optional-chain predicate');
    const optionalParts = JSON.parse(optionalChainPredicate?.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
    }>;
    assert.equal(optionalParts[0]?.text, '!');
    assert.equal(optionalParts[0]?.kind, 'operator');
    assert.equal(optionalParts[1]?.text, 'options?');

    const callPredicate = payload.nodes.find((node) => (
      node.logicalNotPrefix === true
      && node.actionTextRaw === 'input.trim()'
    ));
    assert.ok(callPredicate, 'negation prefix was not attached to the call predicate');
    const callParts = JSON.parse(callPredicate?.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.deepEqual(
      callParts.slice(0, 3).map((part) => ({ text: part.text, kind: part.kind })),
      [
        { text: '!', kind: 'operator' },
        { text: 'input', kind: 'value' },
        { text: 'trim()', kind: 'method' },
      ],
      'single negation must be a separate operator tile before a call mosaic',
    );
    assert.ok(
      callParts[0]?.labels?.includes('System') && callParts[0]?.labels?.includes('LogicalNot'),
      'call logical-not tile must use the system operator palette',
    );

  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('De Morgan parentheses do not create a logical-not render tile', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-de-morgan-negation.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(left: boolean, right: boolean) {
  if (!(left && right)) {
    return 'blocked';
  }
  return 'ready';
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
    const logicalNotParts = payload.nodes.flatMap((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ labels?: string[] }>;
      return parts.filter((part) => part.labels?.includes('LogicalNot'));
    });
    assert.equal(
      logicalNotParts.length,
      0,
      'De Morgan parentheses must keep their existing compound-condition extraction',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('logical OR keeps its continuation in an operand sub-column and converges matching outcomes', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-logical-or.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function feature(name: string): boolean { return name.length > 0; }
function resumeProactive(): void {}
export function subject() {
  if (feature('PROACTIVE') || feature('KAIROS')) {
    resumeProactive();
  }
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
    const predicates = payload.nodes
      .filter((node) => node.labels?.includes('PredicateCall') && String(node.actionTextRaw || '').startsWith('feature('))
      .sort((left, right) => Number(left.operationIndex) - Number(right.operationIndex));
    assert.equal(predicates.length, 2);
    assert.ok(predicates[0].labels?.includes('Branch'));
    assert.equal(predicates[0].labels?.includes('Operand'), false,
      'the first predicate must stay on the surrounding flow axis');
    assert.ok(predicates[1].labels?.includes('Operand'),
      'the short-circuit continuation must start the neighbouring operand sub-column');
    assert.ok(predicates[1].labels?.includes('Flow'));
    assert.equal(predicates[1].labels?.includes('Data'), false,
      'an if-condition operand remains control flow rather than becoming a DataBranch');
    assert.equal(predicates[0].flowLaneRole, 'main');
    assert.equal(predicates[1].flowLaneRole, 'optional');
    assert.notEqual(predicates[0].flowLaneStableId, predicates[1].flowLaneStableId);
    const conditionTrueJoin = payload.nodes.find((node) => node.mergeLabel === 'condition-true-merge');
    assert.ok(conditionTrueJoin, 'both successful OR outcomes must converge before the body');
    assert.equal(conditionTrueJoin.flowLaneStableId, predicates[0].flowLaneStableId,
      'the join belongs to the common flow ancestor of both successful outcomes');
    const conditionTrueJoinId = stableIdOf(conditionTrueJoin.stableId);
    assert.equal(payload.edges.filter((edge) => (
      edge.toId === conditionTrueJoinId && edge.type === 'TRUE'
    )).length, 2);
    const bodyCall = payload.nodes.find((node) => String(node.actionTextRaw || '').startsWith('resumeProactive('));
    assert.ok(bodyCall);
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === conditionTrueJoinId
      && edge.toId === stableIdOf(bodyCall.stableId)
      && edge.type === 'NEXT'
    )));
    assert.equal(payload.nodes.filter((node) => node.mergeLabel === 'if-merge').length, 1,
      'the body and rejected outcome must converge once after the if');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a compound condition outcome join belongs to the common ancestor of sibling optional lanes', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-sibling-optional-lanes.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function effect(): void {}
export function subject(first: boolean, second: boolean, guard: boolean) {
  if ((first || second) && guard) {
    effect();
  }
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
    const predicates = payload.nodes
      .filter((node) => node.labels?.includes('Branch'))
      .sort((left, right) => Number(left.operationIndex) - Number(right.operationIndex));
    assert.equal(predicates.length, 3);
    assert.equal(predicates[0].flowLaneRole, 'main');
    assert.equal(predicates[1].flowLaneRole, 'optional');
    assert.equal(predicates[2].flowLaneRole, 'optional');
    assert.notEqual(predicates[1].flowLaneStableId, predicates[2].flowLaneStableId);
    const falseJoin = payload.nodes.find((node) => node.mergeLabel === 'condition-false-merge');
    assert.ok(falseJoin);
    assert.equal(falseJoin.flowLaneStableId, predicates[0].flowLaneStableId,
      'sibling optional outcomes must return to their main common ancestor');
    assert.equal(falseJoin.flowLaneRole, 'main');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('if convergence materializes one FlowJoin per additional reentry without a final join', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-side-join.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function effect(): void {}
export function subject(first: boolean, second: boolean, third: boolean) {
  if (first && second && third) {
    effect();
  }
  return 'done';
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
    const conditionJoins = payload.nodes.filter((node) => node.mergeLabel === 'condition-false-merge');
    const bodyJoins = payload.nodes.filter((node) => node.mergeLabel === 'if-merge');
    assert.equal(conditionJoins.length, 1, 'all short-circuit FALSE outcomes must merge once inside the condition Step');
    const conditionJoinId = stableIdOf(conditionJoins[0].stableId);
    assert.equal(conditionJoins[0].flowLaneRole, 'main',
      'short-circuit outcomes from sibling optional lanes converge on their common main lane');
    assert.equal(
      payload.edges.filter((edge) => edge.toId === conditionJoinId).length,
      3,
      'the single condition join must receive every falsy short-circuit outcome directly',
    );
    assert.notEqual(conditionJoins[0].inlineStepTerminalJoin, true,
      'the rejected short-circuit outcome is a side convergence aligned with its terminal predicate');
    assert.equal(bodyJoins.length, 1, 'the returning body must rejoin the already merged senior flow once');
    assert.ok(conditionJoins[0].parentStepStableId, 'condition merge must remain in its condition Step');
    assert.ok(!bodyJoins[0].parentStepStableId, 'body reentry must remain outside a Step');
    assert.equal(
      bodyJoins[0].flowJoinBackboneSourceStableId,
      stableIdOf(conditionJoins[0].stableId),
      'the shallower condition continuation must remain the senior axis of the body reentry',
    );
    const joins = [...conditionJoins, ...bodyJoins];
    for (const join of joins) {
      const joinId = stableIdOf(join.stableId);
      assert.equal(
        payload.edges.filter((edge) => edge.toId === joinId).length,
        join.mergeLabel === 'condition-false-merge' ? 3 : 2,
      );
      assert.ok(payload.edges.some((edge) => (
        edge.fromId === join.flowJoinEntrySourceStableId && edge.toId === joinId
      )), 'each join must receive its declared reentry directly');
    }
    const finalJoinId = stableIdOf(bodyJoins[0].stableId);
    assert.ok(payload.edges.some((edge) => edge.fromId === finalJoinId && edge.type === 'NEXT'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('sequential if statements inside a FlowBlock each converge before the next condition', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-sequential-nested-if.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function firstEffect(): void {}
function secondEffect(): void {}
export function subject(outer: boolean, first: boolean, second: boolean) {
  if (outer) {
    if (first) {
      firstEffect();
    }
    if (second) {
      secondEffect();
    }
  }
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
    const firstEffect = payload.nodes.find((node) => node.diaName === 'firstEffect()');
    const innerJoins = payload.nodes.filter((node) => (
      node.mergeLabel === 'if-merge'
      && node.parentFlowBlockStableId
    ));

    assert.ok(firstEffect);
    assert.equal(innerJoins.length, 2, 'both nested if statements must own an explicit convergence');
    const firstJoin = innerJoins.find((join) => payload.edges.some((edge) => (
      edge.fromId === stableIdOf(firstEffect?.stableId)
      && edge.toId === stableIdOf(join.stableId)
    )));
    assert.ok(firstJoin, 'the first body must return to its own FlowJoin');
    const continuation = payload.edges.find((edge) => (
      edge.fromId === stableIdOf(firstJoin?.stableId)
      && edge.type === 'NEXT'
    ));
    assert.ok(continuation, 'the first FlowJoin must expose the next control step');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === continuation?.toId
      && (edge.type === 'TRUE' || edge.type === 'FALSE')
    )), 'the second condition must start from the first FlowJoin');
    assert.ok(!payload.edges.some((edge) => (
      edge.fromId === stableIdOf(firstEffect?.stableId)
      && edge.toId === continuation?.toId
    )), 'a completed body must not bypass its FlowJoin');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('else-if shares one terminal FlowJoin instead of forming a chain of joins', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-else-if.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function effect(value: string): void {}
export function subject(first: boolean, second: boolean) {
  if (first) {
    effect('first');
  } else if (second) {
    effect('second');
  }
  return 'done';
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
      payload.nodes.filter((node) => node.flowBlockRole === 'alternative').length,
      0,
      'else-if is a continuation condition; only its executable body may become a side FlowBlock',
    );
    assert.equal(
      payload.nodes.filter((node) => node.flowBlockRole === 'side').length,
      2,
      'both executable if bodies remain explicit side FlowBlocks',
    );
    const joins = payload.nodes.filter((node) => node.mergeLabel === 'if-merge');
    assert.equal(joins.length, 1, 'all alternatives in an else-if chain must converge in one FlowJoin');
    const join = joins[0];
    const joinId = stableIdOf(join.stableId);
    const incoming = payload.edges.filter((edge) => edge.toId === joinId);
    assert.equal(incoming.length, 3, 'first body, second body, and the final rejected condition must enter the shared join');
    assert.equal(
      incoming.filter((edge) => edge.type === 'REJOINS').length,
      2,
      'both completed bodies must return directly to the shared join',
    );
    assert.equal(
      incoming.filter((edge) => edge.elseIfChainBypass === true).length,
      1,
      'only the earlier body must bypass the remaining else-if alternatives',
    );
    assert.ok(incoming.some((edge) => edge.type === 'FALSE'), 'the final rejected condition must enter the shared join directly');
    const placement = payload.nodes.find((node) => stableIdOf(node.stableId) === join.flowJoinPlacementSourceStableId);
    assert.ok(placement, 'join placement source must exist');
    const incomingNodes = incoming
      .map((edge) => payload.nodes.find((node) => stableIdOf(node.stableId) === edge.fromId))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    assert.equal(
      placement?.operationIndex,
      Math.max(...incomingNodes.map((node) => node.operationIndex ?? Number.MIN_SAFE_INTEGER)),
      'the shared join must be placed after the latest alternative endpoint',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('template tags and substitutions are lossless mosaic parts without duplicate nested calls', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-template-tag.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
const TAG = 'stdout';
function escapeXml(value: string): string { return value; }
function consume(value: string): void {}
export function subject(result: string) {
  consume(\`<\${TAG}>\${escapeXml(result)}</\${TAG}>\`);
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
    const structured = payload.nodes
      .map((node) => ({ node, parts: JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string; kind: string }> }))
      .find(({ parts }) => parts.map((part) => part.text).join('|') === 'consume(|`|<|${|TAG|}|>|${|escapeXml(|result|)|}|</|${|TAG|}|>|`|)');
    assert.ok(structured, 'the call and its template argument must remain one graph mosaic');
    assert.deepEqual(
      structured?.parts.map((part) => part.kind),
      [
        'method', 'punctuation', 'literal', 'punctuation', 'value', 'punctuation',
        'literal', 'punctuation', 'method', 'value', 'punctuation', 'punctuation',
        'literal', 'punctuation', 'value', 'punctuation', 'literal', 'punctuation',
        'punctuation',
      ],
    );
    assert.equal(
      payload.nodes.filter((node) => node.actionTextRaw === 'escapeXml(result)').length,
      0,
      'a nested one-argument call represented by the template mosaic must not also become a graph node',
    );
    assert.equal(payload.nodes.some((node) => node.labels.includes('ExpressionMosaic')), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('indexed optional-access predicates are extracted as text-sized mosaic parts', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-indexed-optional-access.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Item = { id: string };
export function subject(items: Item[], contents: Record<string, { type: string }>) {
  return items.filter(entry => contents[entry.id]?.type === 'text');
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
    const predicate = payload.nodes.find((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>;
      return node.labels.includes('Branch') && parts.some((part) => part.text === '===');
    });
    assert.ok(predicate, 'the indexed optional-access predicate was not extracted');
    const parts = JSON.parse(predicate.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      labels?: string[];
    }>;
    assert.deepEqual(parts.map((part) => part.text), [
      'contents', '[', 'entry', '.id', ']?', '.type', '===', "'text'",
    ]);
    assert.equal(parts[0].kind, 'collection-container');
    assert.deepEqual(parts.slice(1, 6).map((part) => part.kind), [
      'punctuation', 'value', 'value', 'punctuation', 'value',
    ]);
    assert.ok(parts[3].labels?.includes('FieldAccess'));
    assert.ok(parts[5].labels?.includes('FieldAccess'));
    assert.ok(parts[4].labels?.includes('OptionalCheck'));
    assert.ok(predicate.labels.includes('Collection'));
    assert.equal(predicate.renderPartsLayout, 'container-overlay-side');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('dot-accessed object fields are separate mosaic parts and optional checks stay on the receiver', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-property-access-mosaic.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Command = { name: string };
type Ref = { current: boolean };
export function subject(
  cmd: Command,
  commandName: string,
  matchingCommand: Command | undefined,
  idleHintShownRef: Ref,
) {
  if (cmd.name === commandName) return 1;
  if (matchingCommand?.name === 'clear') return 2;
  if (idleHintShownRef.current) return 3;
  return 0;
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
    const partsFor = (expectedTexts: string[]) => {
      const predicate = payload.nodes.find((node) => {
        if (!node.labels.includes('Branch')) return false;
        const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>;
        return parts.map((part) => part.text).join('\u0000') === expectedTexts.join('\u0000');
      });
      assert.ok(predicate, `predicate mosaic ${expectedTexts.join(' | ')} was not extracted`);
      return JSON.parse(predicate.renderPartsJson || '[]') as Array<{ text: string; labels?: string[] }>;
    };
    const direct = partsFor(['cmd', '.name', '===', 'commandName']);
    assert.deepEqual(direct.map((part) => part.text), ['cmd', '.name', '===', 'commandName']);
    assert.ok(direct[1].labels?.includes('FieldAccess'));

    const optional = partsFor(['matchingCommand?', '.name', '===', "'clear'"]);
    assert.deepEqual(optional.map((part) => part.text), ['matchingCommand?', '.name', '===', "'clear'"]);
    assert.ok(optional[0].labels?.includes('OptionalCheck'));
    assert.ok(optional[1].labels?.includes('FieldAccess'));

    const refRead = partsFor(['idleHintShownRef', '.current']);
    assert.deepEqual(refRead.map((part) => part.text), ['idleHintShownRef', '.current']);
    assert.ok(refRead[1].labels?.includes('FieldAccess'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a call used as an argument is materialized once without an ArgumentOccurrence duplicate', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-nested-call.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function inner(value: string): string { return value; }
function outer(first: string, second: string): void {}
export function subject(value: string) {
  outer(inner(value), value);
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
    const innerNodes = payload.nodes.filter((node) => node.actionTextRaw === 'inner(value)');
    assert.equal(innerNodes.length, 1);
    assert.equal(innerNodes[0].labels.includes('ArgumentOccurrence'), false);
    assert.equal(innerNodes[0].labels.includes('Start'), true);
    assert.equal(innerNodes[0].labels.some((label) => ['Call', 'Request', 'Read', 'Write'].includes(label)), true);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('member access is stored as parts of one graph node while split calls keep graph boundaries', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-structured-member.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function consume(first: number, second: string): void {}
export function subject(messagesRef: { current: { length: number } }, value: string) {
  consume(messagesRef.current.length, value);
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
    assert.ok(payload.nodes.every((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as unknown[];
      return parts.length >= 1;
    }), 'every graph node must expose the same ordered render-part structure');

    const memberNodes = payload.nodes.filter((node) => {
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text: string }>;
      return parts.map((part) => part.text).join('') === 'messagesRef.current.length';
    });
    assert.equal(memberNodes.length, 1, 'the complete member access must be one graph node');

    const splitCallNodes = payload.nodes.filter((node) => node.callBoundaryDesign === 'split');
    assert.ok(splitCallNodes.some((node) => node.callBoundaryRole === 'open'));
    assert.ok(splitCallNodes.some((node) => node.callBoundaryRole === 'close'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a call receiving a function owns a graph-backed submethod hierarchy', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-submethod.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function schedule(callback: (error: Error) => void): void;
declare function report(error: Error): void;
export function subject() {
  schedule(error => {
    report(error);
  });
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
    const call = payload.nodes.find((node) => node.actionTextRaw?.startsWith('schedule('));
    assert.ok(call, 'callback owner call was not extracted');
    const callStableId = stableIdOf(call.stableId);
    assert.equal(call.submethodStableId, callStableId);
    assert.equal(call.submethodKind, 'function-callback');
    const submethods = JSON.parse(String(call.submethodsJson || '[]'));
    assert.equal(submethods.length, 1);
    assert.equal(submethods[0].headerStableId, callStableId);
    const members = payload.nodes.filter((node) => node.memberOfSubmethodStableId === callStableId);
    assert.ok(members.some((node) => node.labels?.includes('CallbackFn')));
    assert.ok(members.some((node) => node.actionTextRaw?.startsWith('report(')));
    assert.equal(payload.nodes.some((node) => node.labels?.includes('ExecutionJunction')), false);
    assert.equal(payload.edges.some((edge) => edge.type === 'HAS_STAGE'), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a nested catch callback is a child submethod with its error parameter on the axis', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-nested-catch-submethod.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function schedule(callback: (snapshot: string) => void): void;
declare function save(snapshot: string): Promise<void>;
declare function report(error: unknown): void;
export function subject() {
  schedule(snapshot => {
    void save(snapshot).catch(error => {
      report(error);
    });
  });
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
    const root = payload.nodes.find((node) => node.actionTextRaw?.startsWith('schedule('));
    const receiverCall = payload.nodes.find((node) => (
      node.actionTextRaw === 'save(snapshot)'
      && node.submethodKind === 'function-callback'
      && node.parentSubmethodStableId === stableIdOf(root?.stableId)
    ));
    const catchCall = payload.nodes.find((node) => (
      node.actionTextRaw?.includes('.catch(error =>')
      && node.submethodKind === 'catch'
      && node.parentSubmethodStableId === stableIdOf(receiverCall?.stableId)
    ));
    assert.ok(root && receiverCall && catchCall, 'nested catch hierarchy was not extracted');
    assert.equal(receiverCall.parentSubmethodStableId, stableIdOf(root.stableId));
    assert.equal(catchCall.parentSubmethodStableId, stableIdOf(receiverCall.stableId));
    assert.equal(receiverCall.invocationMode, 'asynchronous');
    assert.equal(receiverCall.responseMode, 'none');
    assert.ok(receiverCall.labels.includes('Async'));
    assert.ok(receiverCall.labels.includes('FireAndForget'));
    const catchStableId = stableIdOf(catchCall.stableId);
    const errorParameter = payload.nodes.find((node) => (
      node.memberOfSubmethodStableId === catchStableId
      && node.labels.includes('CallbackFn')
    ));
    assert.ok(errorParameter, 'catch error callback must be an actual submethod member');
    assert.equal(errorParameter.callbackDeferred, true);
    assert.equal(errorParameter.asyncContract, 'promise-catch-callback');
    assert.ok(errorParameter.labels.includes('Async'));
    assert.ok(errorParameter.labels.includes('Deferred'));
    const errorRenderParts = JSON.parse(errorParameter.renderPartsJson || '[]') as Array<{ text: string }>;
    assert.deepEqual(errorRenderParts.map((part) => part.text), ['error =>']);
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('CallbackEnd')
      && node.memberOfSubmethodStableId === catchStableId
    )), false, 'a callback body must not acquire a synthetic completion node');
    assert.equal(payload.nodes.some((node) => node.labels.includes('ExecutionJunction')), false);
    assert.equal(payload.edges.some((edge) => edge.type === 'HAS_STAGE'), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a nested promise callback owns members from its own statement step', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-nested-promise-step.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function useEffect(callback: () => void | (() => void), dependencies: unknown[]): void;
declare function enabled(): boolean;
declare function loadWatcher(): Promise<{ watch(): () => void }>;
export function subject(active: boolean) {
  useEffect(() => {
    if (enabled()) {
      let cleanup: (() => void) | undefined;
      void loadWatcher().then(({ watch }) => {
        cleanup = watch();
      });
      return () => cleanup?.();
    }
  }, [active]);
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
    const root = payload.nodes.find((node) => node.actionTextRaw?.startsWith('useEffect('));
    const nested = payload.nodes.find((node) => (
      node.actionTextRaw?.includes('.then(({ watch }) =>')
      && node.parentSubmethodStableId === stableIdOf(root?.stableId)
    ));
    assert.ok(root && nested, 'nested promise callback hierarchy was not extracted');

    const records = JSON.parse(root.submethodsJson || '[]') as Array<{
      headerStableId?: string;
      memberStableIds?: string[];
    }>;
    const nestedRecord = records.find((record) => record.headerStableId === stableIdOf(nested.stableId));
    assert.ok(nestedRecord, 'nested callback record is missing from the root hierarchy index');
    const nestedMembers = payload.nodes.filter((node) => (
      nestedRecord.memberStableIds?.includes(stableIdOf(node.stableId))
    ));
    assert.ok(nestedMembers.length > 0, 'nested callback must expose members');
    assert.ok(nestedMembers.every((member) => member.parentStepStableId === nested.parentStepStableId));
    assert.notEqual(nested.parentStepStableId, root.parentStepStableId);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('state updater callbacks are extracted as axis flow without callback tiles', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-state-updater.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type State = { value: number };
declare function setState(updater: (prev: State) => State): void;
const sessionStore = { async write(snapshot: number) { void snapshot; } };
function increment(value: number, callback: (snapshot: number) => void): number {
  const nextValue = value + 1;
  const snapshot = nextValue;
  callback(snapshot);
  return nextValue;
}
async function persist(snapshot: number): Promise<void> {
  await sessionStore.write(snapshot);
}
declare function report(error: unknown): void;
export function subject() {
  setState(prev => ({
    ...prev,
    value: increment(prev.value, snapshot => {
      void persist(snapshot).catch(error => {
        report(error);
      });
    }),
  }));
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
    const stateCall = payload.nodes.find((node) => node.actionTextRaw?.startsWith('setState('));
    assert.ok(stateCall?.parentStepStableId, 'state update call was not extracted inside a Step');
    const stepStableId = String(stateCall.parentStepStableId);
    const nodes = payload.nodes.filter((node) => node.parentStepStableId === stepStableId);
    const ids = new Set(nodes.map((node) => stableIdOf(node.stableId)));
    const edges = payload.edges.filter((edge) => ids.has(edge.fromId) || ids.has(edge.toId));

    assert.equal(nodes.some((node) => node.labels.includes('CallbackFn')), false);
    assert.equal(nodes.some((node) => node.callbackKind), false);
    assert.ok(stateCall.labels.includes('SubStep'));
    assert.equal(
      nodes.some((node) => node.calleeName === 'catch' || node.diaName === 'catch'),
      false,
      JSON.stringify(nodes.map((node) => ({ id: stableIdOf(node.stableId), name: node.diaName, callee: node.calleeName, labels: node.labels }))),
    );
    assert.ok(edges.some((edge) => edge.type === 'ASYNC'));
    assert.ok(edges.some((edge) => edge.type === 'CATCH'));
    assert.equal(
      edges.some((edge) => edge.fromId === edge.toId),
      false,
      JSON.stringify(edges.filter((edge) => edge.fromId === edge.toId)),
    );
    assert.equal(edges.some((edge) => (
      edge.semanticExpansion === 'call-execution'
      && ['MATERIALIZES_ARGUMENT', 'MATERIALIZES_RETURN', 'PASSES_VALUE'].includes(edge.type)
    )), false);

    assert.equal(stateCall.callBoundaryDesign, 'split');
    assert.equal(stateCall.diaName, 'setState(');
    assert.equal(stateCall.compactCallMosaic, true);
    assert.deepEqual(
      (JSON.parse(stateCall.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['setState('],
    );
    assert.equal(nodes.some((node) => (
      node.labels.includes('FnVisualProxy')
      && node.sourceCallStableId === stableIdOf(stateCall.stableId)
    )), false, 'a callback promoted to a submethod must not leave an orphan call closure');

    const incrementCall = nodes.find((node) => node.actionTextRaw?.startsWith('increment('));
    assert.ok(incrementCall, 'the nested value-producing call was not extracted');
    assert.equal(incrementCall.callBoundaryDesign, 'mosaic');
    assert.deepEqual(
      (JSON.parse(incrementCall.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['increment(', 'prev', '.value', ')'],
    );
    assert.equal(edges.some((edge) => (
      edge.type === 'ARG' && edge.fromId === stableIdOf(incrementCall.stableId)
    )), false, 'the sole visible argument belongs to the call mosaic');

    const nextValue = nodes.find((node) => node.diaName === 'value' && node.labels.includes('ValueSlot'));
    assert.ok(nextValue?.labels.includes('SubStepMember'));
    assert.ok(nextValue?.labels.includes('Virtual'));
    const nextValueParts = JSON.parse(nextValue?.renderPartsJson || '[]') as Array<{
      text: string;
      labels?: string[];
    }>;
    assert.deepEqual(nextValueParts.map((part) => part.text), ['value', 'set']);
    assert.ok(nextValueParts.every((part) => part.labels?.includes('Virtual')));
    const stateObjectOpening = nodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.labels.includes('Open')
      && node.objectBraceMosaicNeighborStableId === stableIdOf(stateCall.stableId)
    ));
    assert.ok(stateObjectOpening, 'the updater call must own the opening object brace');
    assert.ok(edges.some((edge) => (
      edge.type === 'EVAL'
      && edge.fromId === stableIdOf(stateCall.stableId)
      && edge.toId === stableIdOf(stateObjectOpening.stableId)
      && edge.semanticExpansion === 'state-update'
    )), 'the updater call must enter its callback result instead of leaving that object family disconnected');
    assert.ok(edges.some((edge) => (
      edge.type === 'FIELD'
      && edge.fromId === stableIdOf(stateObjectOpening.stableId)
      && edge.toId === stableIdOf(nextValue.stableId)
      && edge.fieldName === 'value'
    )), 'the expected value must be the state object field itself');
    assert.ok(edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === stableIdOf(nextValue.stableId)
      && edge.toId === stableIdOf(incrementCall.stableId)
    )), 'the awaiting container must continue to its producing SubStep');
    const assignmentReturns = edges.filter((edge) => (
      edge.fromId === stableIdOf(incrementCall.stableId)
      && edge.toId === stableIdOf(nextValue.stableId)
      && edge.protocolRole === 'assignment-return'
    ));
    assert.equal(assignmentReturns.length, 1);
    assert.equal(assignmentReturns[0].type, 'YIELDS_VALUE');
    assert.equal(assignmentReturns[0].label, 'value');
    assert.equal(
      nodes.some((node) => node.diaName === 'snapshot' && node.labels.includes('LocalBinding')),
      false,
      'snapshot passed through callback persistence belongs to call mosaics, not a floating node',
    );
    assert.equal(
      nodes.some((node) => (
        node.labels.includes('StatefulOperation')
        || node.labels.includes('Storage')
        || node.labels.includes('ResourceProxy')
      )),
      false,
      'a nested project function must not invent a persistent storage proxy',
    );

    const stateWrite = stateCall;
    const stateObjectClose = nodes.find((node) => (
      node.callMosaicRole === 'close'
      && node.sequenceOwnerStableId === stableIdOf(stateWrite?.stableId)
    ));
    const stateWriteClose = stateObjectClose;
    assert.ok(
      stateWrite && stateObjectClose && stateWriteClose,
      JSON.stringify(nodes.map((node) => ({
        id: stableIdOf(node.stableId),
        name: node.diaName,
        labels: node.labels,
        owner: node.callMosaicOwnerStableId,
        role: node.callMosaicRole,
        sequenceOwner: node.sequenceOwnerStableId,
      }))),
    );
    assert.deepEqual(
      (JSON.parse(stateWrite.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['setState('],
    );
    assert.equal(nodes.some((node) => node.diaName === '{' && node.labels.includes('StateValue')), false);
    assert.equal(stateObjectClose.callMosaicRole, 'close');
    const stateClosingBrace = nodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.labels.includes('Close')
      && node.objectBraceMosaicNeighborStableId === stableIdOf(stateObjectClose.stableId)
    ));
    assert.ok(stateClosingBrace, 'the updater object must expose its closing brace');
    assert.ok(edges.some((edge) => (
      edge.type === 'ArgJoin'
      && edge.fromId === stableIdOf(stateClosingBrace.stableId)
      && edge.toId === stableIdOf(stateObjectClose.stableId)
      && edge.semanticExpansion === 'state-update'
    )), 'the updater object closing brace must return to the call closing tile');
    assert.deepEqual(
      (JSON.parse(stateObjectClose.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      [')'],
    );
    assert.equal(stateObjectClose.labels.includes('SubStepAttachment'), false);
    assert.equal(stateWriteClose.labels.includes('SubStepAttachment'), false);
    assert.equal(edges.some((edge) => edge.type === 'ARG' && edge.fromId === stableIdOf(stateWrite.stableId)), false);
    assert.equal(edges.some((edge) => edge.type === 'ArgJoin' && edge.fromId === stableIdOf(stateObjectClose.stableId)), false);
    assert.equal(edges.some((edge) => edge.type === 'WRITES' && edge.fromId === stableIdOf(stateWrite.stableId)), false);
    assert.equal(nodes.some((node) => (
      node.semanticExpansion === 'state-update'
      && node.synthetic === true
      && (node.labels.includes('Store') || node.labels.includes('Storage') || node.labels.includes('ResourceProxy'))
    )), false, 'an unresolved updater must not invent a backing store');
    const stateFields = nodes.filter((node) => node.sequenceOwnerStableId === stableIdOf(stateWrite.stableId));
    const spread = stateFields.find((node) => node.labels.includes('Spread'));
    const valueField = stateFields.find((node) => node.fieldName === 'value');
    assert.deepEqual(
      (JSON.parse(spread?.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['...', 'prev'],
    );
    assert.equal(valueField?.diaName, 'value');
    assert.equal(stableIdOf(valueField?.stableId), stableIdOf(nextValue.stableId));
    assert.ok(edges.some((edge) => edge.type === 'FIELD' && edge.toId === stableIdOf(spread?.stableId) && edge.label === ''));
    assert.ok(edges.some((edge) => edge.type === 'FIELD' && edge.toId === stableIdOf(valueField?.stableId) && edge.label === 'value'));

    const error = nodes.find((node) => node.labels.includes('FailureBinding'));
    const persist = nodes.find((node) => node.actionTextRaw?.startsWith('persist(snapshot)'));
    const report = nodes.find((node) => node.actionTextRaw === 'report(error)');
    assert.equal(error, undefined, 'the catch parameter must remain inside its handler mosaic');
    assert.ok(persist && report, 'the rejected call and its handler must both be extracted');
    assert.ok(edges.some((edge) => (
      edge.type === 'CATCH'
      && edge.fromId === stableIdOf(persist.stableId)
      && edge.toId === stableIdOf(report.stableId)
    )), 'the rejected call must connect directly to its handler');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('array updater callbacks materialize a virtual collection set argument family', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-array-state-updater.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Message = { text: string };
declare function rawSetMessages(next: Message[]): void;
const messagesRef = { current: [] as Message[] };
function setMessages(updater: (prev: Message[]) => Message[]): void {
  const next = updater(messagesRef.current);
  rawSetMessages(next);
}
export function subject(userMessage: Message) {
  setMessages(prev => [...prev, userMessage]);
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
      node.actionTextRaw?.startsWith('setMessages(')
      && node.labels.includes('Call')
      && node.labels.includes('StateUpdateRoot')
    ));
    assert.ok(opening, 'the setMessages opening call must be extracted');
    assert.ok(opening.labels.includes('InlineArgumentFamily'));
    assert.equal(opening.submethodsJson, undefined);
    const openingStableId = stableIdOf(opening.stableId);
    const collection = payload.nodes.find((node) => (
      node.sequenceOwnerStableId === openingStableId
      && node.labels.includes('Collection')
      && node.labels.includes('Virtual')
      && node.containerMethodKind === 'set'
    ));
    assert.ok(collection, 'the updater result must be a virtual result collection with set');
    assert.equal(collection.diaName, 'result');
    assert.deepEqual(
      (JSON.parse(collection.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      ['result', 'set'],
    );
    const collectionStableId = stableIdOf(collection.stableId);
    const collectionParts = JSON.parse(collection.renderPartsJson || '[]') as Array<{ stableId: string; text: string }>;
    const setPartStableId = collectionParts.find((part) => part.text === 'set')?.stableId;
    assert.equal(setPartStableId, `${collectionStableId}:set`);
    const argumentsFromCall = payload.edges
      .filter((edge) => edge.type === 'ARG' && edge.fromId === openingStableId)
      .sort((left, right) => Number(left.argumentIndex) - Number(right.argumentIndex));
    assert.equal(argumentsFromCall.length, 2);
    const spread = payload.nodes.find((node) => stableIdOf(node.stableId) === argumentsFromCall[0].toId);
    const userMessage = payload.nodes.find((node) => stableIdOf(node.stableId) === argumentsFromCall[1].toId);
    assert.deepEqual(
      (JSON.parse(spread?.renderPartsJson || '[]') as Array<{ text: string; kind: string; labels: string[] }>).map((part) => ({
        text: part.text,
        kind: part.kind,
        systemSpread: part.labels.includes('SystemSpread'),
      })),
      [
        { text: 'prev', kind: 'collection-container', systemSpread: false },
        { text: '...', kind: 'operator', systemSpread: true },
      ],
    );
    assert.ok(spread?.labels.includes('Collection'));
    assert.equal(userMessage?.diaName, 'userMessage');
    assert.ok(userMessage?.labels.includes('Variable'));

    assert.equal(payload.nodes.some((node) => node.stableId.stableIdSuffix === 'next-state:set-complete'), false);
    assert.ok(argumentsFromCall.every((argument) => payload.edges.some((edge) => (
      edge.type === 'ArgJoin'
      && edge.fromId === argument.toId
      && edge.toId === collectionStableId
      && edge.targetRenderPartStableId === setPartStableId
    ))));

    const outerClose = payload.nodes.find((node) => (
      node.sourceCallStableId === openingStableId
      && node.callMosaicRole === 'close'
    ));
    assert.ok(outerClose, 'the outer setMessages call must have its own closing node');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'NEXT'
      && edge.fromId === collectionStableId
      && edge.toId === stableIdOf(outerClose.stableId)
    )));
    assert.deepEqual(
      payload.edges.filter((edge) => edge.type === 'ARG' && edge.fromId === openingStableId)
        .map((edge) => edge.toId),
      [stableIdOf(spread!.stableId), stableIdOf(userMessage!.stableId)],
      'the updater protocol replaces, rather than supplements, expansion of the setter implementation',
    );
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === openingStableId
      && edge.type === 'MATERIALIZES_ARGUMENT'
    )), false);
    assert.equal(payload.nodes.some((node) => node.labels.includes('CallbackFn')), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('awaited project methods use an await mosaic without a fallback action node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-awaited-method.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
interface Remote {
  sendMessage(content: string, opts: { uuid: string }): Promise<void>;
}
export async function subject(remote: Remote, content: string, uuid: string) {
  await remote.sendMessage(content, { uuid });
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
      node.actionTextRaw?.startsWith('remote.sendMessage(')
      && node.labels.includes('Call')
      && node.callBoundaryRole === 'open'
    ));
    assert.ok(opening, 'the awaited method opening must be extracted');
    const parts = JSON.parse(opening.renderPartsJson || '[]') as Array<{
      text: string;
      labels: string[];
    }>;
    assert.equal(parts[0]?.text, 'await');
    assert.ok(parts[0]?.labels.includes('System'), 'await must use the system palette');
    const methodPart = parts.find((part) => part.text === 'sendMessage(');
    assert.ok(methodPart, 'the project method opening must remain a separate tile');
    assert.equal(methodPart.labels.includes('System'), false);

    const openingStableId = stableIdOf(opening.stableId);
    const closing = payload.nodes.find((node) => (
      node.sourceCallStableId === openingStableId
      && node.labels.includes('FnVisualProxy')
    ));
    assert.ok(closing, 'the split call must retain its closing node');
    assert.ok(closing.labels.includes('Fn'), `closing labels: ${closing.labels.join(',')}`);
    assert.equal(closing.labels.includes('System'), false);
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('Action')
      && node.labels.includes('Boundary')
      && node.actionTextRaw?.startsWith('await remote.sendMessage(')
    )), false);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('an awaited operation inside try can enter its catch handler', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-awaited-try-catch.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function load(): Promise<string>;
declare function recover(error: unknown): void;
export async function subject() {
  try {
    await load();
  } catch (error: unknown) {
    recover(error);
  }
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
    const awaited = payload.nodes.find((node) => (
      node.labels.includes('Awaited')
      && node.actionTextRaw?.includes('load()')
    ));
    const recovery = payload.nodes.find((node) => node.actionTextRaw?.startsWith('recover('));
    assert.ok(awaited, 'the awaited operation must be extracted');
    assert.ok(recovery, 'the catch handler must be extracted');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'CATCH'
      && edge.fromId === stableIdOf(awaited.stableId)
      && edge.toId === stableIdOf(recovery.stableId)
    )), 'the awaited operation must have an exceptional path into catch');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
