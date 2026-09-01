import fs from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';

import { normalizeStableId } from '../graph/packages/runtime-core/src/stableId.js';

const OWNER_FN_STABLE_ID = 'screens/REPL.tsx:3142:31:3533:3';
const SOURCE_PATH = 'screens/REPL.tsx';
const graphPath = path.resolve(process.argv[2] || 'tmp/onSubmit-flow.json');
const outputPath = path.resolve(process.argv[3] || 'graph/instrumentation/node-pass-targets.json');
const source = fs.readFileSync(path.resolve(SOURCE_PATH), 'utf8');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const previous = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : { targets: [] };

const TARGET_STABLE_ID_KEYS = [
  'stableId',
  'ownerFnStableId',
  'pullStableId',
  'iterationValueStableId',
  'iterationGuardStableId',
  'callbackStableId',
  'accumulatorStableId',
  'resultStableId',
  'trueTargetStableId',
  'falseTargetStableId',
  'iterationOutcomeStableId',
];

function canonicalizeTarget(target) {
  const canonical = { ...target };
  for (const key of TARGET_STABLE_ID_KEYS) {
    if (typeof canonical[key] !== 'string') continue;
    canonical[key] = normalizeStableId(canonical[key], {
      sourceFilePath: canonical.filePath || SOURCE_PATH,
    });
  }
  return canonical;
}

const ast = parse(source, {
  sourceType: 'module',
  plugins: ['typescript', 'jsx'],
});

function locationKey(node) {
  if (!node?.loc) return '';
  return `${node.loc.start.line}:${node.loc.start.column}:${node.loc.end.line}:${node.loc.end.column}`;
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, ancestors);
  const childAncestors = typeof node.type === 'string' ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit, childAncestors));
    else if (value && typeof value === 'object') walk(value, visit, childAncestors);
  }
}

let onSubmitCallback;
walk(ast.program, (node) => {
  if (
    node.type === 'VariableDeclarator'
    && node.id?.type === 'Identifier'
    && node.id.name === 'onSubmit'
    && node.init?.type === 'CallExpression'
  ) {
    onSubmitCallback = node.init.arguments.find((argument) => (
      argument?.type === 'ArrowFunctionExpression' || argument?.type === 'FunctionExpression'
    ));
  }
});
if (!onSubmitCallback) throw new Error('Could not locate the onSubmit callback');

const graphNodesByLocation = new Map();
for (const node of graph.nodes || []) {
  if (node.parentFnStableId !== OWNER_FN_STABLE_ID || node.repoRelativePath !== SOURCE_PATH) continue;
  const key = `${node.startLine}:${node.startColumn}:${node.endLine}:${node.endColumn}`;
  const entries = graphNodesByLocation.get(key) || [];
  entries.push(node);
  graphNodesByLocation.set(key, entries);
}

function isExpression(node) {
  return (node.type === 'Identifier' || /Expression$/.test(node.type))
    && !['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'JSXExpressionContainer'].includes(node.type);
}

function candidateScore(candidate, astNode) {
  const labels = new Set(candidate.labels || []);
  let score = 0;
  if (labels.has('VisualProxy') || labels.has('ExecutionOccurrence') || labels.has('ArgumentOccurrence')) score -= 500;
  if (candidate.stableId?.startsWith('flow:')) score -= 100;
  if (labels.has('Branch')) score += astNode.type.includes('Logical') || astNode.type.includes('Binary') || astNode.type.includes('Unary') ? 240 : 100;
  if (astNode.type.includes('Call') && candidate.operationCode === 'CALL') score += 260;
  if (astNode.type.includes('Call') && (labels.has('Call') || labels.has('Request') || labels.has('PredicateCall'))) score += 180;
  if (astNode.type.includes('Assignment') && labels.has('Action')) score += 220;
  if (labels.has('Start')) score += 40;
  if (labels.has('Join') || labels.has('Field') || labels.has('Arg')) score -= 30;
  score -= String(candidate.stableId || '').length / 10_000;
  return score;
}

function selectGraphNode(astNode) {
  const keys = [locationKey(astNode)];
  if (astNode.type === 'UnaryExpression' && astNode.loc) {
    keys.push(`${astNode.loc.start.line}:${astNode.loc.start.column + astNode.operator.length}:${astNode.loc.end.line}:${astNode.loc.end.column}`);
  }
  const candidates = keys.flatMap((key) => graphNodesByLocation.get(key) || []);
  return [...candidates]
    .sort((left, right) => candidateScore(right, astNode) - candidateScore(left, astNode))[0] || null;
}

function normalizedExpressionText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function isLoopOwnedSet(graphNode, ancestors) {
  const labels = new Set(graphNode?.labels || []);
  const parentStepStableId = String(graphNode?.parentStepStableId || '');
  return parentStepStableId.startsWith('flow-step:loop:')
    || (labels.has('Iteration') && labels.has('SubStepMember'))
    || ancestors.some((ancestor) => (
      ancestor.type === 'ForStatement'
      || ancestor.type === 'ForInStatement'
      || ancestor.type === 'ForOfStatement'
      || ancestor.type === 'WhileStatement'
      || ancestor.type === 'DoWhileStatement'
    ));
}

function setTarget(graphNode, astNode, variableName, instrumentationKind, valuePath = '') {
  return {
    stableId: graphNode.stableId,
    ownerFnStableId: OWNER_FN_STABLE_ID,
    ownerStepStableId: graphNode.parentStepStableId || '',
    variableName,
    ...(valuePath ? { valuePath } : {}),
    filePath: SOURCE_PATH,
    startLine: astNode.loc.start.line,
    startColumn: astNode.loc.start.column,
    endLine: astNode.loc.end.line,
    endColumn: astNode.loc.end.column,
    role: 'set-value',
    stageName: variableName,
    instrumentationKind,
    startsChain: false,
    autoGenerated: true,
  };
}

function predicateInstrumentationNode(astNode, ancestors, graphNode) {
  if (!(graphNode.labels || []).includes('Branch')) return astNode;
  if (astNode.type === 'ConditionalExpression') return astNode.test;
  if (astNode.type === 'LogicalExpression' && astNode.operator === '??') return astNode.left;
  const expected = normalizedExpressionText(
    graphNode.diaName || graphNode.actionTextRaw || graphNode.label,
  );
  if (!expected) return astNode;
  const candidates = [astNode, ...[...ancestors].reverse()]
    .filter((candidate) => isExpression(candidate));
  return candidates.find((candidate) => (
    normalizedExpressionText(source.slice(candidate.start, candidate.end)) === expected
  )) || astNode;
}

const manualTargets = (previous.targets || [])
  .filter((target) => target.autoGenerated !== true)
  .map((target) => canonicalizeTarget({ ...target, startsChain: false }));
const occupiedLocations = new Set(manualTargets.map((target) => (
  `${target.startLine}:${target.startColumn}:${target.endLine}:${target.endColumn}`
)));
const occupiedStableIds = new Set(manualTargets.map((target) => target.stableId));
const specializedBoundaries = manualTargets.filter((target) => (
  target.instrumentationKind === 'collection-iteration'
  || target.instrumentationKind === 'for-of-iteration'
));
const generatedTargets = [];

function isInsideSpecializedBoundary(node) {
  if (!node.loc) return false;
  return specializedBoundaries.some((target) => {
    const startsInside = node.loc.start.line > target.startLine
      || (node.loc.start.line === target.startLine && node.loc.start.column >= target.startColumn);
    const endsInside = node.loc.end.line < target.endLine
      || (node.loc.end.line === target.endLine && node.loc.end.column <= target.endColumn);
    const isBoundary = node.loc.start.line === target.startLine
      && node.loc.start.column === target.startColumn
      && node.loc.end.line === target.endLine
      && node.loc.end.column === target.endColumn;
    return startsInside && endsInside && !isBoundary;
  });
}

generatedTargets.push({
  stableId: OWNER_FN_STABLE_ID,
  ownerFnStableId: OWNER_FN_STABLE_ID,
  filePath: SOURCE_PATH,
  startLine: onSubmitCallback.loc.start.line,
  startColumn: onSubmitCallback.loc.start.column,
  endLine: onSubmitCallback.loc.end.line,
  endColumn: onSubmitCallback.loc.end.column,
  role: 'function',
  startsChain: true,
  instrumentationKind: 'function-entry',
  autoGenerated: true,
});

for (const parameter of onSubmitCallback.params) {
  if (parameter.type !== 'Identifier') continue;
  const graphNode = selectGraphNode(parameter);
  if (!graphNode || !(graphNode.labels || []).includes('Parameter')) continue;
  generatedTargets.push({
    stableId: graphNode.stableId,
    ownerFnStableId: OWNER_FN_STABLE_ID,
    ownerStepStableId: graphNode.parentStepStableId || '',
    variableName: graphNode.diaName || parameter.name,
    filePath: SOURCE_PATH,
    startLine: parameter.loc.start.line,
    startColumn: parameter.loc.start.column,
    endLine: parameter.loc.end.line,
    endColumn: parameter.loc.end.column,
    role: 'parameter-value',
    stageName: graphNode.diaName || parameter.name,
    instrumentationKind: 'parameter-value',
    startsChain: false,
    autoGenerated: true,
  });
}

walk(onSubmitCallback.body, (node, ancestors) => {
  if (
    node.type === 'VariableDeclarator'
    && node.id?.type === 'ObjectPattern'
    && node.init
    && node.id.properties.length === 1
    && node.id.properties[0]?.type === 'ObjectProperty'
    && node.id.properties[0].value?.type === 'Identifier'
  ) {
    const binding = node.id.properties[0].value;
    const graphNode = selectGraphNode(binding);
    const labels = new Set(graphNode?.labels || []);
    const key = locationKey(node.id);
    if (
      graphNode
      && labels.has('Assignment')
      && (labels.has('Set') || labels.has('ValueCreate'))
      && !isLoopOwnedSet(graphNode, ancestors)
      && key
      && !occupiedLocations.has(key)
      && !occupiedStableIds.has(graphNode.stableId)
    ) {
      generatedTargets.push(setTarget(
        graphNode,
        node.id,
        graphNode.diaName || binding.name,
        'binding-value',
        binding.name,
      ));
      occupiedLocations.add(key);
      occupiedStableIds.add(graphNode.stableId);
    }
    return;
  }
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
    const graphNode = selectGraphNode(node.id);
    const labels = new Set(graphNode?.labels || []);
    const key = locationKey(node.id);
    if (
      graphNode
      && labels.has('Assignment')
      && (labels.has('Set') || labels.has('ValueCreate'))
      && !isLoopOwnedSet(graphNode, ancestors)
      && key
      && !occupiedLocations.has(key)
      && !occupiedStableIds.has(graphNode.stableId)
    ) {
      generatedTargets.push(setTarget(
        graphNode,
        node.id,
        graphNode.diaName || node.id.name,
        'binding-value',
      ));
      occupiedLocations.add(key);
      occupiedStableIds.add(graphNode.stableId);
    }
    return;
  }
  if (node.type === 'AssignmentExpression') {
    const graphNode = selectGraphNode(node) || selectGraphNode(node.left);
    const labels = new Set(graphNode?.labels || []);
    const key = locationKey(node);
    if (
      graphNode
      && labels.has('Assignment')
      && (labels.has('Set') || labels.has('ValueCreate'))
      && !isLoopOwnedSet(graphNode, ancestors)
      && key
      && !occupiedLocations.has(key)
      && !occupiedStableIds.has(graphNode.stableId)
    ) {
      const variableName = graphNode.diaName
        || source.slice(node.left.start, node.left.end)
        || 'value';
      generatedTargets.push(setTarget(graphNode, node, variableName, 'set-value'));
      occupiedLocations.add(key);
      occupiedStableIds.add(graphNode.stableId);
    }
    return;
  }
  if (!isExpression(node) || node.type === 'AwaitExpression') return;
  if (isInsideSpecializedBoundary(node)) return;
  const key = locationKey(node);
  if (!key || occupiedLocations.has(key)) return;
  const graphNode = selectGraphNode(node);
  if (!graphNode || occupiedStableIds.has(graphNode.stableId)) return;
  const labels = new Set(graphNode.labels || []);
  const instrumentationNode = predicateInstrumentationNode(node, ancestors, graphNode);
  const instrumentationKey = locationKey(instrumentationNode);
  if (!instrumentationKey || occupiedLocations.has(instrumentationKey)) return;
  const executable = labels.has('Branch')
    || labels.has('Call')
    || labels.has('Request')
    || labels.has('Action')
    || graphNode.operationCode === 'CALL';
  if (!executable) return;

  generatedTargets.push({
    stableId: graphNode.stableId,
    ownerFnStableId: OWNER_FN_STABLE_ID,
    filePath: SOURCE_PATH,
    startLine: instrumentationNode.loc.start.line,
    startColumn: instrumentationNode.loc.start.column,
    endLine: instrumentationNode.loc.end.line,
    endColumn: instrumentationNode.loc.end.column,
    role: labels.has('Branch') ? 'predicate' : labels.has('Action') ? 'effect' : 'call',
    stageName: graphNode.diaName || graphNode.calleeName || graphNode.actionTextRaw || node.type,
    instrumentationKind: 'expression',
    ...(node.type === 'LogicalExpression' && node.operator === '??'
      ? { predicateOutcomeMode: 'non-nullish' }
      : {}),
    startsChain: false,
    autoGenerated: true,
  });
  occupiedLocations.add(instrumentationKey);
  occupiedStableIds.add(graphNode.stableId);
});

const targets = [...manualTargets, ...generatedTargets]
  .map(canonicalizeTarget)
  .sort((left, right) => (
  left.startLine - right.startLine
  || left.startColumn - right.startColumn
  || left.endLine - right.endLine
  || left.endColumn - right.endColumn
  || String(left.stableId).localeCompare(String(right.stableId))
  ));
const output = {
  version: 4,
  generatedFrom: path.relative(process.cwd(), graphPath).replace(/\\/g, '/'),
  ownerFnStableId: OWNER_FN_STABLE_ID,
  targetCount: targets.length,
  manualTargetCount: manualTargets.length,
  autoTargetCount: generatedTargets.length,
  targets,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  outputPath,
  targetCount: targets.length,
  manualTargetCount: manualTargets.length,
  autoTargetCount: generatedTargets.length,
}, null, 2));
