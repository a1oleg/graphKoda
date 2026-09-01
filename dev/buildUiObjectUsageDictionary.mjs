import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const workspaceRoot = process.cwd();
const objectKey = process.argv[2] || 'ApiStory';
const baseUrl = process.env.UI_EXPLORER_BASE_URL || 'http://127.0.0.1:8791';
const outputDir = path.join(workspaceRoot, 'graph', 'draw', 'ui-object-usage');
dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env'), quiet: true });

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  }

  return JSON.parse(result.stdout || '{}');
}

async function fetchJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl));
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${pathname}`);
  }
  return payload;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalizeObjectToken(value) {
  return String(value || '')
    .replace(/^Api/u, '')
    .replace(/[^a-zA-Z0-9]/gu, '')
    .toLowerCase();
}

function pluralizeToken(token) {
  if (!token) return '';
  if (token.endsWith('y')) {
    return `${token.slice(0, -1)}ies`;
  }
  if (token.endsWith('s')) {
    return token;
  }
  return `${token}s`;
}

function toPlainNeo4jValue(value) {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(toPlainNeo4jValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, toPlainNeo4jValue(nestedValue)]));
  }
  return value;
}

function createNeo4jDriver() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    return undefined;
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

async function runNeo4jRead(driver, query, parameters = {}) {
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(query, parameters);
    return result.records.map((record) => Object.fromEntries(
      record.keys.map((key) => [key, toPlainNeo4jValue(record.get(key))]),
    ));
  } finally {
    await session.close();
  }
}

function groupDispatchesByAction(dispatches) {
  const grouped = new Map();
  for (const dispatch of dispatches) {
    if (!grouped.has(dispatch.actionName)) {
      grouped.set(dispatch.actionName, []);
    }
    grouped.get(dispatch.actionName).push({
      componentName: dispatch.componentName,
      componentStableId: dispatch.componentStableId,
      handlerName: dispatch.handlerName,
      handlerStableId: dispatch.handlerStableId,
      dispatchKind: dispatch.dispatchKind,
      repoRelativePath: dispatch.handlerStableId.replace(/^.*?src\//u, 'src/').replace(/:\d+:\d+:\d+:\d+$/u, ''),
      line: dispatch.line,
      column: dispatch.column,
    });
  }
  return grouped;
}

function groupTracesByFunction(traces) {
  const grouped = new Map();
  for (const trace of traces) {
    for (const functionName of trace.functionNames || []) {
      if (!grouped.has(functionName)) {
        grouped.set(functionName, []);
      }
      grouped.get(functionName).push({
        surfaceName: trace.surfaceName,
        surfaceKey: trace.surfaceKey,
        surfaceRepoRelativePath: trace.surfaceRepoRelativePath,
        ownerSurfaceKeys: trace.ownerSurfaceKeys || [],
        traceCount: trace.traceCount || 0,
      });
    }
  }
  return grouped;
}

async function buildLexicalSubstringDiagnostics({ objectKey, strictFunctionNames }) {
  const objectToken = normalizeObjectToken(objectKey);
  const pluralObjectToken = pluralizeToken(objectToken);
  const driver = createNeo4jDriver();

  const base = {
    enabled: Boolean(driver),
    objectToken,
    pluralObjectToken,
    note: 'Read-only diagnostic. Substring matching is intentionally confined to this checker and is not written to Neo4j.',
    candidates: [],
    comparison: {
      strictMethodCount: strictFunctionNames.length,
      lexicalCandidateCount: 0,
      overlapCount: 0,
      lexicalOnlyCount: 0,
      strictOnlyCount: 0,
    },
    improvementHints: [],
  };

  if (!driver || !objectToken) {
    return {
      ...base,
      disabledReason: driver ? 'Object token is empty.' : 'NEO4J_URI, NEO4J_USER/NEO4J_USERNAME, or NEO4J_PASSWORD is not configured.',
    };
  }

  try {
    const rows = await runNeo4jRead(driver, `
      WITH $objectToken AS objectToken, $pluralObjectToken AS pluralObjectToken, $objectKey AS objectKey
      MATCH (targetFn:Fn)
      WITH targetFn, objectToken, pluralObjectToken, objectKey, toLower(coalesce(targetFn.name, '')) AS targetName
      OPTIONAL MATCH (targetFn)-[targetRel:TARGETS_ACTION_FN {source: 'semantic/functionFlowGraph'}]->(:Fn)
      WITH
        targetFn,
        objectToken,
        pluralObjectToken,
        objectKey,
        targetName,
        collect(DISTINCT toLower(coalesce(targetRel.target_name, ''))) AS targetActionNames
      OPTIONAL MATCH (targetFn)-[callRel:CALLS_FN {source: 'semantic/familyUsageGraph'}]->(calledFn:Fn)
      WITH
        targetFn,
        objectToken,
        pluralObjectToken,
        objectKey,
        targetName,
        targetActionNames,
        collect(DISTINCT toLower(coalesce(calledFn.name, ''))) AS calledFunctionNames
      WITH
        targetFn,
        objectKey,
        objectToken,
        pluralObjectToken,
        targetName,
        targetActionNames,
        calledFunctionNames,
        CASE WHEN targetName CONTAINS objectToken OR targetName CONTAINS pluralObjectToken
          THEN ['target-name-substring']
          ELSE []
        END
        + CASE WHEN any(name IN targetActionNames WHERE name CONTAINS objectToken OR name CONTAINS pluralObjectToken)
          THEN ['target-action-name-substring']
          ELSE []
        END
        + CASE WHEN any(name IN calledFunctionNames WHERE name CONTAINS objectToken OR name CONTAINS pluralObjectToken)
          THEN ['called-function-name-substring']
          ELSE []
        END AS lexicalEvidenceKinds
      WHERE size(lexicalEvidenceKinds) > 0
      OPTIONAL MATCH (strict:UiObjectFunction {source: 'semantic/uiObjectFunction', domain_label: objectKey, targetFnStableId: targetFn.stableId})
      OPTIONAL MATCH (targetFn)-[:FUNCTION_RESOLVES_EXPORTED_TYPE {source: 'semantic/entityResolverGraph'}]->(resolvedType:ExportedType)
      OPTIONAL MATCH (flowObject:FlowObject {source: 'semantic/functionFlowGraph', parentFnStableId: targetFn.stableId})
      RETURN
        targetFn.name AS functionName,
        targetFn.stableId AS stableId,
        targetFn.repo_relative_path AS repoRelativePath,
        lexicalEvidenceKinds AS lexicalEvidenceKinds,
        targetActionNames AS targetActionNames,
        calledFunctionNames[0..25] AS calledFunctionNamesSample,
        strict IS NOT NULL AS coveredByStrict,
        collect(DISTINCT resolvedType.name) AS resolvedTypeNames,
        collect(DISTINCT flowObject.object_type) AS flowObjectTypes
      ORDER BY functionName, repoRelativePath
    `, { objectKey, objectToken, pluralObjectToken });

    const strictSet = new Set(strictFunctionNames);
    const lexicalSet = new Set(rows.map((row) => row.functionName).filter(Boolean));
    const overlap = [...lexicalSet].filter((name) => strictSet.has(name)).sort();
    const lexicalOnly = [...lexicalSet].filter((name) => !strictSet.has(name)).sort();
    const strictOnly = [...strictSet].filter((name) => !lexicalSet.has(name)).sort();

    const candidates = rows.map((row) => {
      const resolvedTypeNames = uniqueSorted(row.resolvedTypeNames || []);
      const flowObjectTypes = uniqueSorted(row.flowObjectTypes || []);
      const hasExactStructuralEvidence = resolvedTypeNames.includes(objectKey) || flowObjectTypes.includes(objectKey);
      return {
        functionName: row.functionName,
        stableId: row.stableId,
        repoRelativePath: row.repoRelativePath,
        lexicalEvidenceKinds: row.lexicalEvidenceKinds || [],
        coveredByStrict: Boolean(row.coveredByStrict),
        hasExactStructuralEvidence,
        resolvedTypeNames,
        flowObjectTypes,
        targetActionNames: (row.targetActionNames || []).filter(Boolean),
        calledFunctionNamesSample: (row.calledFunctionNamesSample || []).filter(Boolean),
      };
    });

    const lexicalOnlyEvidenceByFunction = new Map();
    for (const candidate of candidates.filter((item) => !strictSet.has(item.functionName))) {
      const functionName = candidate.functionName;
      if (!functionName) continue;
      lexicalOnlyEvidenceByFunction.set(
        functionName,
        Boolean(lexicalOnlyEvidenceByFunction.get(functionName)) || candidate.hasExactStructuralEvidence,
      );
    }
    const lexicalOnlyWithExactStructuralEvidence = uniqueSorted([...lexicalOnlyEvidenceByFunction.entries()]
      .filter(([, hasExactStructuralEvidence]) => hasExactStructuralEvidence)
      .map(([functionName]) => functionName));
    const lexicalOnlyWithoutExactStructuralEvidence = uniqueSorted([...lexicalOnlyEvidenceByFunction.entries()]
      .filter(([, hasExactStructuralEvidence]) => !hasExactStructuralEvidence)
      .map(([functionName]) => functionName));

    return {
      ...base,
      candidates,
      comparison: {
        strictMethodCount: strictFunctionNames.length,
        lexicalCandidateCount: lexicalSet.size,
        overlapCount: overlap.length,
        lexicalOnlyCount: lexicalOnly.length,
        strictOnlyCount: strictOnly.length,
        overlap,
        lexicalOnly,
        strictOnly,
      },
      improvementHints: [
        {
          kind: 'lexical-only-with-exact-structural-evidence',
          count: lexicalOnlyWithExactStructuralEvidence.length,
          functionNames: lexicalOnlyWithExactStructuralEvidence,
          interpretation: 'These are likely extractor/query gaps, because substring candidates also have exact Api object evidence.',
        },
        {
          kind: 'lexical-only-without-exact-structural-evidence',
          count: lexicalOnlyWithoutExactStructuralEvidence.length,
          functionNames: lexicalOnlyWithoutExactStructuralEvidence,
          interpretation: 'These are likely old false positives unless a new structural relation can explain the object use.',
        },
      ],
    };
  } finally {
    await driver.close();
  }
}

function toMarkdown(dictionary) {
  const lines = [
    `# ${dictionary.objectKey} UI Usage Dictionary`,
    '',
    `Generated from source UI dispatches via \`graph/static-extract/ts/uiIntentEntryGraph.ts\`.`,
    `Graph traces are included only as a comparison column from \`/api/ui-explorer/object-traces\`.`,
    '',
    '| Method | Source UI Uses | Current Graph UI Traces | Notes |',
    '| --- | ---: | ---: | --- |',
  ];

  for (const method of dictionary.methods) {
    const sourceUses = method.sourceUiUses
      .map((use) => `${use.componentName} (${use.repoRelativePath}:${use.line})`)
      .join('<br>');
    const graphUses = method.graphUiTraces
      .map((trace) => `${trace.surfaceName} (${trace.surfaceRepoRelativePath})`)
      .join('<br>');
    const notes = [];
    if (method.sourceUiUses.length && !method.graphUiTraces.length) {
      notes.push('source-only: missing from Explorer traces');
    }
    if (!method.sourceUiUses.length && method.graphUiTraces.length) {
      notes.push('graph-only: no direct source UI dispatch found');
    }
    lines.push(`| \`${method.functionName}\` | ${sourceUses || '-'} | ${graphUses || '-'} | ${notes.join('; ') || '-'} |`);
  }

  if (dictionary.modalStrictDiagnostics?.rows?.length) {
    lines.push(
      '',
      '## Main Modal Layer Strict UI Check',
      '',
      '| Modal Surface | Methods | Strict UI Call-Site |',
      '| --- | --- | --- |',
    );
    for (const row of dictionary.modalStrictDiagnostics.rows) {
      const methods = (row.functionNames || []).map((name) => `\`${name}\``).join(', ') || '-';
      const strictPaths = (row.strictUiPaths || [])
        .map((pathRows) => pathRows.map((node) => node.ownerName || node.key).filter(Boolean).join(' -> '))
        .join('<br>');
      lines.push(`| ${row.surfaceName} (${row.surfaceRepoRelativePath || '-'}) | ${methods} | ${strictPaths || 'missing'} |`);
    }
  }

  if (dictionary.lexicalSubstringDiagnostics?.enabled) {
    const diagnostics = dictionary.lexicalSubstringDiagnostics;
    const comparison = diagnostics.comparison || {};
    const exactHint = (diagnostics.improvementHints || [])
      .find((hint) => hint.kind === 'lexical-only-with-exact-structural-evidence');
    const looseHint = (diagnostics.improvementHints || [])
      .find((hint) => hint.kind === 'lexical-only-without-exact-structural-evidence');

    lines.push(
      '',
      '## Lexical Substring Diagnostics',
      '',
      `Token: \`${diagnostics.objectToken}\`${diagnostics.pluralObjectToken ? ` / \`${diagnostics.pluralObjectToken}\`` : ''}.`,
      '',
      '| Strict Methods | Lexical Candidates | Overlap | Lexical Only | Strict Only |',
      '| ---: | ---: | ---: | ---: | ---: |',
      `| ${comparison.strictMethodCount || 0} | ${comparison.lexicalCandidateCount || 0} | ${comparison.overlapCount || 0} | ${comparison.lexicalOnlyCount || 0} | ${comparison.strictOnlyCount || 0} |`,
      '',
      '| Improvement Bucket | Count | Sample |',
      '| --- | ---: | --- |',
      `| lexical-only with exact structural evidence | ${exactHint?.count || 0} | ${(exactHint?.functionNames || []).slice(0, 40).map((name) => `\`${name}\``).join(', ') || '-'} |`,
      `| lexical-only without exact structural evidence | ${looseHint?.count || 0} | ${(looseHint?.functionNames || []).slice(0, 40).map((name) => `\`${name}\``).join(', ') || '-'} |`,
    );
  } else if (dictionary.lexicalSubstringDiagnostics) {
    lines.push(
      '',
      '## Lexical Substring Diagnostics',
      '',
      `Disabled: ${dictionary.lexicalSubstringDiagnostics.disabledReason || 'unknown reason'}.`,
    );
  }

  if (dictionary.defects.length) {
    lines.push('', '## Defects', '');
    for (const defect of dictionary.defects) {
      lines.push(`- ${defect.kind}: \`${defect.functionName}\` ${defect.details}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

const uiPayload = runJson(process.execPath, [
  '--import',
  'tsx',
  path.join('graph', 'static-extract', 'ts', 'uiIntentEntryGraph.ts'),
]);

const objectFunctionsPayload = await fetchJson(`/api/ui-explorer/object-functions?objectKey=${encodeURIComponent(objectKey)}`);
const objectTracesPayload = await fetchJson(`/api/ui-explorer/object-traces?objectKey=${encodeURIComponent(objectKey)}`);
const modalStrictDiagnosticsPayload = await fetchJson(`/api/ui-explorer/modal-strict-diagnostics?objectKey=${encodeURIComponent(objectKey)}`);

const actionFunctionNames = uniqueSorted(
  [
    ...(objectFunctionsPayload.functions || []).map((item) => item.functionName),
    ...(objectTracesPayload.traces || []).flatMap((trace) => trace.functionNames || []),
  ],
);
const dispatchesByAction = groupDispatchesByAction(uiPayload.syntheticDispatches || []);
const tracesByFunction = groupTracesByFunction(objectTracesPayload.traces || []);
const strictFunctionNames = uniqueSorted((objectFunctionsPayload.functions || []).map((item) => item.functionName));
const lexicalSubstringDiagnostics = await buildLexicalSubstringDiagnostics({ objectKey, strictFunctionNames });

const methods = actionFunctionNames.map((functionName) => ({
  functionName,
  sourceUiUses: dispatchesByAction.get(functionName) || [],
  graphUiTraces: tracesByFunction.get(functionName) || [],
}));

const defects = [];
for (const method of methods) {
  if (method.sourceUiUses.length && !method.graphUiTraces.length) {
    defects.push({
      kind: 'source-dispatch-not-traced',
      functionName: method.functionName,
      details: `has ${method.sourceUiUses.length} source UI dispatch(es), but no current Explorer object trace.`,
    });
  }
}
for (const row of modalStrictDiagnosticsPayload.rows || []) {
  if (!row.hasStrictUiCallSite) {
    defects.push({
      kind: 'modal-layer-method-without-strict-ui-call-site',
      functionName: (row.functionNames || []).join(', ') || '<unknown>',
      details: `${row.surfaceName} (${row.surfaceRepoRelativePath || row.surfaceKey}) is visible under Main Modal Layer but has no strict non-modal UI containment path to its call site.`,
    });
  }
}

const dictionary = {
  objectKey,
  generatedAt: new Date().toISOString(),
  source: {
    uiDispatchExtractor: 'graph/static-extract/ts/uiIntentEntryGraph.ts',
    objectFunctionEndpoint: `${baseUrl}/api/ui-explorer/object-functions`,
    objectTraceEndpoint: `${baseUrl}/api/ui-explorer/object-traces`,
    modalStrictDiagnosticsEndpoint: `${baseUrl}/api/ui-explorer/modal-strict-diagnostics`,
  },
  methods,
  modalStrictDiagnostics: modalStrictDiagnosticsPayload,
  lexicalSubstringDiagnostics,
  defects,
};

fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, `${objectKey}.json`);
const markdownPath = path.join(outputDir, `${objectKey}.md`);
fs.writeFileSync(jsonPath, `${JSON.stringify(dictionary, null, 2)}\n`);
fs.writeFileSync(markdownPath, toMarkdown(dictionary));

console.log(JSON.stringify({
  objectKey,
  methodCount: methods.length,
  sourceUseCount: methods.reduce((total, method) => total + method.sourceUiUses.length, 0),
  graphTraceMethodCount: methods.filter((method) => method.graphUiTraces.length).length,
  modalStrictRowCount: (modalStrictDiagnosticsPayload.rows || []).length,
  modalStrictDefectCount: (modalStrictDiagnosticsPayload.rows || []).filter((row) => !row.hasStrictUiCallSite).length,
  lexicalCandidateCount: lexicalSubstringDiagnostics.comparison.lexicalCandidateCount,
  lexicalOnlyCount: lexicalSubstringDiagnostics.comparison.lexicalOnlyCount,
  lexicalOnlyWithExactStructuralEvidenceCount: (
    lexicalSubstringDiagnostics.improvementHints.find((hint) => hint.kind === 'lexical-only-with-exact-structural-evidence')?.count || 0
  ),
  defectCount: defects.length,
  jsonPath: path.relative(workspaceRoot, jsonPath).replace(/\\/g, '/'),
  markdownPath: path.relative(workspaceRoot, markdownPath).replace(/\\/g, '/'),
}, null, 2));

