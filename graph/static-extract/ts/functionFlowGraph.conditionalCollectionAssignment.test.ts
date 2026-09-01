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

test('conditional collection initializers preserve the collection protocol and assign alternatives directly', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-conditional-collection.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(imageContents: Array<{ id: string }>) {
  const imagePasteIds = imageContents.length > 0 ? imageContents.map(c => c.id) : undefined;
  return imagePasteIds;
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
      node.operationSubjectText === 'imagePasteIds'
      && node.labels?.includes('ContainerMethod')
      && node.labels?.includes('Set')
    ));
    assert.ok(assignment, 'imagePasteIds assignment container was not extracted');

    const assignmentStableId = stableIdOf(assignment.stableId);
    const assignmentParts = JSON.parse(assignment.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.deepEqual(
      assignmentParts.map((part) => part.text),
      ['imagePasteIds', 'set(', 'result', ')'],
      'the conditional assignment container must expose its result slot',
    );
    assert.equal(assignmentParts[2]?.kind, 'virtual-value');
    assert.ok(assignmentParts[2]?.labels?.includes('Virtual'));
    assert.equal(assignmentParts[1]?.stableId, `${assignmentStableId}:set`);
    assert.equal(assignment.renderPartsLayout, 'container-overlay-side');
    const condition = payload.nodes.find((node) => {
      if (!node.labels?.includes('PredicateOperator')) return false;
      const parts = JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>;
      return parts.map((part) => part.text).join('|') === 'imageContents|length|>|0';
    });
    assert.ok(condition, 'the conditional predicate was not decomposed into render parts');
    const conditionParts = JSON.parse(condition.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.equal(condition.renderPartsLayout, 'container-overlay-side');
    assert.equal(conditionParts[0]?.kind, 'collection-container');
    assert.ok(conditionParts[0]?.labels?.includes('Collection'));
    assert.equal(conditionParts[1]?.kind, 'method');
    assert.ok(conditionParts[1]?.labels?.includes('System'));

    const map = payload.nodes.find((node) => (
      node.collectionMethod === 'map'
      && node.labels?.includes('Op')
      && node.labels?.includes('Method')
    ));
    assert.ok(map, 'map was not expanded as a collection protocol');
    const mapSubmethods = JSON.parse(map.submethodsJson || '[]') as Array<{
      attachments?: Array<{ stableId?: string; placement?: string }>;
    }>;
    const mapAttachments = mapSubmethods.flatMap((submethod) => submethod.attachments || []);
    assert.equal(
      new Set(mapAttachments.map((attachment) => attachment.stableId)).size,
      mapAttachments.length,
      'a collection attachment must not be emitted twice with conflicting placements',
    );
    const shiftNode = payload.nodes.find((node) => node.labels?.includes('Shift'));
    assert.ok(shiftNode, 'the collection shift node was not extracted');
    assert.equal(
      mapAttachments.find((attachment) => attachment.stableId === stableIdOf(shiftNode.stableId))?.placement,
      'right',
      'collection shift must occupy a neighboring subcolumn instead of overlaying the iterator variable',
    );

    const undefinedAlternative = payload.nodes.find((node) => (
      (JSON.parse(node.renderPartsJson || '[]') as Array<{ text?: string }>)
        .map((part) => part.text)
        .join('|') === 'result|set(|undefined|)'
      && payload.edges.some((edge) => (
        edge.fromId === stableIdOf(node.stableId)
        && edge.type === 'YIELDS_VALUE'
        && edge.toId === assignmentStableId
      ))
    ));
    assert.ok(undefinedAlternative, 'undefined alternative does not assign the container directly');
    assert.ok(undefinedAlternative.labels?.includes('Virtual'));
    assert.ok(undefinedAlternative.labels?.includes('ContainerMethod'));
    assert.equal(undefinedAlternative.renderPartsLayout, 'container-overlay-side');
    assert.equal(undefinedAlternative.conditionalAlternativePlacement, 'down');

    const acceptedEdge = payload.edges.find((edge) => (
      edge.type === 'TRUE'
      && edge.fromId === stableIdOf(condition.stableId)
      && edge.toId === stableIdOf(map.stableId)
    ));
    assert.ok(acceptedEdge, 'TRUE must enter the map protocol');
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'FALSE'
      && edge.fromId === stableIdOf(condition.stableId)
      && edge.toId === stableIdOf(undefinedAlternative.stableId)
    )), 'FALSE must enter the undefined alternative');
    assert.equal(
      payload.edges.some((edge) => edge.type === 'XOR_JOIN' && (
        edge.fromId === stableIdOf(map.stableId)
        || edge.fromId === stableIdOf(undefinedAlternative.stableId)
      )),
      false,
      'assignment alternatives must not be routed through an expression XOR join',
    );
    const iterationValue = payload.nodes.find((node) => (
      node.labels?.includes('Iteration')
      && node.labels?.includes('Bind')
      && node.diaName === 'c'
    ));
    assert.ok(iterationValue, 'the iteration value container was not extracted');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(iterationValue.stableId)
      && edge.type === 'NEXT'
    )), 'the iteration value set must continue directly into the callback through NEXT');
    assert.equal(payload.nodes.some((node) => node.labels?.includes('IterationGuard')), false);
    assert.equal(
      payload.nodes.some((node) => node.diaName === 'map result'),
      false,
      'a collection transform must not duplicate its push accumulator as a map result node',
    );
    const pushResult = payload.nodes.find((node) => (
      node.diaName === 'result'
      && node.labels?.includes('CallbackResult')
      && node.labels?.includes('Collection')
    ));
    assert.ok(pushResult, 'the map result collection was not materialized');
    assert.ok(pushResult.labels?.includes('Virtual'));
    assert.equal(
      payload.edges.some((edge) => (
        edge.toId === assignmentStableId
        && edge.type === 'ASSIGNS_VALUE'
        && [stableIdOf(pushResult.stableId), stableIdOf(undefinedAlternative.stableId)].includes(edge.fromId)
      )),
      false,
      'conditional alternatives must not manufacture value-assignment edges',
    );
    const resultParts = JSON.parse(pushResult.renderPartsJson || '[]') as Array<{
      text?: string;
      fillState?: string;
    }>;
    assert.equal(resultParts[0]?.text, 'result');
    assert.equal(resultParts[0]?.fillState, 'empty');
    assert.equal(resultParts[1]?.text, 'push(');
    assert.deepEqual(
      resultParts.map((part) => part.text),
      ['result', 'push(', 'c', '.id', ')'],
      'a simple callback value and the push closing boundary must be extracted as one result mosaic node',
    );
    assert.equal(resultParts[1]?.stableId, `${stableIdOf(pushResult.stableId)}:push`);
    assert.equal(
      payload.nodes.some((node) => node.diaName === 'c.id'),
      false,
      'a callback value folded into push must not be duplicated as a graph node',
    );
    assert.equal(
      payload.nodes.some((node) => (
        node.callMosaicOwnerStableId === stableIdOf(pushResult.stableId)
        && node.callMosaicRole === 'close'
      )),
      false,
      'the closing push tile belongs to the result node rather than a separate graph node',
    );
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(iterationValue.stableId)
      && edge.toId === stableIdOf(pushResult.stableId)
      && edge.type === 'NEXT'
    )), 'the iteration value must continue directly into the combined result.push mosaic');
    const repeat = payload.edges.find((edge) => edge.type === 'REPEATS');
    assert.ok(repeat, 'the collection protocol must expose its repeat edge');
    assert.equal(repeat.label, 'repeat');
    assert.equal(repeat.displayLabel, 'repeat');
    assert.equal(repeat.sourceRenderPartStableId, `${stableIdOf(pushResult.stableId)}:push`);
    const conditionalReturns = payload.edges.filter((edge) => (
      edge.toId === assignmentStableId
      && ['YIELDS_VALUE', 'FALSE'].includes(edge.type)
      && edge.semanticExpansion === 'conditional-assignment'
    ));
    assert.ok(conditionalReturns.length > 0);
    assert.ok(conditionalReturns.every((edge) => edge.protocolRole === 'assignment-return'));
    const undefinedReturn = conditionalReturns.find((edge) => (
      edge.fromId === stableIdOf(undefinedAlternative.stableId)
    ));
    assert.equal(undefinedReturn?.type, 'YIELDS_VALUE');
    assert.equal(undefinedReturn?.flowLayer, 'data');
    assert.equal(undefinedReturn?.label, 'value');
    assert.equal(
      payload.edges.some((edge) => (
        edge.fromId === stableIdOf(pushResult.stableId)
        && edge.toId === assignmentStableId
      )),
      false,
      'an iteration push must not return directly to the set method',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('direct collection emissions address the embedded push part without locking route ports', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-direct-filter.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(items: Array<{ active: boolean }>) {
  const selected = items.filter(item => item.active);
  return selected;
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
    const selected = payload.nodes.find((node) => (
      node.operationSubjectText === 'selected'
      && node.labels?.includes('CollectionMutation')
    ));
    assert.ok(selected);
    const selectedStableId = stableIdOf(selected.stableId);
    const accepted = payload.edges.find((edge) => (
      edge.type === 'TRUE'
      && edge.toId === selectedStableId
      && edge.semanticExpansion === 'collection-iteration'
    ));
    assert.ok(accepted);
    assert.equal(accepted.targetRenderPartStableId, `${selectedStableId}:push`);
    assert.equal(accepted.lockPortCandidates, undefined);
    const parts = JSON.parse(selected.renderPartsJson || '[]') as Array<{ stableId?: string; text?: string }>;
    assert.equal(parts.find((part) => part.text?.startsWith('push'))?.stableId, `${selectedStableId}:push`);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('ordinary conditional values return directly to set without a synthetic result node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-conditional-value.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(trimmedInput: string, spaceIndex: number) {
  const commandName = spaceIndex === -1
    ? trimmedInput.slice(1)
    : trimmedInput.slice(1, spaceIndex);
  return commandName;
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
      node.operationSubjectText === 'commandName'
      && node.labels?.includes('ContainerMethod')
      && node.labels?.includes('Set')
    ));
    assert.ok(assignment, 'commandName set container was not extracted');
    const assignmentStableId = stableIdOf(assignment.stableId);
    const assignmentParts = JSON.parse(assignment.renderPartsJson || '[]') as Array<{
      text?: string;
      fillState?: string;
    }>;
    assert.deepEqual(
      assignmentParts.map((part) => part.text),
      ['commandName', 'set'],
      'an ordinary conditional assignment must not invent a result slot',
    );
    assert.equal(assignmentParts[0]?.fillState, 'empty');
    assert.equal(
      payload.nodes.some((node) => node.resultOfCallStableId && node.diaName === 'slice\nresult'),
      false,
      'terminal alternative calls must not create a separate result node',
    );
    const returns = payload.edges.filter((edge) => (
      edge.toId === assignmentStableId && edge.type === 'ASSIGNS_VALUE'
    ));
    assert.equal(returns.length, 2, 'both alternatives must return their values directly to set');
    const nodeByStableId = new Map(payload.nodes.map((node) => [stableIdOf(node.stableId), node]));
    const trueReturn = returns.find((edge) => edge.producerOutcome === 'true');
    const falseReturn = returns.find((edge) => edge.producerOutcome === 'false');
    assert.deepEqual(
      new Set(returns.map((edge) => edge.producerOutcome)),
      new Set(['true', 'false']),
      'optional returns must retain their DataBranch outcomes independently of layout',
    );
    assert.equal(
      new Set(returns.map((edge) => edge.optionalReturnGroupStableId)).size,
      1,
      'both optional returns must be coordinated as one routing group',
    );
    assert.ok(
      returns.every((edge) => edge.producerRouteRole === undefined),
      'the extractor must leave top/bottom routing to final positioned geometry',
    );
    assert.match(
      String(nodeByStableId.get(falseReturn?.fromId || '')?.actionTextRaw || ''),
      /slice\(1, spaceIndex\)/u,
      'the false outcome must remain attached to its expression',
    );
    assert.match(
      String(nodeByStableId.get(trueReturn?.fromId || '')?.actionTextRaw || ''),
      /slice\(1\)/u,
      'the true outcome must remain attached to its expression',
    );
    const returnSources = new Set(returns.map((edge) => edge.fromId));
    assert.equal(
      payload.edges.some((edge) => (
        returnSources.has(edge.fromId)
        && edge.toId === assignmentStableId
        && edge.type === 'NEXT'
      )),
      false,
      'the same alternatives must not also enter set through control NEXT',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a nullish call argument exposes mutually exclusive left and fallback returns', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-nullish-call-argument.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(envValue: string | undefined) {
  const threshold = Number(envValue ?? 75);
  return threshold;
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
    const branch = payload.nodes.find((node) => (
      node.labels?.includes('Branch')
      && node.labels?.includes('Data')
      && node.diaName === '??'
    ));
    assert.ok(branch, 'the nullish argument must be extracted as a DataBranch');
    const branchStableId = stableIdOf(branch.stableId);
    const parts = JSON.parse(branch.renderPartsJson || '[]') as Array<{
      stableId?: string;
      text?: string;
    }>;
    assert.deepEqual(parts.map((part) => part.text), ['Number(', 'envValue', '??', '75', ')']);

    const assignment = payload.nodes.find((node) => (
      node.operationSubjectText === 'threshold'
      && node.labels?.includes('Set')
    ));
    assert.ok(assignment);
    const assignmentStableId = stableIdOf(assignment.stableId);

    const outcomes = payload.edges.filter((edge) => (
      edge.fromId === branchStableId
      && edge.toId === assignmentStableId
      && edge.type === 'ASSIGNS_VALUE'
    ));
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((edge) => edge.diaName === 'value'));
    assert.equal(
      outcomes.find((edge) => edge.producerOutcome === 'true')?.sourceRenderPartStableId,
      parts[1]?.stableId,
      'the non-nullish value must return from the left tile',
    );
    assert.equal(
      outcomes.find((edge) => edge.producerOutcome === 'false')?.sourceRenderPartStableId,
      parts[3]?.stableId,
      'the fallback value must return from the right tile',
    );
    for (const outcome of outcomes) {
      assert.equal(
        outcome.producerRouteRole,
        outcome.producerOutcome === 'true' ? 'return-top' : 'return-bottom',
      );
      assert.ok(outcome.optionalReturnGroupStableId);
    }
    assert.equal(outcomes[0].optionalReturnGroupStableId, outcomes[1].optionalReturnGroupStableId);
    const assignmentReturn = outcomes[0];
    assert.ok(
      Number(assignmentReturn.producerScopeEndOrder) >= Number(branch.operationIndex),
      'the assignment return scope must include its nested nullish family',
    );
    assert.ok(
      assignmentReturn.producerScopeStableIds?.includes(stableIdOf(branch.stableId)),
      'the assignment return scope must explicitly include its nested nullish family',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a call alternative in an object field is nested below its owning DataBranch family', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-object-field-call.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
function prependModeCharacterToInput(input: string, mode: string) {
  return mode + input;
}

function addToHistory(value: { display: string; pastedContents: object }) {
  void value;
}

export function subject(input: string, inputMode: string, speculationAccept?: object, pastedContents: object = {}) {
  addToHistory({
    display: speculationAccept ? input : prependModeCharacterToInput(input, inputMode),
    pastedContents: speculationAccept ? {} : pastedContents,
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
    const branch = payload.nodes.find((node) => (
      node.labels?.includes('Branch')
      && node.labels?.includes('Field')
      && node.conditionRaw === 'speculationAccept'
      && String(node.operationValueText || '').includes('prependModeCharacterToInput')
    ));
    assert.ok(branch, 'the field conditional must be extracted as a DataBranch');
    assert.ok(branch.labels?.includes('Data'));
    const branchStableId = stableIdOf(branch.stableId);
    const displayedOutcomes = payload.edges.filter((edge) => (
      edge.fromId === branchStableId && (edge.type === 'TRUE' || edge.type === 'FALSE')
    ));
    assert.ok(displayedOutcomes.length >= 2);
    assert.ok(displayedOutcomes.every((edge) => (
      edge.displayLabel === edge.type.toLowerCase()
      && edge.diaName === edge.type.toLowerCase()
    )), 'TRUE/FALSE remain graph types but use lowercase diagram labels');

    const call = payload.nodes.find((node) => (
      node.dataBranchOwnerStableId === branchStableId
      && node.dataBranchFamilyRole === 'nested-call'
    ));
    assert.ok(call, 'the call alternative must retain its owning DataBranch');
    const callStableId = stableIdOf(call.stableId);

    const result = payload.nodes.find((node) => (
      node.dataBranchOwnerStableId === branchStableId
      && node.dataBranchFamilyRole === 'alternative-result'
    ));
    assert.ok(result, 'the call result must be represented by an awaiting container');
    assert.ok(result.labels?.includes('Virtual'));
    assert.ok(result.labels?.includes('ContainerMethod'));
    assert.equal(result.nestedEvaluationDirection, 'down');
    assert.deepEqual(
      JSON.parse(result.renderPartsJson || '[]').map((part: { text?: string }) => part.text),
      ['prependModeCharacterToInput\nresult', 'set'],
    );
    const resultStableId = stableIdOf(result.stableId);
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === branchStableId
      && edge.toId === resultStableId
      && edge.type === 'FALSE'
    )), 'the DataBranch alternative must enter the awaiting result container');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === resultStableId
      && edge.toId === callStableId
      && edge.type === 'EVAL'
    )), 'the nested call must start below the awaiting result through EVAL');
    const resultReturn = payload.edges.find((edge) => (
      edge.toId === resultStableId
      && edge.type === 'RESULT'
      && edge.displayLabel === 'value'
      && edge.diaName === 'value'
    ));
    assert.ok(resultReturn, 'the nested call return keeps RESULT semantics but is displayed as value');
    assert.equal(
      resultReturn.targetRenderPartStableId,
      `${resultStableId}:set`,
      'the returned value must target the virtual set part instead of the empty container',
    );
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === branchStableId
      && edge.toId === callStableId
      && edge.type === 'FALSE'
    )), false, 'the DataBranch must not flatten the nested call into its senior family');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
