import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { collectCanonicalReferenceGraph } from './functionFlowGraph.canonicalReferences.ts';

test('materializes canonical declarations, references, aliases, derived types, React wrappers, refs, overloads, and merged symbols', () => {
  const typesPath = path.resolve('tmp', 'canonical-references-types.fixture.ts');
  const usagePath = path.resolve('tmp', 'canonical-references-usage.fixture.tsx');
  fs.mkdirSync(path.dirname(typesPath), { recursive: true });
  fs.writeFileSync(typesPath, `
export interface Base { id: string }
export interface Merged { first: string }
export interface Merged { second: number }
export type Original<T> = { value: T };
export type Alias<T> = Original<T>;
export class Service extends Array<string> implements Base { id = 'service'; }
export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number) { return value; }
export function Component(props: { item: Alias<string> }) { return props.item.value; }
export { Original as ReExported };
`, 'utf8');
  fs.writeFileSync(usagePath, `
import { Component as OriginalComponent, Service, overloaded } from './canonical-references-types.fixture.js';
import type { Alias as ImportedAlias, Merged } from './canonical-references-types.fixture.js';
declare function memo<T>(component: T): T;
declare function forwardRef<T>(render: (props: {}, ref: T) => unknown): unknown;
declare function useImperativeHandle<T>(ref: T, factory: () => T): void;
const ComponentAlias = OriginalComponent;
const Wrapped = memo(OriginalComponent);
const Forwarded = forwardRef((props: {}, ref: { focus(): void }) => {
  useImperativeHandle(ref, () => ref);
  return null;
});

export function useEverything(value: ImportedAlias<string>, merged: Merged) {
  const service = new Service();
  service.push(overloaded(value.value));
  return <div ref={service}>{ComponentAlias({ item: value })}{merged.first}</div>;
}
`, 'utf8');

  try {
    const program = ts.createProgram([typesPath, usagePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const relationshipTypes = new Set(graph.relationships.map((relationship) => relationship.type));
    for (const required of [
      'RESOLVES_TO',
      'ALIASES',
      'REEXPORTS',
      'INSTANTIATES',
      'TYPE_ARGUMENT',
      'DERIVES_FROM',
      'EXTENDS',
      'IMPLEMENTS',
      'WRAPS',
      'FORWARDS_REF_TO',
      'SIGNATURE_OF',
      'HAS_DECLARATION_PART',
      'HAS_MEMBER',
    ]) assert.ok(relationshipTypes.has(required), `missing ${required}`);

    const requiredLabels = [
      'TypeReference',
      'TypeDeclaration',
      'ValueReference',
      'ValueDeclaration',
      'MemberReference',
      'MemberDeclaration',
      'AliasDeclaration',
      'ReExport',
      'GenericUse',
      'DerivedType',
      'ReactWrapper',
      'Ref',
      'MergedSymbol',
    ];
    for (const required of requiredLabels) {
      assert.ok(graph.entities.some((entity) => entity.labels.includes(required)), `missing ${required}`);
    }

    const expectedDeclarationLabel = new Map([
      ['TypeReference', 'TypeDeclaration'],
      ['ValueReference', 'ValueDeclaration'],
      ['MemberReference', 'MemberDeclaration'],
    ]);
    for (const relationship of graph.relationships.filter((candidate) => candidate.type === 'RESOLVES_TO')) {
      const reference = graph.entities.find((entity) => entity.stableId === relationship.fromId);
      const declaration = graph.entities.find((entity) => entity.stableId === relationship.toId);
      const referenceKind = [...expectedDeclarationLabel.keys()]
        .find((label) => reference?.labels.includes(label));
      assert.ok(referenceKind, `unclassified reference ${relationship.fromId}`);
      assert.ok(
        declaration?.labels.includes(expectedDeclarationLabel.get(referenceKind)!),
        `${referenceKind} must resolve to ${expectedDeclarationLabel.get(referenceKind)}`,
      );
    }

    const endpointContracts = new Map([
      ['INSTANTIATES', ['GenericUse', 'GenericDeclaration']],
      ['TYPE_ARGUMENT', ['GenericUse', 'TypeDeclaration']],
      ['DERIVES_FROM', ['DerivedType', 'TypeDeclaration']],
      ['WRAPS', ['ReactWrapper', 'Component']],
      ['FORWARDS_REF_TO', ['Ref', 'RefTarget']],
      ['SIGNATURE_OF', ['OverloadSignature', 'FunctionImplementation']],
      ['HAS_DECLARATION_PART', ['MergedSymbol', 'Declaration']],
      ['HAS_MEMBER', ['TypeDeclaration', 'MemberDeclaration']],
    ]);
    for (const [relationshipType, [sourceLabel, targetLabel]] of endpointContracts) {
      for (const relationship of graph.relationships.filter((candidate) => candidate.type === relationshipType)) {
        const source = graph.entities.find((entity) => entity.stableId === relationship.fromId);
        const target = graph.entities.find((entity) => entity.stableId === relationship.toId);
        assert.ok(source?.labels.includes(sourceLabel), `${relationshipType} source must be ${sourceLabel}`);
        assert.ok(target?.labels.includes(targetLabel), `${relationshipType} target must be ${targetLabel}`);
      }
    }

    const importedAliasReference = graph.entities.find((entity) => (
      entity.labels.includes('TypeReference')
      && entity.props.name === 'ImportedAlias'
    ));
    assert.ok(importedAliasReference);
    const resolvedAlias = graph.relationships.find((relationship) => (
      relationship.fromId === importedAliasReference.stableId
      && relationship.type === 'RESOLVES_TO'
    ));
    assert.ok(resolvedAlias);
    const originalAliasDeclaration = graph.entities.find((entity) => entity.stableId === resolvedAlias.toId);
    assert.equal(originalAliasDeclaration?.props.name, 'Alias');

    const originalType = graph.entities.find((entity) => (
      entity.labels.includes('TypeDeclaration') && entity.props.name === 'Original'
    ));
    const valueMember = graph.entities.find((entity) => (
      entity.labels.includes('MemberDeclaration') && entity.props.name === 'value'
    ));
    assert.ok(originalType);
    assert.ok(valueMember);
    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'HAS_MEMBER'
      && relationship.fromId === originalType.stableId
      && relationship.toId === valueMember.stableId
    )));
  } finally {
    fs.rmSync(typesPath, { force: true });
    fs.rmSync(usagePath, { force: true });
  }
});

test('resolves a union receiver member call to concrete callbacks returned through an identity wrapper', () => {
  const fixturePath = path.resolve('tmp', 'union-member-resolution.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
import { useMemo } from 'react';
type First = { sendMessage: (content: string) => Promise<boolean> };
type Second = { sendMessage: (content: string, options?: { id?: string }) => Promise<boolean> };
function useFirst(): First {
  const sendMessage = async (content: string) => content.length > 0;
  return useMemo(() => ({ sendMessage }), [sendMessage]);
}
function useSecond(): Second {
  const sendMessage = async (content: string, options?: { id?: string }) => content === options?.id;
  return useMemo(() => ({ sendMessage }), [sendMessage]);
}
export function submit(pickFirst: boolean) {
  const first = useFirst();
  const second = useSecond();
  const active = pickFirst ? first : second;
  return active.sendMessage('payload');
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const call = graph.entities.find((entity) => (
      entity.labels.includes('Call') && entity.props.name === 'active.sendMessage'
    ));
    assert.ok(call);
    const concreteTargets = graph.relationships
      .filter((relationship) => relationship.type === 'CALLS' && relationship.fromId === call.stableId)
      .map((relationship) => graph.entities.find((entity) => entity.stableId === relationship.toId))
      .filter((entity) => entity?.labels.includes('FunctionImplementation'));
    assert.equal(concreteTargets.length, 2);
    assert.ok(concreteTargets.every((entity) => entity?.props.name === 'ArrowFunction'));
    const memberReference = graph.entities.find((entity) => (
      entity.labels.includes('MemberReference')
      && entity.props.name === 'sendMessage'
      && entity.props.startLine === 17
    ));
    assert.ok(memberReference);
    const memberTargets = graph.relationships
      .filter((relationship) => relationship.type === 'RESOLVES_TO' && relationship.fromId === memberReference.stableId)
      .map((relationship) => graph.entities.find((entity) => entity.stableId === relationship.toId))
      .filter((entity) => entity?.labels.includes('MemberDeclaration'));
    assert.equal(memberTargets.length, 2);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('traces renamed callback values through arguments, projections, hook returns, and implementation operations', () => {
  const fixturePath = path.resolve('tmp', 'functional-connectivity.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type Helpers = { Boo: () => void };
declare function systemCancelTimer(handle: number): void;
function useBuffer() {
  let state = [1, 2, 3];
  const Boo = () => {
    state = [];
    systemCancelTimer(1);
  };
  return { Boo };
}
function execute(helpers: Helpers) {
  helpers.Boo();
}
function caller() {
  const { Boo: callback } = useBuffer();
  execute({ Boo: callback });
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const entityById = new Map(graph.entities.map((entity) => [entity.stableId, entity]));
    const types = new Set(graph.relationships.map((relationship) => relationship.type));
    for (const required of [
      'CALLS_VALUE',
      'CALLS',
      'HAS_ARGUMENT',
      'BINDS_TO_PARAMETER',
      'HAS_PROPERTY',
      'SATISFIES_MEMBER',
      'VALUE_FROM',
      'READS_FROM',
      'RETURNS_VALUE',
      'SELECTS_RETURN_PROPERTY',
      'WRITES_TO',
      'AST_CHILD',
    ]) assert.ok(types.has(required), `missing functional relationship ${required}`);
    assert.equal(
      graph.relationships.some((relationship) => relationship.type === 'HAS_OPERATION'),
      false,
      'canonical references must not bypass Step ownership with function-to-operation edges',
    );
    assert.ok(graph.relationships.some((relationship) => {
      if (relationship.type !== 'AST_CHILD') return false;
      const owner = entityById.get(relationship.fromId);
      const operation = entityById.get(relationship.toId);
      return owner?.labels.includes('FunctionImplementation')
        && operation?.labels.includes('Operation')
        && relationship.props.projection === 'nearest-function-operation';
    }), 'a callback implementation must retain lexical ownership of its canonical operations');

    for (const entity of graph.entities.filter((candidate) => candidate.props.repoRelativePath)) {
      assert.doesNotMatch(
        entity.stableId,
        /:(?:type-declaration|value-declaration|member-declaration|parameter|property-value|value-reference|argument-value:\d+|object-construction|call)$/,
      );
      assert.ok(Array.isArray(entity.props.roles));
    }
    const shorthand = graph.entities.find((entity) => (
      entity.labels.includes('PropertyValue') && entity.labels.includes('ValueReference')
    ));
    assert.ok(shorthand, 'a shorthand property must accumulate property and reference roles on one source entity');
    const argumentObject = graph.entities.find((entity) => (
      entity.labels.includes('ArgumentValue') && entity.labels.includes('ObjectConstruction')
    ));
    assert.ok(argumentObject, 'an object-literal argument must accumulate argument and object roles on one source entity');
    const propertyEdge = graph.relationships.find((relationship) => relationship.type === 'HAS_PROPERTY');
    assert.equal(propertyEdge?.props.fromFacet, 'object');
    assert.equal(propertyEdge?.props.toFacet, 'property');
    const syntaxEdge = graph.relationships.find((relationship) => relationship.type === 'AST_CHILD');
    assert.equal(syntaxEdge?.props.layer, 'syntax');
    assert.equal(syntaxEdge?.props.fromFacet, 'syntaxContainer');
    assert.equal(syntaxEdge?.props.toFacet, 'syntaxPart');

    const implementation = graph.entities.find((entity) => (
      entity.labels.includes('ValueDeclaration') && entity.props.name === 'Boo'
      && String(entity.props.syntax).includes('=>')
    ));
    const callback = graph.entities.find((entity) => (
      entity.labels.includes('ValueDeclaration') && entity.props.name === 'callback'
    ));
    const externalBoundary = graph.entities.find((entity) => (
      entity.labels.includes('ExternalBoundary') && entity.props.name === 'systemCancelTimer'
    ));
    assert.ok(implementation);
    assert.ok(callback);
    assert.ok(externalBoundary);
    assert.ok(graph.entities.some((entity) => entity.labels.includes('StateWrite')));

    const adjacency = new Map<string, Set<string>>();
    for (const relationship of graph.relationships) {
      const endpoints = adjacency.get(relationship.fromId) || new Set<string>();
      endpoints.add(relationship.toId);
      adjacency.set(relationship.fromId, endpoints);
    }
    const reachable = new Set<string>([callback.stableId]);
    const queue = [callback.stableId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) || []) {
        if (reachable.has(next)) continue;
        reachable.add(next);
        queue.push(next);
      }
    }
    assert.ok(reachable.has(implementation.stableId), 'destructured callback must reach its returned implementation');
    const stateWrite = graph.entities.find((entity) => entity.labels.includes('StateWrite'));
    assert.ok(stateWrite);
    assert.ok(graph.relationships.some((relationship) => (
      relationship.fromId === stateWrite.stableId && relationship.type === 'WRITES_TO'
    )));
    assert.ok(graph.relationships.some((relationship) => (
      relationship.toId === externalBoundary.stableId && relationship.type === 'CALLS'
    )), 'system call must reach the external system boundary');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('separates callback parameter ownership from values passed through JSX props', () => {
  const fixturePath = path.resolve('tmp', 'canonical-jsx-callback-parameters.fixture.tsx');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare namespace JSX { interface IntrinsicElements {} }
type Helpers = { Boo(): void };
type Props = {
  onSubmit: (input: string, helpers: Helpers) => void;
};
function PromptInput({ onSubmit: onSubmitProp }: Props) {
  const callback = () => {};
  onSubmitProp('', { Boo: callback });
  return null;
}
const onSubmit = (input: string, helpers: Helpers) => {
  helpers.Boo();
};
const element = <PromptInput onSubmit={onSubmit} />;
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const entityById = new Map(graph.entities.map((entity) => [entity.stableId, entity]));
    const helpers = graph.entities.find((entity) => (
      entity.labels.includes('Parameter') && entity.props.name === 'helpers'
    ));
    const implementation = graph.entities.find((entity) => (
      entity.labels.includes('FunctionImplementation')
      && String(entity.props.syntax).includes('helpers.Boo()')
    ));
    const propsMember = graph.entities.find((entity) => (
      entity.labels.includes('MemberDeclaration')
      && entity.props.name === 'onSubmit'
      && String(entity.props.syntax).startsWith('onSubmit:')
    ));
    const jsxProperty = graph.entities.find((entity) => (
      entity.labels.includes('JsxPropertyValue') && entity.props.name === 'onSubmit'
    ));
    assert.ok(helpers);
    assert.ok(implementation);
    assert.ok(propsMember);
    assert.ok(jsxProperty);

    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'HAS_PARAMETER'
      && relationship.fromId === implementation.stableId
      && relationship.toId === helpers.stableId
      && relationship.props.layer === 'structural'
    )), 'the callable must structurally own helpers');
    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'SATISFIES_MEMBER'
      && relationship.fromId === jsxProperty.stableId
      && relationship.toId === propsMember.stableId
    )), 'the JSX property must resolve to the declared Props member');

    const callbackCall = graph.entities.find((entity) => (
      entity.labels.includes('Call') && entity.props.name === 'onSubmitProp'
    ));
    assert.ok(callbackCall);
    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'CALLS'
      && relationship.fromId === callbackCall.stableId
      && relationship.toId === implementation.stableId
    )), 'the prop invocation must resolve to the concrete callback implementation');
    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'BINDS_TO_PARAMETER'
      && relationship.toId === helpers.stableId
      && entityById.get(relationship.fromId)?.labels.includes('ArgumentValue')
      && entityById.get(relationship.fromId)?.props.index === 1
    )), 'the helpers argument must bind to helpers without using structural ownership');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('a ref member write targets the concrete ref object rather than the generic current declaration', () => {
  const fixturePath = path.resolve('tmp', 'canonical-ref-write.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
type RefCell<T> = { current: T };
export function resetTimer(pendingPush: RefCell<number | null>) {
  pendingPush.current = null;
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const write = graph.entities.find((entity) => entity.labels.includes('RefWrite'));
    assert.ok(write);
    const targetEdge = graph.relationships.find((relationship) => (
      relationship.fromId === write.stableId && relationship.type === 'WRITES_TO'
    ));
    assert.ok(targetEdge);
    assert.equal(targetEdge.props.memberName, 'current');
    assert.equal(targetEdge.props.targetKind, 'ref-object');
    const target = graph.entities.find((entity) => entity.stableId === targetEdge.toId);
    assert.ok(target?.labels.includes('ValueReference'));
    assert.equal(target?.props.name, 'pendingPush');
    assert.ok(graph.relationships.some((relationship) => (
      relationship.fromId === target.stableId && relationship.type === 'RESOLVES_TO'
    )));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('rest arguments forwarded into a callback bind to its concrete parameters', () => {
  const fixturePath = path.resolve('tmp', 'canonical-rest-callback-forwarding.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function schedule(callback: (...args: any[]) => void, delay: number, ...args: any[]): void;
type RefCell<T> = { current: T };
export function showHint(mode: string, hint: RefCell<string | false>) {
  schedule((forwardedMode, hintRef) => {
    hintRef.current = forwardedMode;
  }, 10, mode, hint);
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const hintArgument = graph.entities.find((entity) => (
      entity.labels.includes('ArgumentValue')
      && entity.props.syntax === 'hint'
      && entity.props.index === 3
    ));
    const hintRefParameter = graph.entities.find((entity) => (
      entity.labels.includes('Parameter') && entity.props.name === 'hintRef'
    ));
    assert.ok(hintArgument);
    assert.ok(hintRefParameter);
    assert.ok(graph.relationships.some((relationship) => (
      relationship.type === 'BINDS_TO_PARAMETER'
      && relationship.fromId === hintArgument.stableId
      && relationship.toId === hintRefParameter.stableId
      && relationship.props.callArgumentIndex === 3
      && relationship.props.index === 1
      && relationship.props.resolution === 'typescript-checker-rest-callback-forwarding'
    )));
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});

test('generic calls instantiate only the overload selected by TypeScript', () => {
  const fixturePath = path.resolve('tmp', 'canonical-overload-resolution.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `
declare function choose<T>(initial: T): T;
declare function choose<T = undefined>(): T | undefined;
export const selected = choose<string>('prompt');
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    });
    const graph = collectCanonicalReferenceGraph(program);
    const genericUse = graph.entities.find((entity) => (
      entity.labels.includes('GenericUse') && entity.props.syntax === "choose<string>('prompt')"
    ));
    assert.ok(genericUse);
    const targets = graph.relationships
      .filter((relationship) => relationship.fromId === genericUse.stableId && relationship.type === 'INSTANTIATES')
      .map((relationship) => graph.entities.find((entity) => entity.stableId === relationship.toId)?.props.syntax);
    assert.deepEqual(targets, ['declare function choose<T>(initial: T): T;']);
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
});
