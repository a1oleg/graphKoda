import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { transformAsync } from '@babel/core';
import instrumentation from './babelNodePassInstrumentationPlugin.mjs';

process.env.COLDKODE_SOURCE_ROOT = process.cwd();
process.env.GRAPH_NODE_LOGGING = '1';
process.env.GRAPH_NODE_LOGGING_DEBUG = '1';
process.env.GRAPH_RUNTIME_SESSION_ID = `fisher-${randomUUID()}`;
const filePath = 'examples/fisher-yates/src/shuffle.ts';
const filename = path.resolve(filePath);
const source = await fs.readFile(filename, 'utf8');
const healthUrl = new URL('/health', process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787');
const health = await fetch(healthUrl);
assert(health.ok, 'Start the Redis runtime relay before running Fisher');
const program = ts.createProgram([filename], { target: ts.ScriptTarget.ES2022, types: [] });
const sourceFile = program.getSourceFile(filename);
const { extractFunctionFlowGraphs, payloadForTransport } = await import('../graph/static-extract/ts/fromASTtoPreGraphFlow.ts');
const graph = payloadForTransport(extractFunctionFlowGraphs(program));
const targets = [];
const location = node => {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.end);
  return { startLine: start.line + 1, startColumn: start.character, endLine: end.line + 1, endColumn: end.character };
};
const graphNode = (node, label) => {
  const loc = location(node);
  return graph.nodes.find(n => (!label || n.labels.includes(label))
    && Object.entries(loc).every(([key, value]) => n[key] === value) && !n.labels.includes('Step'));
};
for (const fn of sourceFile.statements.filter(ts.isFunctionDeclaration)) {
  const owner = graph.functions.find(f => f.name === fn.name.text);
  const add = (node, fact, instrumentationKind, role, extra = {}) => {
    if (!fact) throw new Error(`Missing extracted node: ${node.getText(sourceFile)}`);
    targets.push({ ...location(node), filePath, stableId: fact.stableId, ownerFnStableId: owner.stableId,
      ownerStepStableId: fact.parentStepStableId || '', instrumentationKind, role, ...extra });
  };
  const keyword = fn.getChildren(sourceFile).find(n => n.kind === ts.SyntaxKind.FunctionKeyword);
  add(fn, owner, 'function-entry', 'function', { ...location(keyword), endLine: location(fn).endLine, endColumn: location(fn).endColumn, startsChain: true });
  for (const parameter of fn.parameters) add(parameter, graphNode(parameter, 'Parameter'), 'parameter-value', 'parameter-value', { variableName: parameter.name.getText(sourceFile) });
  const walk = node => {
    if (ts.isForStatement(node)) add(node, graphNode(node, 'For'), 'for-iteration', 'loop', {
      iterationGuardStableId: graphNode(node.condition, 'Branch').stableId,
      variableName: ts.isBinaryExpression(node.condition) && ts.isPropertyAccessExpression(node.condition.left)
        ? node.condition.left.expression.getText(sourceFile) : undefined,
    });
    else if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      add(node.name, graphNode(node.name, 'ValueCreate'), 'binding-value', 'set-value', { variableName: node.name.text });
    } else if (ts.isReturnStatement(node) && node.expression) {
      add(node.expression, graphNode(node, 'Return'), 'expression', 'return');
    } else if (ts.isExpressionStatement(node)) {
      const call = ts.isCallExpression(node.expression);
      const firstArgument = call ? node.expression.arguments[0] : null;
      const assigned = ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? ts.isIdentifier(node.expression.left) ? node.expression.left.text
          : ts.isPropertyAccessExpression(node.expression.left) && ts.isIdentifier(node.expression.left.expression)
            ? node.expression.left.expression.text : null : null;
      add(node.expression, graphNode(node.expression) || graphNode(node), 'expression', 'set-value', {
        variableName: assigned || (call && firstArgument ? firstArgument.getText(sourceFile) : node.expression.getText(sourceFile)),
        ...(assigned ? { valueBinding: assigned } : {}),
        ...(firstArgument && ts.isIdentifier(firstArgument) ? { valueBinding: firstArgument.text } : {}),
      });
    } else if (ts.isForStatement(node.parent) && node.parent.condition === node) {
      const declaration = node.parent.initializer?.declarations?.[0];
      const initializer = declaration?.initializer;
      const length = initializer && ts.isBinaryExpression(initializer) ? initializer.left : null;
      const collection = length && ts.isPropertyAccessExpression(length) && length.name.text === 'length'
        && ts.isIdentifier(length.expression) ? length.expression.text : null;
      add(node, graphNode(node, 'Branch'), 'expression', 'predicate', collection ? {
        iterationCollection: collection, iterationBinding: declaration.name.text,
      } : ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) ? {
        iterationBinding: node.left.expression.getText(sourceFile),
      } : {});
    } else if (ts.isForStatement(node.parent) && node.parent.incrementor === node) {
      add(node, graphNode(node), 'expression', 'set-value', {
        variableName: ts.isPropertyAccessExpression(node.operand) ? node.operand.expression.getText(sourceFile) : node.operand.getText(sourceFile),
        valueBinding: ts.isPropertyAccessExpression(node.operand) ? node.operand.expression.getText(sourceFile) : node.operand.getText(sourceFile),
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(fn.body);
}
const result = await transformAsync(source, { filename, configFile: false, babelrc: false,
  parserOpts: { plugins: ['typescript'] }, plugins: [[instrumentation, { targets }]], retainLines: true });
const instrumented = new Set(result.metadata.nodePassInstrumentation.stableIds);
assert.deepEqual(targets.filter(t => !instrumented.has(t.stableId)), [], 'Babel missed extraction targets');
const outputDir = path.resolve('tmp/fisher-yates/runtime');
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'targets.json'), JSON.stringify(targets, null, 2));
const compiled = ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const output = path.join(outputDir, 'shuffle.instrumented.mjs');
await fs.writeFile(output, compiled);
const reporter = await import('./runtimeNodePassReporter.mjs');
assert(reporter.installRuntimeNodePassReporter());
const { shuffle } = await import(pathToFileURL(output));
const alphabet = shuffle();
await reporter.flushPendingNodePassEvents();
assert.deepEqual([...alphabet].sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
const sessionId = process.env.GRAPH_RUNTIME_SESSION_ID;
const root = graph.functions.find(f => f.name === 'shuffle').stableId;
const loop = targets.find(t => t.instrumentationKind === 'for-iteration').stableId;
const query = async (endpoint, stableId) => {
  const url = new URL(endpoint, process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787');
  url.searchParams.set('stableId', stableId); url.searchParams.set('sessionId', sessionId);
  const response = await fetch(url); const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
  return body;
};
let analysis;
for (let attempt = 0; attempt < 40; attempt++) {
  analysis = (await query('/runtime-analysis', loop)).analysis;
  if (analysis.totalIterations === 7) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert.equal(analysis.totalIterations, 7);
assert.deepEqual(analysis.conditionChecks, { total: 8, true: 7, false: 1 });
assert.deepEqual(analysis.iterations.map(i => JSON.parse(i.itemPreview).current.index), [7, 6, 5, 4, 3, 2, 1]);
assert.deepEqual(JSON.parse(analysis.cases[0].itemPreview).current, { index: 7, value: 'H' });
assert(analysis.iterations.every(c => Number.isInteger(JSON.parse(c.variableValues.random))));
assert.equal(analysis.totalCases, 8);
assert.deepEqual(analysis.cases.map(c => c.transition), [...Array(7).fill('continue'), 'break']);
assert.deepEqual(JSON.parse(analysis.cases.at(-1).itemPreview).current, { index: 0, value: JSON.parse(analysis.iterations.at(-1).itemPreview).current.value });
assert.deepEqual(analysis.variableColumns, ['random']);
let beforeIteration = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
for (const c of analysis.cases) {
  const pair = JSON.parse(c.itemPreview).current;
  if (c.terminal) {
    assert.equal(c.variableValues.random, undefined);
  } else {
    assert.equal(pair.value, beforeIteration[pair.index], 'Capture the letter before swap, not after it');
    const random = JSON.parse(c.variableValues.random);
    assert(random >= 0 && random <= pair.index);
    beforeIteration = JSON.parse(c.events.find(event => event.stableId.endsWith(':9:4:9:35')).valuePreview);
  }
}
assert(analysis.cases.slice(0, 7).every(c => c.edgePairs.length === 5 && c.edgePairs.at(-1).edgeType === 'REPEATS'));
assert.deepEqual(analysis.cases.at(-1).edgePairs.map(e => e.edgeType), ['FALSE']);
const trace = (await query('/runtime-trace', root)).trace;
const values = (await query('/runtime-values', root)).values;
assert(trace.chain.length > 7);
assert(values.values.length > 0);
assert.equal(JSON.parse(values.values.find(v => v.stableId.endsWith(':6:28:6:43')).valuePreview).index, 0);
assert.deepEqual(JSON.parse(values.values.find(v => v.stableId.endsWith(':9:4:9:35')).valuePreview), alphabet);
assert(analysis.iterations.every(i => !i.staticStableIds.some(id => id.includes(':12:2:12:18'))), 'Return must not be part of every iteration');
const report = { sessionId, root, loop, alphabet, targets: targets.length, trace, values, analysis };
await fs.writeFile(path.join(outputDir, 'latest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sessionId, alphabet, instrumented: targets.length, traceEvents: trace.chain.length, values: values.values.length, iterations: analysis.totalIterations, report: path.join(outputDir, 'latest.json') }, null, 2));
