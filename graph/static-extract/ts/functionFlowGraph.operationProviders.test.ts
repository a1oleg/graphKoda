import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import { extractFunctionFlowGraphs } from './fromASTtoPreGraphFlow.ts';

test('classifies required module facades and callable parameter bundles as operation providers', () => {
  const fixturePath = path.resolve('tmp', 'function-flow-operation-providers.fixture.ts');
  const typesFixturePath = path.resolve('tmp', 'function-flow-operation-provider-types.fixture.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(typesFixturePath, `
export type Helpers = {
  clearBuffer: () => void;
  resetHistory: () => void;
};
export type RemoteTransport = {
  isRemoteMode: boolean;
  sendMessage: (content: string) => Promise<boolean>;
  cancelRequest: () => void;
  disconnect: () => void;
};
`, 'utf8');
  fs.writeFileSync(fixturePath, `
declare function require(name: string): any;
declare const enabled: boolean;
declare const state: { current: number };
import type { Helpers, RemoteTransport } from './function-flow-operation-provider-types.fixture.js';

const optionalModule = enabled ? require('./optional.js') : null;
declare function makeSshRemote(): RemoteTransport;
declare function makeDirectRemote(): RemoteTransport;
declare function makeRemoteSession(): RemoteTransport;

export async function subject(helpers: Helpers) {
  const sshRemote = makeSshRemote();
  const directRemote = makeDirectRemote();
  const remoteSession = makeRemoteSession();
  const activeRemote = sshRemote.isRemoteMode
    ? sshRemote
    : directRemote.isRemoteMode
      ? directRemote
      : remoteSession;
  optionalModule?.resume();
  helpers.clearBuffer();
  void activeRemote.sendMessage('payload');
  await activeRemote.sendMessage('awaited');
  return Math.round((Date.now() - state.current) / 60_000);
}
`, 'utf8');

  try {
    const program = ts.createProgram([fixturePath, typesFixturePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      skipLibCheck: true,
    });
    const payload = extractFunctionFlowGraphs(program);
    const moduleCall = payload.nodes.find((node) => node.actionTextRaw === 'optionalModule?.resume()');
    const helperCall = payload.nodes.find((node) => node.actionTextRaw === 'helpers.clearBuffer()');
    const remoteCall = payload.nodes.find((node) => node.actionTextRaw === "activeRemote.sendMessage('payload')");

    assert.ok(moduleCall);
    assert.ok(moduleCall.labels.includes('OperationProvider'));
    assert.ok(moduleCall.labels.includes('ModuleFacade'));
    assert.ok(helperCall);
    assert.ok(helperCall.labels.includes('OperationProvider'));
    assert.ok(helperCall.labels.includes('CapabilityBundle'));
    assert.ok(!helperCall.labels.includes('System'));
    assert.ok(remoteCall);
    assert.ok(remoteCall.labels.includes('OperationProvider'));
    assert.ok(remoteCall.labels.includes('CapabilityBundle'));
    assert.ok(!remoteCall.labels.includes('System'));

    const moduleReceiver = payload.nodes.find((node) => node.sourceCallStableId === moduleCall.stableId.value);
    const helperReceiver = payload.nodes.find((node) => node.sourceCallStableId === helperCall.stableId.value);
    assert.ok(moduleReceiver?.labels.includes('ModuleFacade'));
    assert.ok(helperReceiver?.labels.includes('CapabilityBundle'));

    const moduleParts = JSON.parse(moduleCall.renderPartsJson || '[]') as Array<{ kind?: string; labels?: string[] }>;
    const helperParts = JSON.parse(helperCall.renderPartsJson || '[]') as Array<{ kind?: string; labels?: string[] }>;
    const remoteParts = JSON.parse(remoteCall.renderPartsJson || '[]') as Array<{ kind?: string; labels?: string[] }>;
    assert.ok(moduleParts.some((part) => part.labels?.includes('ModuleFacade')));
    assert.ok(helperParts.some((part) => part.labels?.includes('CapabilityBundle')));
    assert.equal(moduleCall.renderPartsLayout, 'container-overlay-side');
    assert.equal(helperCall.renderPartsLayout, 'container-overlay-side');
    assert.equal(moduleParts[0]?.kind, 'operation-provider-container');
    assert.equal(helperParts[0]?.kind, 'operation-provider-container');
    assert.equal(remoteParts[0]?.kind, 'operation-provider-container');

    const awaitedRemoteCall = payload.nodes.find(
      (node) => node.actionTextRaw === "activeRemote.sendMessage('awaited')",
    );
    assert.ok(awaitedRemoteCall);
    const awaitedRemoteParts = JSON.parse(awaitedRemoteCall.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.equal(awaitedRemoteParts[0]?.text, 'activeRemote');
    assert.equal(awaitedRemoteParts[0]?.kind, 'operation-provider-container');
    assert.equal(awaitedRemoteParts[1]?.text, 'await');
    assert.equal(awaitedRemoteParts[1]?.kind, 'method');
    assert.ok(awaitedRemoteParts[1]?.labels?.includes('System'));
    assert.ok(awaitedRemoteParts[1]?.labels?.includes('Keyword'));
    assert.ok(!awaitedRemoteParts[1]?.labels?.includes('Value'));

    const mathCall = payload.nodes.find((node) => node.actionTextRaw?.startsWith('Math.round('));
    assert.ok(mathCall);
    assert.ok(mathCall.labels.includes('OperationProvider'), JSON.stringify({ labels: mathCall.labels, parts: mathCall.renderPartsJson }));
    assert.ok(mathCall.labels.includes('SystemProvider'));
    assert.ok(mathCall.labels.includes('System'));
    const mathParts = JSON.parse(mathCall.renderPartsJson || '[]') as Array<{
      text?: string;
      kind?: string;
      labels?: string[];
    }>;
    assert.equal(mathParts[0]?.kind, 'value');
    assert.ok(mathParts[0]?.labels?.includes('SystemProvider'));
    assert.ok(mathParts.some((part) => part.text === 'round(' && part.labels?.includes('SystemProvider')));
    assert.deepEqual(
      mathParts.filter((part) => part.labels?.includes('ArithmeticBoundary')).map((part) => part.text),
      ['(', ')'],
    );
    assert.ok(mathParts.some((part) => part.text === '.current' && part.labels?.includes('FieldAccess')));
    const dateProvider = mathParts.find((part) => part.text === 'Date');
    assert.equal(dateProvider?.kind, 'value');
    assert.ok(dateProvider?.labels?.includes('SystemProvider'));
    const dateMethod = mathParts.find((part) => part.text === 'now()');
    assert.ok(dateMethod?.labels?.includes('SystemProvider'));
  } finally {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(typesFixturePath, { force: true });
  }
});
