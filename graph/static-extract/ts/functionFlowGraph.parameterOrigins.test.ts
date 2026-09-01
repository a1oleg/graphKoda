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

test('call sites own direct and JSX callback arguments without crossing into formal parameters', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-parameter-origins.fixture.tsx');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type ChildProps = { onSubmit: (input: string) => void };
type Helpers = { clear(): void };

export function target(input: string, helpers?: Helpers) {
  helpers?.clear();
  return input.length;
}

export function Child(props: ChildProps) {
  const { onSubmit } = props;
  const value = 'from child';
  onSubmit(value);
  return null;
}

export function Caller() {
  target('direct', { clear: () => {} });
  return <Child onSubmit={target} />;
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
    });
    const payload = extractFunctionFlowGraphs(program);
    const targetFn = payload.functions.find((fn) => fn.name === 'target');
    assert.ok(targetFn, 'target function was not extracted');
    const targetFnStableId = stableIdOf(targetFn.stableId);
    const scopedPayload = extractFunctionFlowGraphs(program, targetFnStableId);
    assert.ok(
      (scopedPayload.semanticEntities?.length || 0) < (payload.semanticEntities?.length || 0),
      'a scoped function extraction must not emit the complete repository semantic graph',
    );
    assert.ok(scopedPayload.semanticEntities?.some((entity) => entity.props.name === 'Helpers'));
    const parameter = payload.nodes.find((node) => (
      node.parentFnStableId.value === targetFnStableId
      && node.labels.includes('Parameter')
      && node.parameterName === 'input'
    ));
    assert.ok(parameter, 'target input parameter was not extracted');
    const parameterStableIds = new Set(payload.nodes.filter((node) => (
      node.parentFnStableId.value === targetFnStableId && node.labels.includes('Parameter')
    )).map((node) => stableIdOf(node.stableId)));
    assert.ok(!payload.edges.some((edge) => (
      edge.type === 'PASSES_VALUE' && parameterStableIds.has(edge.toId)
    )), 'call arguments must not jump across the function boundary into formal parameters');

    const targetCalls = payload.edges.filter((edge) => (
      edge.type === 'CALL'
      && edge.toId === targetFnStableId
      && edge.callSiteStableId
      && ['direct invocation', 'callback invocation'].includes(edge.protocolRole || '')
    ));
    assert.equal(targetCalls.length, 2);
    assert.ok(targetCalls.every((edge) => (
      edge.fromId === edge.callSiteStableId
      && !edge.fromId.endsWith(':parameter-origin-call-site')
    )), 'the concrete call occurrence must own the invocation edge');
    assert.ok(!payload.edges.some((edge) => (
      edge.type === 'CALL'
      && edge.fromKind === 'Fn'
      && edge.toKind === 'Fn'
      && edge.toId === targetFnStableId
    )), 'parameter provenance must not jump directly from caller head to callee head');
    const inputArguments = targetCalls.flatMap((call) => payload.edges.filter((edge) => (
      edge.type === 'MATERIALIZES_ARGUMENT'
      && edge.fromId === call.callSiteStableId
      && edge.argumentIndex === 0
    )));
    assert.equal(inputArguments.length, 2, 'each call site must own its first argument');
    const inputArgumentNodes = inputArguments.map((edge) => (
      payload.nodes.find((node) => stableIdOf(node.stableId) === edge.toId)
    ));
    assert.ok(inputArgumentNodes.every((node) => !node?.labels.includes('ArgumentOccurrence')));
    const valueBinding = inputArgumentNodes.find((node) => (
      node?.labels.includes('ValueSlot')
      && node.valueName === 'value'
    ));
    assert.ok(valueBinding, 'the callback call site must reference the original value binding');

    assert.ok(payload.edges.some((edge) => (
      edge.type === 'CALL'
      && edge.toId === targetFnStableId
      && edge.protocolRole === 'callback invocation'
      && edge.callSiteStableId
    )), 'callback invocation must resolve to the concrete callback function');

    const helpersParameter = payload.nodes.find((node) => (
      node.parentFnStableId.value === targetFnStableId
      && node.labels.includes('Parameter')
      && node.parameterName === 'helpers'
    ));
    assert.ok(helpersParameter);
    assert.ok(!payload.edges.some((edge) => (
      edge.type === 'READS_VALUE'
      && edge.toId === stableIdOf(helpersParameter.stableId)
    )), 'member uses must not jump directly to the parameter tile');
    const clearMemberReference = payload.semanticEntities?.find((entity) => (
      entity.labels.includes('MemberReference') && entity.props.name === 'clear'
    ));
    assert.ok(clearMemberReference);
    const clearUse = payload.semanticRelationships?.find((relationship) => (
      relationship.type === 'USES_MEMBER_REFERENCE'
      && relationship.toId === clearMemberReference.stableId
    ));
    assert.ok(clearUse, 'the call must first point to its MemberReference');
    assert.ok(payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'RESOLVES_TO'
      && relationship.fromId === clearMemberReference.stableId
      && payload.semanticEntities?.some((entity) => (
        entity.stableId === relationship.toId
        && entity.labels.includes('MemberDeclaration')
        && entity.props.name === 'clear'
      ))
    )), 'the MemberReference must resolve to the canonical MemberDeclaration');
    const directCall = targetCalls.find((edge) => edge.protocolRole === 'direct invocation');
    assert.ok(directCall?.callSiteStableId);
    const helpersArgument = payload.edges.find((edge) => (
      edge.type === 'MATERIALIZES_ARGUMENT'
      && edge.fromId === directCall.callSiteStableId
      && edge.argumentIndex === 1
    ));
    assert.ok(helpersArgument);
    const objectOriginal = payload.nodes.find((node) => stableIdOf(node.stableId) === helpersArgument.toId);
    assert.ok(objectOriginal?.labels.includes('ObjectConstruction'));
    assert.match(String(objectOriginal?.actionTextRaw), /clear/);
    const helpersTypeDeclaration = payload.semanticEntities?.find((entity) => (
      entity.labels.includes('TypeDeclaration') && entity.props.name === 'Helpers'
    ));
    assert.ok(helpersTypeDeclaration);
    assert.equal(objectOriginal?.canonicalStableId, helpersTypeDeclaration.stableId);
    assert.ok(!payload.nodes.some((node) => (
      node.parameterOriginTargetFnStableId === targetFnStableId
      && node.labels.includes('ArgumentOccurrence')
    )));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('parameters compose received variables with primitive, provider, and explicit object types', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-parameter-shape.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Options = { visible: boolean; hidden: string };
type Helpers = { clear(): void; reset: () => void };

export function subject(
  input: string,
  helpers: Helpers,
  named: Options,
  inline: { first: string; second: number },
  { visible }: Options,
) {
  return named.visible && inline.first.length > 0 && visible;
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
    const subjectFn = payload.functions.find((fn) => fn.name === 'subject');
    assert.ok(subjectFn);
    const subjectFnStableId = stableIdOf(subjectFn.stableId);
    const subjectNodes = payload.nodes.filter((node) => (
      node.parentFnStableId.value === subjectFnStableId
    ));
    const parameters = subjectNodes.filter((node) => (
      node.parentFnStableId.value === subjectFnStableId
      && node.labels.includes('Parameter')
    ));

    assert.deepEqual(
      parameters.map((node) => node.parameterName).sort(),
      ['helpers', 'inline', 'input', 'named', '{ visible }'],
    );
    assert.ok(parameters.every((node) => node.diaName === node.parameterName));
    assert.ok(parameters.every((node) => !node.labels.includes('Variable')));
    assert.ok(parameters.every((node) => !node.labels.includes('ValueAccess')));
    assert.ok(parameters.every((node) => !node.labels.includes('ValueReceive')));
    assert.ok(parameters.every((node) => !node.labels.includes('ParameterBinding')));

    const input = parameters.find((node) => node.parameterName === 'input');
    const inputParts = JSON.parse(String(input?.renderPartsJson || '[]'));
    assert.deepEqual(inputParts.map((part: { text: string }) => part.text), ['input', 'TYPED_AS(', 'string', ')']);
    assert.ok(inputParts[2].labels.includes('System'));
    const functionStart = subjectNodes.find((node) => node.labels.includes('FunctionStart'));
    assert.ok(functionStart, 'the executable flow must have a distinct function start event');
    assert.ok(payload.edges.some((edge) => (
      edge.fromKind === 'Fn'
      && edge.fromId === subjectFnStableId
      && edge.toId === stableIdOf(functionStart.stableId)
      && edge.type === 'NEXT'
      && edge.contextOnly === true
    )));
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(functionStart.stableId)
      && edge.toId === stableIdOf(input?.stableId)
      && edge.type === 'NEXT'
    )));
    assert.ok(!payload.edges.some((edge) => (
      edge.fromKind === 'Fn'
      && edge.fromId === subjectFnStableId
      && edge.type === 'PARAM'
    )));
    assert.ok(payload.edges.some((edge) => (
      edge.fromKind === 'Fn'
      && edge.fromId === subjectFnStableId
      && edge.toId === stableIdOf(input?.stableId)
      && edge.type === 'RECEIVES_VALUE'
    )));

    const helpers = parameters.find((node) => node.parameterName === 'helpers');
    const helpersParts = JSON.parse(String(helpers?.renderPartsJson || '[]'));
    assert.ok(!helpers?.labels.includes('OperationProvider'));
    assert.ok(!helpers?.labels.includes('CapabilityBundle'));
    assert.ok(helpers?.labels.includes('ValueSlot'));
    assert.equal(helpersParts[0].kind, 'operation-provider-container');
    assert.ok(helpersParts[0].labels.includes('OperationProvider'));
    assert.ok(helpersParts[0].labels.includes('CapabilityBundle'));
    assert.deepEqual(helpersParts.map((part: { text: string }) => part.text), ['helpers', 'TYPED_AS(', 'Helpers', ')']);
    assert.deepEqual(helpersParts[2].labels, ['Type', 'DeveloperDefined']);
    const helpersTypeDeclaration = payload.semanticEntities.find((entity) => (
      entity.labels.includes('TypeDeclaration')
      && entity.props.name === 'Helpers'
    ));
    assert.ok(helpersTypeDeclaration, 'Helpers must have a canonical type declaration');
    assert.ok(helpersTypeDeclaration.labels.includes('OperationProvider'));
    assert.ok(helpersTypeDeclaration.labels.includes('CapabilityBundle'));
    assert.equal(
      helpersParts[2].canonicalStableId,
      helpersTypeDeclaration.stableId,
      'the rendered type tile must link to the canonical declaration',
    );
    const helpersValueDeclaration = payload.semanticEntities.find((entity) => (
      entity.labels.includes('ValueDeclaration')
      && entity.props.name === 'helpers'
      && entity.props.declarationKind === 'Parameter'
    ));
    assert.ok(helpersValueDeclaration);
    assert.equal(helpersValueDeclaration.stableId, stableIdOf(helpers?.stableId));
    assert.doesNotMatch(helpersValueDeclaration.stableId, /:parameter$/);
    assert.ok(helpersValueDeclaration.labels.includes('Parameter'));
    assert.ok(helpersValueDeclaration.labels.includes('ValueSlot'));
    const helpersTypeReference = payload.semanticEntities.find((entity) => (
      entity.labels.includes('TypeReference') && entity.props.name === 'Helpers'
    ));
    assert.ok(helpersTypeReference);
    assert.ok(!payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'PROXY_OF'
      && relationship.fromId === stableIdOf(helpers?.stableId)
    )));
    assert.ok(payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'TYPED_AS'
      && relationship.fromId === helpersValueDeclaration.stableId
      && relationship.toId === helpersTypeDeclaration.stableId
    )));
    assert.ok(payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'RESOLVES_TO'
      && relationship.fromId === helpersTypeReference.stableId
      && relationship.toId === helpersTypeDeclaration.stableId
    )));

    const inline = parameters.find((node) => node.parameterName === 'inline');
    assert.ok(inline?.labels.includes('Object'));
    assert.deepEqual(
      JSON.parse(String(inline?.renderPartsJson || '[]')).map((part: { text: string }) => part.text),
      ['inline', 'TYPED_AS('],
    );

    const parameterFields = subjectNodes.filter((node) => (
      node.labels.includes('Field') && !node.labels.includes('Join')
    ));
    assert.deepEqual(
      parameterFields.map((node) => node.fieldName).sort(),
      ['first', 'second'],
    );
    assert.ok(parameterFields.every((node) => (
      JSON.parse(String(node.renderPartsJson || '[]'))
        .every((part: { labels?: string[] }) => !part.labels?.includes('FieldName'))
    )));
    const firstField = parameterFields.find((node) => node.fieldName === 'first');
    assert.deepEqual(
      JSON.parse(String(firstField?.renderPartsJson || '[]')).map((part: { text: string }) => part.text),
      [':', 'string'],
    );
    assert.ok(payload.edges.some((edge) => (
      edge.type === 'FIELD'
      && edge.toId === stableIdOf(firstField?.stableId)
      && edge.displayLabel === 'first'
    )));
    const inlineTypeOpening = subjectNodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.labels.includes('Open')
      && node.objectBraceMosaicNeighborStableId === stableIdOf(inline?.stableId)
    ));
    assert.ok(inlineTypeOpening, 'the expanded parameter type must have an opening brace');
    const inlineTypeOwnershipEdges = payload.edges.filter((edge) => edge.type === 'AST_CHILD');
    assert.ok(inlineTypeOwnershipEdges.some((edge) => (
      edge.fromId === stableIdOf(inline?.stableId)
      && edge.toId === stableIdOf(inlineTypeOpening.stableId)
      && edge.type === 'AST_CHILD'
      && edge.semanticExpansion === 'expanded-parameter-type'
      && edge.contextOnly === true
    )), `the parameter must structurally own its expanded type family: ${JSON.stringify(inlineTypeOwnershipEdges)}`);
    const inlineTypeClosing = subjectNodes.find((node) => (
      node.labels.includes('TypeAnnotation')
      && node.labels.includes('Virtual')
      && node.labels.includes('Finish')
      && node.diaName === ')'
      && stableIdOf(node.stableId).startsWith(`${stableIdOf(inline?.stableId)}:typed-as-close`)
    ));
    assert.ok(inlineTypeClosing, 'the expanded TYPED_AS group must materialize its virtual closing parenthesis');
    const inlineTypeRightBrace = subjectNodes.find((node) => (
      node.labels.includes('ObjectBrace')
      && node.labels.includes('Close')
      && node.objectBraceMosaicNeighborStableId === stableIdOf(inlineTypeClosing.stableId)
    ));
    assert.ok(inlineTypeRightBrace, 'the closing parenthesis must follow the expanded object family');
    assert.ok(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(inlineTypeRightBrace.stableId)
      && edge.toId === stableIdOf(inlineTypeClosing.stableId)
      && edge.type === 'AST_CHILD'
      && edge.contextOnly === true
    )));

    const destructured = parameters.find((node) => node.parameterName === '{ visible }');
    assert.ok(destructured?.labels.includes('BindingPattern'));
    assert.ok(!destructured?.labels.includes('ValueSlot'));
    assert.deepEqual(
      JSON.parse(String(destructured?.renderPartsJson || '[]')).map((part: { text: string }) => part.text),
      ['{ visible }', 'TYPED_AS(', '{', 'visible', ':', 'boolean', '}', ')'],
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
