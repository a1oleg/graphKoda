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

test('an inline updater callback links captured values through its extracted argument family', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-inline-updater-references.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(setItems: (update: (previous: string[]) => string[]) => void) {
  const userMessage = 'hello';
  setItems(previous => [...previous, userMessage]);
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
    const userMessageReference = payload.semanticRelationships?.find((relationship) => (
      relationship.type === 'RESOLVES_TO'
      && relationship.toId.includes(':3:8:3:29')
      && payload.semanticRelationships?.some((usage) => (
        usage.type === 'USES_REFERENCE'
        && usage.toId === relationship.fromId
      ))
    ));
    assert.ok(userMessageReference, 'the captured callback value must have a canonical reference');
    assert.ok(payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'USES_REFERENCE'
      && relationship.toId === userMessageReference.fromId
    )), 'the updater argument family must own the captured callback reference');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a typed empty array declaration is one open collection with a declare mosaic', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-empty-array-declaration.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type ContentBlockParam = { type: string };
export function subject() {
  const contentBlocks: ContentBlockParam[] = [];
  const promises: Promise<string>[] = [];
  const remoteBlocks: Array<{
    type: string;
    [key: string]: unknown;
  }> = [];
  return contentBlocks;
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
    const declaration = payload.nodes.find((node) => (
      node.operationSubjectText === 'contentBlocks'
      && node.containerMethodKind === 'declare'
    ));
    assert.ok(declaration, 'the collection declaration node was not extracted');
    const declarationId = stableIdOf(declaration.stableId);
    assert.ok(declaration.labels.includes('Collection'));
    assert.ok(declaration.labels.includes('Declaration'));
    assert.ok(declaration.labels.includes('ValueCreate'));
    assert.equal(declaration.labels.includes('Set'), false);
    assert.equal(declaration.containerState, 'assigned');
    assert.equal(declaration.operationValueText, 'ContentBlockParam[] = []');
    assert.equal(declaration.renderPartsLayout, 'container-overlay-side');

    const parts = JSON.parse(String(declaration.renderPartsJson || '[]')) as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
      fillState?: string;
    }>;
    assert.deepEqual(parts.map((part) => part.text), [
      'contentBlocks', 'declare(', 'ContentBlockParam', '[]', '=', '[]', ')',
    ]);
    assert.equal(parts[0].kind, 'collection-container');
    assert.equal(parts[0].fillState, 'empty');
    assert.ok(parts[1].labels?.includes('Virtual'));
    assert.ok(parts[2].labels?.includes('DeveloperDefined'));
    assert.ok(parts[6].labels?.includes('Virtual'));
    const systemTypeDeclaration = payload.nodes.find((node) => (
      node.operationSubjectText === 'promises'
      && node.containerMethodKind === 'declare'
    ));
    assert.ok(systemTypeDeclaration);
    const systemTypeParts = JSON.parse(String(systemTypeDeclaration.renderPartsJson || '[]')) as Array<{
      text?: string;
      labels?: string[];
    }>;
    assert.equal(
      systemTypeParts.find((part) => part.text === 'Promise<string>')?.labels?.includes('DeveloperDefined'),
      false,
      'TypeScript library types must not be classified as developer-defined',
    );
    const remoteDeclaration = payload.nodes.find((node) => (
      node.operationSubjectText === 'remoteBlocks'
      && node.containerMethodKind === 'declare'
    ));
    assert.ok(remoteDeclaration);
    const remoteId = stableIdOf(remoteDeclaration.stableId);
    const remoteOpenParts = JSON.parse(String(remoteDeclaration.renderPartsJson || '[]')) as Array<{
      text?: string;
      labels?: string[];
    }>;
    assert.deepEqual(remoteOpenParts.map((part) => part.text), ['remoteBlocks', 'declare(', 'Array<']);
    assert.ok(remoteOpenParts[2].labels?.includes('System'));
    const remoteClose = payload.nodes.find((node) => stableIdOf(node.stableId) === `${remoteId}:declare-close`);
    assert.ok(remoteClose);
    const remoteCloseParts = JSON.parse(String(remoteClose.renderPartsJson || '[]')) as Array<{
      text?: string;
      labels?: string[];
    }>;
    assert.deepEqual(remoteCloseParts.map((part) => part.text), ['>', '=', '[]', ')']);
    assert.ok(remoteCloseParts[0].labels?.includes('System'));
    assert.ok(remoteCloseParts[3].labels?.includes('Virtual'));
    assert.equal(remoteClose.labels.includes('ValueAccess'), false);
    assert.equal(remoteClose.labels.includes('ValueCreate'), false);
    const typeFields = payload.nodes.filter((node) => (
      node.labels.includes('ObjectTypeField')
      && node.objectFamilyStableId?.startsWith(`${remoteId}:declared-element-type`)
    ));
    assert.equal(typeFields.length, 2);
    assert.equal(typeFields.some((node) => node.labels.includes('ValueAccess')), false);
    assert.equal(typeFields.some((node) => node.labels.includes('ValueCreate')), false);
    const indexSignature = typeFields.find((node) => node.labels.includes('IndexSignature'));
    assert.ok(indexSignature);
    assert.deepEqual(
      (JSON.parse(String(indexSignature.renderPartsJson || '[]')) as Array<{ text?: string }>).map((part) => part.text),
      ['[', 'key', ':', 'string', ']', ':', 'unknown'],
    );
    const typeBraces = payload.nodes.filter((node) => (
      node.labels.includes('ObjectBrace')
      && node.labels.includes('ObjectType')
      && node.objectFamilyStableId?.startsWith(`${remoteId}:declared-element-type`)
    ));
    assert.equal(typeBraces.length, 2);
    const rightTypeBrace = typeBraces.find((node) => node.objectBraceSide === 'right');
    assert.ok(rightTypeBrace);
    assert.equal(rightTypeBrace.objectBraceMosaicNeighborStableId, `${remoteId}:declare-close`);
    assert.equal(payload.edges.filter((edge) => (
      edge.type === 'FIELD' && typeBraces.some((brace) => stableIdOf(brace.stableId) === edge.fromId)
    )).length, 2);
    assert.equal(payload.edges.filter((edge) => (
      edge.type === 'FieldJoin' && typeBraces.some((brace) => stableIdOf(brace.stableId) === edge.toId)
    )).length, 2);
    assert.equal(
      payload.edges.some((edge) => (
        (edge.fromId === remoteId || edge.toId === remoteId)
        && (edge.type === 'EVAL' || edge.type === 'ASSIGNS_VALUE')
      )),
      false,
    );
    assert.equal(
      payload.nodes.some((node) => (
        stableIdOf(node.stableId) !== declarationId
        && (node.diaName === '[]' || node.actionTextRaw === '[]')
      )),
      false,
      'the empty initializer must remain a tile of the declaration node',
    );
    assert.equal(
      payload.edges.some((edge) => (
        (edge.fromId === declarationId || edge.toId === declarationId)
        && (edge.type === 'EVAL' || edge.type === 'ASSIGNS_VALUE')
      )),
      false,
      'the declaration must not create technical evaluation or assignment edges',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('an array-valued initializer marks its local result as a collection', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-array-valued-initializer.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(pastedContents: Record<string, string>) {
  const pastedValues = Object.values(pastedContents);
  const imageContents = pastedValues.filter(value => value === 'image');
  return imageContents;
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
    const pastedValues = payload.nodes.find((node) => (
      node.operationSubjectText === 'pastedValues'
      && node.labels?.includes('ValueSlot')
      && node.labels?.includes('Set')
    ));
    assert.ok(pastedValues, 'pastedValues assignment container was not extracted');
    assert.ok(pastedValues.labels.includes('Collection'));

    const parts = JSON.parse(String(pastedValues.renderPartsJson || '[]')) as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.equal(parts[0]?.text, 'pastedValues');
    assert.equal(parts[0]?.kind, 'collection-container');
    assert.ok(parts[0]?.labels?.includes('Collection'));

    const filter = payload.nodes.find((node) => (
      node.collectionMethod === 'filter'
      && node.primitiveKind === 'iterate'
    ));
    assert.ok(filter, 'the filter collection protocol was not extracted');
    assert.equal(
      filter.valueSlotStableId,
      stableIdOf(pastedValues.stableId),
      'a collection method must retain the canonical input collection binding',
    );
    assert.equal(
      payload.edges.some((edge) => edge.type === 'READS_VALUE' && edge.fromId === stableIdOf(filter.stableId)),
      false,
      'the semantic binding pointer must not create a rendered technical edge',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('object field labels are emitted only for explicit non-redundant names', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-object-field-labels.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: unknown): void;
export function subject(same: string, renamed: string) {
  consume({ same, renamed: renamed, explicit: renamed });
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
    const fieldEdges = payload.edges
      .filter((edge) => edge.type === 'FIELD')
      .sort((left, right) => Number(left.fieldIndex) - Number(right.fieldIndex));
    assert.equal(fieldEdges.length, 3);
    assert.equal(fieldEdges[0].fieldName, undefined);
    assert.equal(fieldEdges[0].displayLabel, '');
    assert.equal(fieldEdges[1].fieldName, 'renamed');
    assert.equal(fieldEdges[1].displayLabel, '');
    assert.equal(fieldEdges[2].fieldName, 'explicit');
    assert.equal(fieldEdges[2].displayLabel, 'explicit');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a member assignment is one node and owns its value-write fact', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-member-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(ref: { current: boolean }) {
  ref.current = false;
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
    const assignment = payload.nodes.find((node) => node.actionTextRaw === 'ref.current = false;');
    assert.ok(assignment, 'the complete assignment node was not extracted');
    assert.ok(assignment.labels.includes('ValueWrite'), JSON.stringify(payload.nodes.map((node) => ({
      id: stableIdOf(node.stableId),
      text: node.actionTextRaw,
      labels: node.labels,
      accesses: node.valueAccessesJson,
    }))));
    assert.equal(
      payload.nodes.some((node) => (
        node !== assignment
        && node.actionTextRaw === 'ref.current'
        && node.labels.includes('ValueWrite')
      )),
      false,
      'the assignment target must not be extracted as a separate write node',
    );
    assert.ok(!payload.edges.some((edge) => (
      edge.type === 'WRITES_VALUE'
      && edge.fromId === stableIdOf(assignment.stableId)
    )), 'a value occurrence must not jump directly to its declaration');
    assert.ok(payload.semanticRelationships?.some((relationship) => (
      relationship.type === 'USES_REFERENCE'
      && relationship.fromId === stableIdOf(assignment.stableId)
      && Array.isArray(relationship.props.actions)
      && relationship.props.actions.includes('write')
    )), 'the complete assignment must point to its nearest ValueReference');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('an assignment between existing variables is extracted as one closed-container set mosaic', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-existing-variable-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(source: string[]) {
  let target: string[] = [];
  target = source;
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
    const assignment = payload.nodes.find((node) => node.actionTextRaw === 'target = source;');
    assert.ok(assignment, 'the assignment node was not extracted');
    assert.ok(assignment.labels.includes('ValueWrite'));
    assert.ok(assignment.labels.includes('ContainerMethod'));
    assert.ok(assignment.labels.includes('Set'));
    assert.equal(assignment.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(
      JSON.parse(String(assignment.renderPartsJson || '[]')).map((part: {
        text?: string;
        kind?: string;
        fillState?: string;
        labels?: string[];
      }) => ({
        text: part.text,
        kind: part.kind,
        fillState: part.fillState,
        virtual: part.labels?.includes('Virtual') || false,
      })),
      [
        { text: 'target', kind: 'value-container', fillState: 'filled', virtual: false },
        { text: 'set(', kind: 'method', fillState: undefined, virtual: true },
        { text: 'source', kind: 'value', fillState: 'filled', virtual: false },
        { text: ')', kind: 'punctuation', fillState: undefined, virtual: true },
      ],
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a literal write to an existing variable is an open horizontal set mosaic', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-existing-literal-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject() {
  let doneWasCalled = false;
  doneWasCalled = true;
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
    const assignment = payload.nodes.find((node) => node.actionTextRaw === 'doneWasCalled = true;');
    assert.ok(assignment, 'the literal assignment node was not extracted');
    assert.equal(assignment.renderPartsLayout, 'container-overlay-side');
    assert.equal(assignment.containerState, 'awaiting-assignment');
    assert.deepEqual(
      JSON.parse(String(assignment.renderPartsJson || '[]')).map((part: {
        text?: string;
        kind?: string;
        fillState?: string;
      }) => ({ text: part.text, kind: part.kind, fillState: part.fillState })),
      [
        { text: 'doneWasCalled', kind: 'value-container', fillState: 'empty' },
        { text: 'set(', kind: 'method', fillState: undefined },
        { text: 'true', kind: 'literal', fillState: 'filled' },
        { text: ')', kind: 'punctuation', fillState: undefined },
      ],
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a computed boolean assignment owns one falsy/truthy result mosaic', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-boolean-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(
  active: boolean,
  immediate: boolean | undefined,
  fromKeybinding: boolean | undefined,
) {
  const shouldRun = active && (immediate || fromKeybinding);
  return shouldRun;
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
    const assignment = payload.nodes.find((node) => node.operationSubjectText === 'shouldRun');
    assert.ok(assignment, 'the boolean assignment container was not extracted');
    const assignmentId = stableIdOf(assignment.stableId);
    const parts = JSON.parse(String(assignment.renderPartsJson || '[]')) as Array<{
      kind?: string;
      plainText?: string;
      text?: string;
      labels?: string[];
      fillState?: string;
    }>;

    assert.deepEqual(parts.map((part) => part.plainText || part.text), [
      'shouldRun', 'set(', 'falsy/truthy', ')',
    ]);
    const outcomePart = parts.find((part) => part.plainText === 'falsy/truthy');
    assert.equal(outcomePart?.kind, 'virtual-value');
    assert.ok(outcomePart?.labels?.includes('Virtual'));
    assert.equal(outcomePart?.fillState, 'filled');
    assert.equal(
      payload.nodes.some((node) => (
        node.labels.includes('ValueOutcome')
        && stableIdOf(node.stableId).startsWith(`${assignmentId}:outcome:`)
      )),
      false,
      'truthy and falsy must not become standalone graph nodes',
    );
    assert.equal(
      payload.edges.some((edge) => edge.toId === assignmentId && edge.type === 'ASSIGNS_VALUE'),
      false,
      'predicate results must not be wrapped in generic value-assignment edges',
    );
    const returns = payload.edges.filter((edge) => (
      edge.toId === assignmentId && (edge.type === 'TRUE' || edge.type === 'FALSE')
    ));
    assert.ok(returns.some((edge) => edge.type === 'TRUE' && edge.producerRouteRole === 'return-top'));
    assert.ok(returns.some((edge) => edge.type === 'FALSE' && edge.producerRouteRole === 'return-bottom'));
    const predicates = payload.nodes.filter((node) => (
      node.labels.includes('Branch')
      && ['active', 'immediate', 'fromKeybinding'].includes(String(node.conditionRaw || ''))
    ));
    assert.equal(predicates.length, 3);
    assert.ok(predicates.every((node) => node.labels.includes('Data')),
      'every predicate in a computed-value frame must remain a DataBranch');
    assert.ok(predicates.every((node) => !node.labels.includes('Flow')),
      'short-circuit continuation must not turn a horizontal data frame into control flow');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a single object binding materializes its awaiting container around an async call', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-object-binding-assignment.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function getOriginalCwd(): string;
async function handle(input: string, enabled: boolean, deps: { cwd: string }): Promise<{ queryRequired: boolean }> {
  return { queryRequired: input.length > 0 };
}
export async function subject(input: string) {
  const { queryRequired } = await handle(input, true, { cwd: getOriginalCwd() });
  return queryRequired;
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
      node.operationSubjectText === 'queryRequired'
      && node.labels.includes('Assignment')
    ));
    assert.ok(assignment, 'the destructured variable container was not extracted');
    const assignmentId = stableIdOf(assignment.stableId);
    const parts = JSON.parse(String(assignment.renderPartsJson || '[]')) as Array<{
      text?: string;
      kind?: string;
      fillState?: string;
    }>;
    assert.deepEqual(parts.map((part) => part.text), ['queryRequired', 'set']);
    assert.equal(parts[0].kind, 'value-container');
    assert.equal(parts[0].fillState, 'empty');
    const owningStep = payload.nodes.find((node) => (
      node.labels.includes('Step')
      && node.headStableIds?.includes(assignmentId)
    ));
    assert.ok(owningStep, 'the first materialized binding token must remain the Step head');

    const evalEdge = payload.edges.find((edge) => (
      edge.fromId === assignmentId && edge.type === 'EVAL'
    ));
    assert.ok(evalEdge, 'the awaiting container must initiate evaluation');
    assert.equal(evalEdge.invocationMode, 'asynchronous');
    assert.equal(evalEdge.responseMode, 'awaited');
    const call = payload.nodes.find((node) => (
      stableIdOf(node.stableId) === evalEdge.toId
      && node.operationCode === 'CALL'
      && node.labels.includes('Start')
    ));
    assert.ok(call, 'EVAL must enter the extracted call chain');

    const returns = payload.edges.filter((edge) => (
      edge.toId === assignmentId && edge.type === 'ASSIGNS_VALUE'
    ));
    assert.equal(returns.length, 1, 'the call chain must return one value into set');
    assert.equal(returns[0].label, 'value');
    const returnSource = payload.nodes.find((node) => stableIdOf(node.stableId) === returns[0].fromId);
    assert.ok(
      returnSource?.labels.some((label) => label === 'FnVisualProxy' || label === 'Finish'),
      'value must return from the closing call boundary',
    );

    const cwd = payload.nodes.find((node) => (
      node.diaName === 'cwd'
      && node.labels.includes('Field')
      && node.labels.includes('ValueSlot')
    ));
    assert.ok(cwd, 'a value-producing object field must be an awaiting virtual container');
    assert.equal(cwd.containerState, 'awaiting-assignment');
    assert.deepEqual(
      JSON.parse(String(cwd.renderPartsJson || '[]')).map((part: { text?: string }) => part.text),
      ['cwd', 'set'],
    );
    const cwdId = stableIdOf(cwd.stableId);
    const cwdEval = payload.edges.find((edge) => edge.fromId === cwdId && edge.type === 'EVAL');
    assert.ok(cwdEval, 'the field container must evaluate its producer in a child SubStep');
    const cwdCall = payload.nodes.find((node) => stableIdOf(node.stableId) === cwdEval.toId);
    assert.ok(cwdCall?.labels.includes('SubStep'));
    assert.equal(cwdCall?.nestedEvaluationDirection, 'down');
    const cwdReturn = payload.edges.find((edge) => (
      edge.toId === cwdId
      && edge.type === 'YIELDS_VALUE'
      && edge.protocolRole === 'assignment-return'
    ));
    assert.ok(cwdReturn, 'the producer must return value into the virtual set');
    assert.equal(cwdReturn.targetRenderPartStableId, `${cwdId}:set`);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a synchronous system expression used as an object field does not invent a field value variable', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-inline-system-field.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function consume(value: { kind: string; idleMinutes: number }): void;
const state = { current: 0 };
export function subject() {
  consume({
    kind: 'idle',
    idleMinutes: Math.round((Date.now() - state.current) / 60_000),
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
    const field = payload.nodes.find((node) => (
      node.fieldName === 'idleMinutes'
      && node.actionTextRaw?.startsWith('Math.round(')
    ));

    assert.ok(field, `the object field expression must remain directly reachable in its field branch: ${JSON.stringify(
      payload.nodes.filter((node) => node.fieldName === 'idleMinutes' || node.actionTextRaw?.includes('Math.round(')),
    )}`);
    assert.match(String(field.diaName), /^Math\.round\(/u);
    assert.equal(field.labels.includes('ValueSlot'), false);
    assert.equal(field.labels.includes('ValueCreate'), false);
    assert.equal(field.containerState, undefined);
    assert.equal(
      payload.nodes.some((node) => node.diaName === 'idleMinutesValue'),
      false,
      'an inline system expression must not acquire a synthetic field alias',
    );
    const fieldId = stableIdOf(field.stableId);
    assert.equal(
      payload.edges.some((edge) => edge.fromId === fieldId && edge.type === 'EVAL'),
      false,
      'an embedded system provider must remain inside the field mosaic',
    );
    assert.equal(
      payload.edges.some((edge) => (
        edge.toId === fieldId
        && edge.type === 'YIELDS_VALUE'
        && edge.protocolRole === 'assignment-return'
      )),
      false,
      'an inline field expression must not return through a virtual set',
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('object field alternatives converge through one DataJoin and literals keep their semantic label', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-object-data-join.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
export function subject(mediaType: string | undefined, content: string) {
  const source = {
    type: 'base64' as const,
    media_type: (mediaType ?? 'image/png') as 'image/jpeg' | 'image/png',
    data: content,
  };
  return source;
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
    const dataJoins = payload.nodes.filter((node) => node.labels.includes('DataJoin'));
    assert.equal(dataJoins.length, 1, 'the conditional field must own exactly one DataJoin');
    assert.deepEqual(dataJoins[0].labels, ['DataJoin']);
    assert.equal(dataJoins[0].diaName, 'DataJoin');
    const dataJoinId = stableIdOf(dataJoins[0].stableId);
    const incoming = payload.edges.filter((edge) => edge.toId === dataJoinId);
    const outgoing = payload.edges.filter((edge) => edge.fromId === dataJoinId);
    assert.equal(incoming.length, 2);
    assert.deepEqual(incoming.map((edge) => edge.type).sort(), ['FALSE', 'TRUE']);
    assert.equal(new Set(incoming.map((edge) => edge.fromId)).size, 1);
    const predicate = payload.nodes.find((node) => stableIdOf(node.stableId) === incoming[0].fromId);
    assert.ok(predicate?.labels.includes('Branch'));
    const predicateParts = JSON.parse(predicate?.renderPartsJson || '[]') as Array<{
      stableId?: string;
      text?: string;
    }>;
    const incomingByType = new Map(incoming.map((edge) => [edge.type, edge]));
    assert.equal(
      incomingByType.get('TRUE')?.sourceRenderPartStableId,
      predicateParts.find((part) => part.text === 'mediaType')?.stableId,
    );
    assert.equal(
      incomingByType.get('FALSE')?.sourceRenderPartStableId,
      predicateParts.find((part) => part.text === "'image/png'")?.stableId,
    );
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].type, 'FieldJoin');
    assert.equal(outgoing[0].fieldName, 'media_type');
    assert.equal(payload.edges.some((edge) => (
      edge.type === 'FieldJoin'
      && edge.fieldName === 'media_type'
      && edge.fromId !== dataJoinId
    )), false, 'field alternatives must not independently enter the object closing node');
    assert.ok(payload.nodes.some((node) => (
      node.labels.includes('Field')
      && node.labels.includes('Literal')
      && node.diaName === "'base64'"
    )), 'a direct literal field must retain the Literal label');
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('Literal') && node.diaName === "'image/png'"
    )), false, 'a branch alternative already present in the predicate mosaic must not become another node');
    assert.ok(predicateParts.some((part) => (
      part.text === "'image/png'"
    )), 'the fallback literal must remain a tile of the predicate mosaic');
    const braces = payload.nodes.filter((node) => node.labels.includes('ObjectBrace'));
    assert.equal(braces.length, 2, 'three fields require one extracted left/right brace pair');
    assert.deepEqual(
      braces.map((node) => node.objectBraceSide).sort(),
      ['left', 'right'],
    );
    assert.ok(braces.every((node) => node.diaName === ''));
    const sourceAssignment = payload.nodes.find((node) => (
      node.diaName === 'source' && node.labels.includes('Assignment')
    ));
    assert.ok(sourceAssignment);
    assert.equal(
      (JSON.parse(sourceAssignment.renderPartsJson || '[]') as Array<{ text: string }>).some((part) => part.text === '{'),
      false,
      'a multi-field opening brace must be a graph brace, not a punctuation tile',
    );
    const sourceAssignmentStableId = stableIdOf(sourceAssignment.stableId);
    const outerLeftBrace = braces.find((node) => node.objectBraceSide === 'left');
    assert.equal(
      outerLeftBrace?.objectBraceMosaicNeighborStableId,
      sourceAssignmentStableId,
      'the outer opening brace must mosaic directly onto its extracted neighbor',
    );
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === sourceAssignmentStableId
      && edge.toId === stableIdOf(outerLeftBrace!.stableId)
    )), false, 'the opening mosaic seam must not be extracted as an edge');
    const assignmentClose = payload.nodes.find((node) => (
      node.callBoundaryRole === 'close'
      && payload.edges.some((edge) => (
        edge.fromId === stableIdOf(node.stableId)
        && edge.toId === sourceAssignmentStableId
        && edge.type === 'ASSIGNS_VALUE'
      ))
    ));
    assert.ok(assignmentClose);
    const assignmentReturn = payload.edges.find((edge) => (
      edge.fromId === stableIdOf(assignmentClose.stableId)
      && edge.toId === sourceAssignmentStableId
      && edge.type === 'ASSIGNS_VALUE'
    ));
    assert.ok(assignmentReturn);
    assert.ok(Number.isFinite(assignmentReturn.producerScopeStartOrder));
    assert.ok(Number.isFinite(assignmentReturn.producerScopeEndOrder));
    assert.ok(
      Number(assignmentReturn.producerScopeStartOrder) <= Number(sourceAssignment.operationIndex),
      'the producer bypass must start at its own assignment SubStep',
    );
    assert.ok(
      Number(assignmentReturn.producerScopeEndOrder) >= Number(assignmentClose.operationIndex),
      'the producer bypass must include its own closing boundary',
    );
    const outerRightBrace = braces.find((node) => node.objectBraceSide === 'right');
    assert.equal(
      outerRightBrace?.objectBraceMosaicNeighborStableId,
      stableIdOf(assignmentClose.stableId),
      'the outer closing brace must mosaic directly onto its extracted neighbor',
    );
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(outerRightBrace!.stableId)
      && edge.toId === stableIdOf(assignmentClose.stableId)
    )), false, 'the closing mosaic seam must not be extracted as an edge');
    assert.deepEqual(
      (JSON.parse(assignmentClose.renderPartsJson || '[]') as Array<{ text: string }>).map((part) => part.text),
      [')'],
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
