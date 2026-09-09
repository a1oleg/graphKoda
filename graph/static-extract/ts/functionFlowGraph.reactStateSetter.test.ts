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

test('atomic React state setters compose the state variable and call in one graph node', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-react-state-setter.fixture.ts');
  const reactTypesPath = path.resolve('tmp', 'function-flow-react-state-setter.react.d.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(reactTypesPath, `
declare module 'react' {
  export function useState<T>(initial: T): [T, (value: T | undefined) => void];
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: unknown[]): T;
}
`, 'utf8');
  fs.writeFileSync(fixturePath, `
import { useState } from 'react';
import * as React from 'react';

export function subject() {
  const [contents, setContents] = useState<string | undefined>(undefined);
  const [record, setRecord] = useState({ value: 'old' });
  // Tracks work performed outside the local query guard.
  const [active, setActive] = React.useState(false);
  const stableContents = React.useCallback(() => contents, [contents]);
  setContents('ready');
  setContents(undefined);
  setRecord(prev => ({ ...prev, value: 'next' }));
  setActive(true);
  const nested = () => setActive(false);
  nested();
  return stableContents() || record.value || active;
}
`, 'utf8');

  try {
    const program = ts.createProgram([reactTypesPath, fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const payload = extractFunctionFlowGraphs(program);
    const setterCalls = payload.nodes.filter((node) => (
      node.actionTextRaw?.startsWith('setContents(')
    ));
    assert.equal(setterCalls.length, 2);
    const resourceStableId = setterCalls[0].stateResourceStableId || '';
    assert.ok(resourceStableId, 'the setter call must resolve its useState resource');
    const resource = payload.nodes.find((node) => stableIdOf(node.stableId) === resourceStableId);
    assert.ok(resource, 'the useState value must be materialized as the stateful resource');
    for (const call of setterCalls) {
      const callStableId = stableIdOf(call.stableId);
      assert.equal(payload.nodes.some((node) => (
        node.labels.includes('FnVisualProxy')
        && node.sourceCallStableId === callStableId
      )), false, 'an atomic state setter must not create a duplicate setter proxy');
      assert.ok(call.labels.includes('UiState'));
      assert.ok(call.labels.includes('ValueSlot'));
      assert.equal(call.canonicalStableId, resourceStableId);
      assert.equal(call.renderPartsLayout, 'container-overlay-side');
      const parts = JSON.parse(call.renderPartsJson || '[]') as Array<{
        text: string;
        kind: string;
        labels: string[];
      }>;
      assert.equal(parts[0]?.text, 'contents');
      assert.equal(parts[0]?.kind, 'value-container');
      assert.ok(parts[0]?.labels.includes('UiState'));
      assert.ok(parts.slice(1).some((part) => part.text.startsWith('setContents')));
      assert.equal(payload.nodes.some((node) => (
        node.labels.includes('ResourceProxy')
        && node.sourceCallStableId === callStableId
      )), false, 'the state variable and its call must not be split into a proxy node');
    }

    const undefinedSetter = setterCalls.find((call) => call.actionTextRaw === 'setContents(undefined)');
    assert.ok(undefinedSetter);
    const undefinedPart = (JSON.parse(undefinedSetter.renderPartsJson || '[]') as Array<{
      text: string;
      kind: string;
      labels: string[];
      canonicalStableId?: string;
      bindingStableId?: string;
    }>).find((part) => part.text === 'undefined');
    assert.ok(undefinedPart);
    assert.equal(undefinedPart.kind, 'literal');
    assert.ok(undefinedPart.labels.includes('SystemValue'));
    assert.ok(undefinedPart.labels.includes('System'));
    assert.equal(undefinedPart.labels.includes('ValueAccess'), false);
    assert.equal(undefinedPart.canonicalStableId, undefined);
    assert.equal(undefinedPart.bindingStableId, undefined);

    assert.equal(payload.nodes.some((node) => node.labels.includes('ResourceProxy')), false);
    assert.equal(payload.edges.some((edge) => (
      ['WRITES_VALUE', 'CLEARS_VALUE'].includes(edge.type)
      && setterCalls.some((call) => edge.fromId === stableIdOf(call.stableId))
    )), false, 'the operation is internal to the composed stateful call node');
    assert.equal(payload.edges.some((edge) => (
      edge.fromId === stableIdOf(setterCalls[0].stableId)
      && edge.toId === resourceStableId
    )), false, 'the local call must not render against the shared canonical state node');
    for (const call of setterCalls) {
      assert.ok(payload.semanticRelationships?.some((relationship) => (
        relationship.fromId === stableIdOf(call.stableId)
        && relationship.toId === resourceStableId
        && relationship.type === 'WRITES_TO'
        && relationship.props.resolution === 'react-state-provenance'
      )), 'the semantic graph must connect a state setter to its concrete state resource');
    }

    const visualProxies = payload.nodes.filter((node) => node.labels.includes('FnVisualProxy'));
    assert.ok(visualProxies.length > 0, 'the callback/call rendering fixture must produce a visual proxy');
    assert.ok(visualProxies.every((node) => node.labels.includes('PresentationOnly')));
    assert.ok(visualProxies.every((node) => node.annotationKind === undefined));

    const objectSetter = payload.nodes.find((node) => node.actionTextRaw?.startsWith('setRecord('));
    assert.ok(objectSetter);
    assert.equal(objectSetter.renderPartsLayout, 'container-overlay-side');
    assert.deepEqual(
      (JSON.parse(objectSetter.renderPartsJson || '[]') as Array<{ text: string }>).slice(0, 2).map((part) => part.text),
      ['record', 'setRecord('],
    );
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('ResourceProxy')
      && node.sourceCallStableId === stableIdOf(objectSetter.stableId)
    )), false);
    assert.equal(payload.nodes.some((node) => (
      node.labels.includes('Storage')
      && node.sequenceOwnerStableId === stableIdOf(objectSetter.stableId)
    )), false);

    const namespaceSetter = payload.nodes.find((node) => node.actionTextRaw === 'setActive(true)');
    assert.ok(namespaceSetter, 'React.useState must produce the same provenance as imported useState');
    assert.equal(namespaceSetter.stateResourceName, 'active');
    assert.ok(namespaceSetter.stateResourceStableId);

    const namespaceCreation = payload.nodes.find((node) => (
      node.stateResourceName === 'active'
      && node.stateUpdateAction === 'create'
    ));
    assert.ok(namespaceCreation, 'React.useState must materialize the state initialization');
    assert.equal(namespaceCreation.stateResourceStableId, namespaceSetter.stateResourceStableId);
    assert.equal(
      namespaceCreation.sourceDocumentation,
      'Tracks work performed outside the local query guard.',
    );
    const canonicalActiveWrites = payload.semanticRelationships?.filter((relationship) => (
      relationship.type === 'WRITES_TO'
      && relationship.toId === namespaceSetter.stateResourceStableId
      && relationship.props.role !== 'state-updater'
    )) || [];
    assert.deepEqual(
      canonicalActiveWrites.map((relationship) => payload.semanticEntities?.find((entity) => (
        entity.stableId === relationship.fromId
      ))?.props.syntax || payload.nodes.find((node) => stableIdOf(node.stableId) === relationship.fromId)?.actionTextRaw),
      ['setActive(true)', 'setActive(false)'],
      'nested and direct setter calls must target one state slot',
    );
    const updater = payload.semanticRelationships?.find((relationship) => (
      relationship.type === 'WRITES_TO'
      && relationship.toId === namespaceSetter.stateResourceStableId
      && relationship.props.role === 'state-updater'
    ));
    assert.ok(updater, 'the setter declaration must retain its state target without a call');
    const owner = payload.semanticEntities?.find((entity) => entity.props.name === 'subject');
    assert.ok(owner);
    for (const memberId of [updater.fromId, updater.toId]) {
      assert.ok(payload.semanticRelationships?.some((relationship) => (
        relationship.fromId === owner.stableId
        && relationship.toId === memberId
        && relationship.type === 'AST_CHILD'
      )), 'both hook bindings must belong to the function creating the state');
    }
  } finally {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(reactTypesPath, { force: true });
  }
});
