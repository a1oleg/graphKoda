import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import ts from 'typescript';

const workspaceRoot = process.cwd();
const sourceFilePath = path.join(workspaceRoot, 'screens', 'REPL.tsx');
const fnStableId = 'screens/REPL.tsx:3142:31:3533:3';
const graphSource = 'semantic/functionFlowGraph';

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function normalizeNeo4jUri(uri) {
  return String(uri || '')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function oneLine(text, max = 110) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function createProgram() {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json was not found.');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function getFunctionName(node) {
  if (node.parent && ts.isCallExpression(node.parent) && node.parent.parent && ts.isVariableDeclaration(node.parent.parent)) {
    return node.parent.parent.name.getText();
  }
  if (node.parent && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name.getText();
  }
  return node.name?.getText?.() || '<anonymous>';
}

function findOnSubmit(program) {
  const sourceFile = program.getSourceFile(sourceFilePath);
  if (!sourceFile) throw new Error(`Source file was not found: ${sourceFilePath}`);
  let found;
  function visit(node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(sourceFile) === 'onSubmit'
      && node.initializer
      && ts.isCallExpression(node.initializer)
    ) {
      const callback = node.initializer.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callback) {
        found = callback;
        return;
      }
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && getFunctionName(node) === 'onSubmit'
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found || !found.body || !ts.isBlock(found.body)) {
    throw new Error('onSubmit function body was not found.');
  }
  return { sourceFile, fn: found };
}

function collectCalls(sourceFile, node) {
  const calls = [];
  function visit(current) {
    if (ts.isCallExpression(current)) {
      calls.push(current.expression.getText(sourceFile).replace(/\s+/g, ' ').trim());
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...new Set(calls)];
}

function statementKind(statement) {
  if (ts.isIfStatement(statement)) return 'guard';
  if (ts.isBlock(statement)) return 'block';
  if (ts.isExpressionStatement(statement)) return 'effect';
  if (ts.isVariableStatement(statement)) return 'state';
  if (ts.isReturnStatement(statement)) return 'return';
  return ts.SyntaxKind[statement.kind] || 'statement';
}

function sectionKind(section) {
  const calls = new Set(section.calls);
  const text = section.statements.map((statement) => statement.getText(section.sourceFile)).join('\n');
  if (section.hasEarlyReturn && calls.has('activeRemote.sendMessage')) return 'remote-submit';
  if (section.hasEarlyReturn && calls.has('handleSpeculationAccept')) return 'speculation-accept';
  if (section.hasEarlyReturn && calls.has('handlePromptSubmit')) return 'prompt-pipeline-handoff';
  if (section.hasEarlyReturn && /activeRemote\.isRemoteMode/.test(text)) return 'remote-empty-guard';
  if (section.hasEarlyReturn && /matchingCommand/.test(text)) return 'immediate-command';
  if (calls.has('setIdleReturnPending')) return 'idle-return-guard';
  if (calls.has('addToHistory') || calls.has('prependToShellHistoryCache')) return 'history-capture';
  if (/const\s+isSlashCommand\s*=/.test(text)) return 'input-classification';
  if (/const\s+submitsNow\s*=/.test(text)) return 'submit-readiness';
  if (/\(isSlashCommand\s*\|\|\s*isLoading\)\s*&&\s*stashedPrompt/.test(text)) return 'stashed-prompt-restore';
  if (calls.has('setInputValue') || calls.has('setPastedContents') || calls.has('helpers.clearBuffer')) return 'input-ui-reset';
  if (calls.has('awaitPendingHooks') || calls.has('handlePromptSubmit')) return 'prompt-pipeline-handoff';
  if (calls.has('repinScroll') || calls.has('proactiveModule?.resumeProactive')) return 'submit-preflight';
  return 'local-submit-logic';
}

function labelForKind(kind) {
  return {
    'submit-preflight': 'Submit preflight',
    'immediate-command': 'Immediate command branch',
    'remote-empty-guard': 'Remote empty input guard',
    'idle-return-guard': 'Idle return guard',
    'history-capture': 'Input history capture',
    'input-classification': 'Input classification',
    'submit-readiness': 'Submit readiness decision',
    'input-ui-reset': 'Input UI reset / placeholder',
    'speculation-accept': 'Speculation acceptance',
    'remote-submit': 'Remote submit branch',
    'prompt-pipeline-handoff': 'Local prompt pipeline handoff',
    'stashed-prompt-restore': 'Stashed prompt restore',
    'local-submit-logic': 'Local submit logic',
  }[kind] || kind;
}

function hasEarlyReturn(statement) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

function dedupeResourceTouches(resources) {
  const seen = new Set();
  const deduped = [];
  for (const resource of resources || []) {
    const key = `${resource.resourceKey || resource.resourceName}:${resource.accessType || resource.relType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(resource);
  }
  return deduped;
}

function buildInitialSections(sourceFile, fn) {
  return fn.body.statements.map((statement, index) => {
    const calls = collectCalls(sourceFile, statement);
    const startLine = lineOf(sourceFile, statement);
    const endLine = endLineOf(sourceFile, statement);
    return {
      sourceFile,
      index,
      sectionIndex: index + 1,
      stableKey: `${fnStableId}::section:${index + 1}:${startLine}-${endLine}`,
      startLine,
      endLine,
      statementKinds: [statementKind(statement)],
      calls,
      hasEarlyReturn: hasEarlyReturn(statement),
      statements: [statement],
      evidence: oneLine(stripComments(statement.getText(sourceFile)), 160),
    };
  });
}

function buildStages(sections) {
  const stages = [];
  let current;
  const flush = () => {
    if (!current) return;
    current.kind = sectionKind(current);
    current.label = labelForKind(current.kind);
    stages.push(current);
    current = undefined;
  };

  for (const section of sections) {
    const kind = sectionKind(section);
    const mergeableWithCurrent =
      current
      && !current.hasEarlyReturn
      && !section.hasEarlyReturn
      && (
        (current.kind === kind && ['submit-preflight', 'input-ui-reset', 'history-capture', 'prompt-pipeline-handoff'].includes(kind))
        || (current.kind === 'submit-preflight' && kind === 'submit-preflight')
      );

    if (!current) {
      current = { ...section, kind, label: labelForKind(kind), sections: [section] };
      continue;
    }

    if (mergeableWithCurrent) {
      current.endLine = section.endLine;
      current.statementKinds.push(...section.statementKinds);
      current.calls = [...new Set([...current.calls, ...section.calls])];
      current.hasEarlyReturn = current.hasEarlyReturn || section.hasEarlyReturn;
      current.statements.push(...section.statements);
      current.sections.push(section);
      current.evidence = `${current.evidence} | ${section.evidence}`;
      current.kind = sectionKind(current);
      current.label = labelForKind(current.kind);
      continue;
    }

    flush();
    current = { ...section, kind, label: labelForKind(kind), sections: [section] };
  }

  flush();
  return stages.map((stage, index) => ({
    ...stage,
    stageIndex: index + 1,
    stableKey: `${fnStableId}::stage:${index + 1}:${stage.startLine}-${stage.endLine}`,
  }));
}

async function loadGraphEvidence(items) {
  const uri = normalizeNeo4jUri(process.env.NEO4J_URI);
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) return items;

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  try {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      const rows = [];
      for (const item of items) {
        const result = await session.run(
          `
            MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})
            WHERE step.start_line >= $startLine AND step.start_line <= $endLine
            OPTIONAL MATCH (step)-[callRel]->(callee:Fn)
            WHERE callRel.source = $source AND callRel.role = 'call'
            RETURN count(DISTINCT step) AS stepCount,
                   collect(DISTINCT coalesce(callee.name, step.operation_callee_text))[0..10] AS callEvidence,
                   collect(DISTINCT step.operation_code)[0..10] AS operationCodes
          `,
          {
            source: graphSource,
            fnStableId,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        );
        const boundaryResult = await session.run(
          `
            MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})
            WHERE step.start_line >= $startLine AND step.start_line <= $endLine
            WITH step
            ORDER BY step.start_line, step.start_column
            RETURN collect(step.stableId)[0] AS headStepStableId,
                   collect(step.stableId)[-1] AS tailStepStableId
          `,
          {
            source: graphSource,
            fnStableId,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        );
        const record = result.records[0];
        const boundaryRecord = boundaryResult.records[0];
        const callResult = await session.run(
          `
            MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})-[callRel]->(callee:Fn)
            WHERE step.start_line >= $startLine
              AND step.start_line <= $endLine
              AND callRel.source = $source
              AND callRel.role = 'call'
            RETURN DISTINCT
                   step.stableId AS stepStableId,
                   step.start_line AS startLine,
                   step.start_column AS startColumn,
                   step.operation_callee_text AS calleeText,
                   callee.stableId AS targetStableId,
                   callee.name AS targetName
            ORDER BY startLine, startColumn, targetStableId
          `,
          {
            source: graphSource,
            fnStableId,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        );
        const resourceResult = await session.run(
          `
            MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})-[resourceRel]->(resource {source: $source})
            WHERE step.start_line >= $startLine
              AND resource.resource_kind IS NOT NULL
              AND step.start_line <= $endLine
              AND type(resourceRel) IN [
                'READS_RESOURCE',
                'TESTS_RESOURCE',
                'CREATES_RESOURCE',
                'UPDATES_RESOURCE',
                'DELETES_RESOURCE',
                'CLEARS_RESOURCE',
                'EMITS_TO',
                'WAITS_ON',
                'SUBSCRIBES_TO',
                'SIGNALS_RESOURCE'
              ]
            RETURN DISTINCT
                   step.stableId AS stepStableId,
                   step.start_line AS line,
                   step.start_column AS column,
                   type(resourceRel) AS relType,
                   resourceRel.access_type AS accessType,
                   resource.resource_key AS resourceKey,
                   resource.resource_kind AS resourceKind,
                   resource.resource_subkind AS resourceSubkind,
                   resource.resource_name AS resourceName
            ORDER BY line, column, resourceKind, resourceSubkind, resourceName
          `,
          {
            source: graphSource,
            fnStableId,
            startLine: item.startLine,
            endLine: item.endLine,
          },
        );
        const targetIds = [...new Set(callResult.records.map((callRecord) => callRecord.get('targetStableId')).filter(Boolean))];
        const targetResourceResult = targetIds.length
          ? await session.run(
            `
              MATCH (step:Step {source: $source})-[resourceRel]->(resource {source: $source})
              WHERE step.parentFnStableId IN $targetIds
                AND resource.resource_kind IS NOT NULL
                AND type(resourceRel) IN [
                  'READS_RESOURCE',
                  'TESTS_RESOURCE',
                  'CREATES_RESOURCE',
                  'UPDATES_RESOURCE',
                  'DELETES_RESOURCE',
                  'CLEARS_RESOURCE',
                  'EMITS_TO',
                  'WAITS_ON',
                  'SUBSCRIBES_TO',
                  'SIGNALS_RESOURCE'
                ]
              RETURN DISTINCT
                     step.parentFnStableId AS targetStableId,
                     step.start_line AS line,
                     step.start_column AS column,
                     type(resourceRel) AS relType,
                     resourceRel.access_type AS accessType,
                     resource.resource_key AS resourceKey,
                     resource.resource_kind AS resourceKind,
                     resource.resource_subkind AS resourceSubkind,
                     resource.resource_name AS resourceName
              ORDER BY targetStableId, line, column, resourceKind, resourceSubkind, resourceName
            `,
            {
              source: graphSource,
              targetIds,
            },
          )
          : { records: [] };
        const targetResourcesByFn = new Map();
        for (const targetResourceRecord of targetResourceResult.records) {
          const targetStableId = targetResourceRecord.get('targetStableId');
          if (!targetResourcesByFn.has(targetStableId)) {
            targetResourcesByFn.set(targetStableId, []);
          }
          targetResourcesByFn.get(targetStableId).push({
            line: targetResourceRecord.get('line')?.toNumber?.() ?? targetResourceRecord.get('line'),
            column: targetResourceRecord.get('column')?.toNumber?.() ?? targetResourceRecord.get('column'),
            relType: targetResourceRecord.get('relType'),
            accessType: targetResourceRecord.get('accessType'),
            resourceKey: targetResourceRecord.get('resourceKey'),
            resourceKind: targetResourceRecord.get('resourceKind'),
            resourceSubkind: targetResourceRecord.get('resourceSubkind'),
            resourceName: targetResourceRecord.get('resourceName'),
          });
        }
        rows.push({
          ...item,
          headStepStableId: boundaryRecord?.get('headStepStableId') || null,
          tailStepStableId: boundaryRecord?.get('tailStepStableId') || null,
          stepCount: record?.get('stepCount')?.toNumber?.() ?? 0,
          graphCalls: (record?.get('callEvidence') || []).filter(Boolean),
          operationCodes: (record?.get('operationCodes') || []).filter(Boolean),
          targetCalls: callResult.records.map((callRecord) => {
            const targetStableId = callRecord.get('targetStableId');
            return {
              stepStableId: callRecord.get('stepStableId'),
              line: callRecord.get('startLine')?.toNumber?.() ?? callRecord.get('startLine'),
              column: callRecord.get('startColumn')?.toNumber?.() ?? callRecord.get('startColumn'),
              calleeText: callRecord.get('calleeText'),
              targetStableId,
              targetName: callRecord.get('targetName'),
              resources: dedupeResourceTouches(targetResourcesByFn.get(targetStableId) || []).slice(0, 8),
            };
          }),
          resourceTouches: dedupeResourceTouches(resourceResult.records.map((resourceRecord) => ({
            stepStableId: resourceRecord.get('stepStableId'),
            line: resourceRecord.get('line')?.toNumber?.() ?? resourceRecord.get('line'),
            column: resourceRecord.get('column')?.toNumber?.() ?? resourceRecord.get('column'),
            relType: resourceRecord.get('relType'),
            accessType: resourceRecord.get('accessType'),
            resourceKey: resourceRecord.get('resourceKey'),
            resourceKind: resourceRecord.get('resourceKind'),
            resourceSubkind: resourceRecord.get('resourceSubkind'),
            resourceName: resourceRecord.get('resourceName'),
          }))),
        });
      }
      return rows;
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

export async function deriveOnSubmitSections() {
  const { sourceFile, fn } = findOnSubmit(createProgram());
  const initialSections = buildInitialSections(sourceFile, fn).map((section) => ({
    ...section,
    kind: sectionKind(section),
    label: labelForKind(sectionKind(section)),
  }));
  const stages = await loadGraphEvidence(buildStages(initialSections));
  for (const stage of stages) {
    stage.sections = await loadGraphEvidence((stage.sections || []).map((section, sectionIndex) => ({
      ...section,
      sectionIndex: sectionIndex + 1,
      stableKey: `${stage.stableKey}::section:${sectionIndex + 1}:${section.startLine}-${section.endLine}`,
      kind: sectionKind(section),
      label: labelForKind(sectionKind(section)),
    })));
  }
  const uiEntrypoints = await loadUiEntrypoints();
  const serializedStages = stages.map((stage) => serializeStageItem(stage, 'stage'));
  return {
    function: {
      name: 'onSubmit',
      stableId: fnStableId,
      repoRelativePath: 'screens/REPL.tsx',
    },
    algorithm: [
      'AST top-level statements only',
      'no comments',
      'split on guard/block/await/return boundaries',
      'merge adjacent deterministic action clusters',
      'summarize with graph step/call evidence by line range',
    ],
    uiEntrypoints,
    stages: serializedStages,
    sections: serializedStages,
  };
}

function serializeStageItem(item, type) {
  return {
    type,
    index: type === 'stage' ? item.stageIndex : item.sectionIndex,
    key: item.stableKey,
    stableId: item.stableKey,
    label: item.label,
    kind: item.kind,
    lines: `${item.startLine}-${item.endLine}`,
    startLine: item.startLine,
    endLine: item.endLine,
    headStepStableId: item.headStepStableId || null,
    tailStepStableId: item.tailStepStableId || null,
    stepCount: item.stepCount,
    statementKinds: [...new Set(item.statementKinds)],
    calls: item.calls.slice(0, 12),
    graphCalls: item.graphCalls || [],
    targetCalls: item.targetCalls || [],
    resourceTouches: item.resourceTouches || [],
    hasEarlyReturn: item.hasEarlyReturn,
    evidence: item.evidence,
    sections: (item.sections || []).map((section) => serializeStageItem(section, 'section')),
  };
}

async function loadUiEntrypoints() {
  const uri = normalizeNeo4jUri(process.env.NEO4J_URI);
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) return [];

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  try {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(
        `
          MATCH (surface:ViewSurface)-[:OWNS_UI_AFFORDANCE]->(affordance:UiAffordance)-[rel:TRIGGERS_STATIC_HANDLER]->(:Fn {stableId: $fnStableId})
          RETURN surface.key AS surfaceKey,
                 surface.owner_name AS surfaceName,
                 surface.surface_kind AS surfaceKind,
                 affordance.key AS affordanceKey,
                 affordance.element_name AS elementName,
                 affordance.primary_descendant_kind AS affordanceKind,
                 affordance.line AS line,
                 affordance.column AS column,
                 rel.event_handler_name AS eventHandlerName,
                 rel.resolution_kind AS resolutionKind
          ORDER BY line, column, elementName
        `,
        { fnStableId },
      );
      return result.records.map((record) => ({
        surfaceKey: record.get('surfaceKey'),
        surfaceName: record.get('surfaceName'),
        surfaceKind: record.get('surfaceKind'),
        affordanceKey: record.get('affordanceKey'),
        elementName: record.get('elementName'),
        affordanceKind: record.get('affordanceKind'),
        line: record.get('line')?.toNumber?.() ?? record.get('line'),
        column: record.get('column')?.toNumber?.() ?? record.get('column'),
        eventHandlerName: record.get('eventHandlerName'),
        resolutionKind: record.get('resolutionKind'),
      }));
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await deriveOnSubmitSections(), null, 2));
}

