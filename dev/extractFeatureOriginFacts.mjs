import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const workspaceRoot = process.cwd();
const codeqlFactsPath = path.join(workspaceRoot, '.cache', 'codeql', 'results', 'parameterized-storage-accessor-calls.facts.json');
const outputPath = path.join(workspaceRoot, '.cache', 'feature-origins', 'feature-origin-facts.json');

function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function compactKey(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.$/@:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function flowSettingStableId(subkind, key) {
  return `flow-setting:${compactKey(subkind)}:${compactKey(key)}`;
}

function sourceInfo(relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  if (!existsSync(absolutePath)) return null;
  return {
    repoRelativePath: relativePath.replace(/\\/g, '/'),
    text: readFileSync(absolutePath, 'utf8'),
  };
}

function detectGrowthBookRuntimeOrigins() {
  const source = sourceInfo('services/analytics/growthbook.ts');
  if (!source) return [];
  const file = ts.createSourceFile(source.repoRelativePath, source.text, ts.ScriptTarget.Latest, true);
  const facts = [];

  function pushFact(kind, name, node) {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    facts.push({
      kind,
      name,
      provider: 'GrowthBook',
      repoRelativePath: source.repoRelativePath,
      line: line + 1,
      column: character + 1,
    });
  }

  function expressionText(node) {
    return node.getText(file);
  }

  function visit(node) {
    if (ts.isNewExpression(node) && expressionText(node.expression) === 'GrowthBook') {
      pushFact('runtime-provider-client', 'GrowthBook', node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (name === 'remoteEvalFeatureValues') pushFact('runtime-cache', name, node);
      if (name === 'experimentDataByFeature') pushFact('runtime-cache', name, node);
      if (name === 'pendingExposures') pushFact('runtime-cache', name, node);
    }
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'process'
      && node.expression.name.text === 'env'
      && node.name.text === 'CLAUDE_INTERNAL_FC_OVERRIDES'
    ) {
      pushFact('runtime-env-override', 'CLAUDE_INTERNAL_FC_OVERRIDES', node);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'growthBookOverrides') {
      pushFact('runtime-config-override', 'growthBookOverrides', node);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'cachedGrowthBookFeatures') {
      pushFact('runtime-disk-cache', 'cachedGrowthBookFeatures', node);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'cachedStatsigGates') {
      pushFact('runtime-disk-cache', 'cachedStatsigGates', node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

  const seen = new Set();
  return facts.filter((fact) => {
    const key = `${fact.kind}:${fact.name}:${fact.repoRelativePath}:${fact.line}:${fact.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function originNode({
  stableId,
  labels,
  resourceKind,
  resourceSubkind,
  resourceName,
  repoRelativePath = null,
  semanticId = null,
  semanticDetailId = null,
}) {
  return {
    stableId,
    labels: ['FeatureOrigin', ...labels],
    parentFnStableId: null,
    repoRelativePath,
    resourceKind,
    resourceSubkind,
    resourceName,
    settingKind: null,
    settingSubkind: null,
    settingName: null,
    resourceSemanticId: semanticId,
    resourceSemanticDetailId: semanticDetailId,
    parentStableId: null,
    resourceCellName: null,
    resourceCellKind: null,
    settingCellName: null,
    settingCellKind: null,
  };
}

function originEdge(sourceStableId, targetStableId, relType, label, calleeText) {
  return {
    sourceStableId,
    targetStableId,
    relType,
    label,
    calleeText,
  };
}

function buildFacts() {
  const storageFacts = readJsonIfExists(codeqlFactsPath, { rows: [] });
  const rows = Array.isArray(storageFacts) ? storageFacts : storageFacts.rows || [];
  const runtimeFeatureKeys = new Set();

  for (const row of rows) {
    const key = String(row.keyLiteral || row.keyExpression || '').replace(/^['"`]|['"`]$/g, '').trim();
    if (!key) continue;
    if (row.storageClass === 'runtime-feature-store') {
      runtimeFeatureKeys.add(key);
    }
  }

  const nodesById = new Map();
  const edges = [];
  function addNode(node) {
    nodesById.set(node.stableId, node);
  }
  function addEdge(edge) {
    edges.push(edge);
  }

  const runtimeOrigins = detectGrowthBookRuntimeOrigins();
  const growthBookProviderId = 'feature-origin:runtime-provider:growthbook';
  addNode(originNode({
    stableId: growthBookProviderId,
    labels: ['External', 'Runtime', 'FeatureProvider'],
    resourceKind: 'feature-origin',
    resourceSubkind: 'runtime-provider',
    resourceName: 'GrowthBook',
    repoRelativePath: 'services/analytics/growthbook.ts',
    semanticId: 'GrowthBook',
    semanticDetailId: 'remote-eval',
  }));

  const runtimeOriginByName = new Map();
  for (const origin of runtimeOrigins) {
    const id = `feature-origin:${origin.kind}:${compactKey(origin.name)}`;
    runtimeOriginByName.set(`${origin.kind}:${origin.name}`, id);
    const labels = [];
    if (origin.kind.includes('override')) labels.push('FeatureOverride');
    else if (origin.kind.includes('cache')) labels.push('FeatureCache');
    else labels.push('Runtime', 'FeatureProvider');
    addNode(originNode({
      stableId: id,
      labels,
      resourceKind: 'feature-origin',
      resourceSubkind: origin.kind,
      resourceName: origin.name,
      repoRelativePath: origin.repoRelativePath,
      semanticId: origin.name,
      semanticDetailId: `${origin.line}:${origin.column}`,
    }));
  }

  for (const key of runtimeFeatureKeys) {
    const targetStableId = flowSettingStableId('feature-flags', key);
    addEdge(originEdge(growthBookProviderId, targetStableId, 'PROVIDES', 'provides runtime feature', 'GrowthBook remote eval'));
    for (const [originKey, originId] of runtimeOriginByName.entries()) {
      const relType = originKey.includes('override') ? 'OVERRIDES' : originKey.includes('cache') ? 'CACHES' : 'FEEDS';
      addEdge(originEdge(originId, targetStableId, relType, relType.toLowerCase(), originKey.split(':').slice(1).join(':')));
    }
  }

  const edgeSeen = new Set();
  return {
    generatedAt: new Date().toISOString(),
    source: 'structural/feature-origin-facts',
    description: 'Origin/provider facts for runtime feature settings, derived from CodeQL storage facts plus AST evidence in the repo.',
    summary: {
      runtimeFeatureKeys: runtimeFeatureKeys.size,
      originNodes: nodesById.size,
    },
    originNodes: Array.from(nodesById.values()),
    originEdges: edges.filter((edge) => {
      const key = `${edge.sourceStableId}->${edge.relType}->${edge.targetStableId}`;
      if (edgeSeen.has(key)) return false;
      edgeSeen.add(key);
      return true;
    }),
  };
}

const facts = buildFacts();
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(facts, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, outputPath, ...facts.summary }));
