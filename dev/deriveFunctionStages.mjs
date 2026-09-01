import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import ts from 'typescript';

const workspaceRoot = process.cwd();
const graphSource = 'semantic/functionFlowGraph';
const DEFAULT_FUNCTIONS_PATH = path.join(workspaceRoot, 'graph', 'functions.json');
const DEFAULT_MAX_STAGE_LINES = Number(process.env.GRAPH_STAGE_MAX_LINES || 90);
const DEFAULT_MAX_STAGE_STEPS = Number(process.env.GRAPH_STAGE_MAX_STEPS || 70);
const DEFAULT_MAX_SECTION_LINES = Number(process.env.GRAPH_SECTION_MAX_LINES || 45);
const functionCallRelTypes = ['CALL'];
const resourceRelTypes = [
  'READ',
  'TEST',
  'CREATE',
  'UPDATE',
  'DELETE',
  'CLEAR',
  'EMIT',
  'WAIT',
  'SUBSCRIBE',
  'SIGNAL',
  'START',
  'CANCEL',
  'DERIVE',
  'READS_RESOURCE',
  'TESTS_RESOURCE',
  'CREATES_RESOURCE',
  'UPDATES_RESOURCE',
  'DELETES_RESOURCE',
  'CLEARS_RESOURCE',
  'EMITS_TO',
  'WAITS_ON',
  'SUBSCRIBES_TO',
  'SIGNALS_RESOURCE',
];

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    functionsPath: DEFAULT_FUNCTIONS_PATH,
    fnStableId: undefined,
    maxStageLines: DEFAULT_MAX_STAGE_LINES,
    maxStageSteps: DEFAULT_MAX_STAGE_STEPS,
    maxSectionLines: DEFAULT_MAX_SECTION_LINES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--functions-path') {
      args.functionsPath = path.resolve(workspaceRoot, value);
      index += 1;
    } else if (arg === '--fn-stable-id') {
      args.fnStableId = value;
      index += 1;
    } else if (arg === '--max-stage-lines') {
      args.maxStageLines = Number(value);
      index += 1;
    } else if (arg === '--max-stage-steps') {
      args.maxStageSteps = Number(value);
      index += 1;
    } else if (arg === '--max-section-lines') {
      args.maxSectionLines = Number(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node dev/deriveFunctionStages.mjs [--fn-stable-id <stableID>] [--functions-path <path>]',
        '       [--max-stage-lines <n>] [--max-stage-steps <n>] [--max-section-lines <n>]',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function normalizeNeo4jUri(uri) {
  return String(uri || '')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function repoRelative(fileName) {
  return path.relative(workspaceRoot, fileName).replace(/\\/g, '/');
}

function positionOf(sourceFile, pos) {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character };
}

function stableIdOf(sourceFile, node) {
  const start = positionOf(sourceFile, node.getStart(sourceFile));
  const end = positionOf(sourceFile, node.getEnd());
  return `${repoRelative(sourceFile.fileName)}:${start.line}:${start.column}:${end.line}:${end.column}`;
}

function lineOf(sourceFile, node) {
  return positionOf(sourceFile, node.getStart(sourceFile)).line;
}

function endLineOf(sourceFile, node) {
  return positionOf(sourceFile, node.getEnd()).line;
}

function oneLine(text, max = 160) {
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
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function getFunctionName(node, sourceFile) {
  if (node.parent && ts.isCallExpression(node.parent) && node.parent.parent && ts.isVariableDeclaration(node.parent.parent)) {
    return node.parent.parent.name.getText(sourceFile);
  }
  if (node.parent && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name.getText(sourceFile);
  }
  if (node.name) return node.name.getText(sourceFile);
  return '<anonymous>';
}

function isFunctionLikeNode(node) {
  return ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node);
}

function findOwnerFunction(program, functionSpec) {
  const repoPath = functionSpec.repoRelativePath || functionSpec.file;
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (repoPath && repoRelative(sourceFile.fileName) !== repoPath) continue;
    let found;
    function visit(node) {
      if (found) return;
      if (isFunctionLikeNode(node) && node.body) {
        const stableId = stableIdOf(sourceFile, node);
        const name = getFunctionName(node, sourceFile);
        if (stableId === functionSpec.stableId || (functionSpec.name && name === functionSpec.name && (!repoPath || repoRelative(sourceFile.fileName) === repoPath))) {
          found = { sourceFile, fn: node, name, stableId };
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (found) return found;
  }
  return undefined;
}

function statementKind(statement) {
  if (ts.isIfStatement(statement)) return 'branch';
  if (ts.isSwitchStatement(statement)) return 'branch';
  if (ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) return 'loop';
  if (ts.isTryStatement(statement)) return 'try';
  if (ts.isBlock(statement)) return 'block';
  if (ts.isVariableStatement(statement)) return 'declaration';
  if (ts.isExpressionStatement(statement)) return 'effect';
  if (ts.isReturnStatement(statement)) return 'return';
  if (ts.isThrowStatement(statement)) return 'throw';
  return ts.SyntaxKind[statement.kind] || 'statement';
}

function hasControlExit(statement) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      found = true;
      return;
    }
    if (node !== statement && isFunctionLikeNode(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

function collectCalls(sourceFile, node) {
  const calls = [];
  function visit(current) {
    if (current !== node && isFunctionLikeNode(current)) return;
    if (ts.isCallExpression(current)) {
      calls.push(current.expression.getText(sourceFile).replace(/\s+/g, ' ').trim());
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...new Set(calls)];
}

function directChildStatements(statement) {
  if (ts.isBlock(statement)) return [...statement.statements];
  if (ts.isIfStatement(statement)) {
    const children = [];
    if (ts.isBlock(statement.thenStatement)) children.push(...statement.thenStatement.statements);
    else children.push(statement.thenStatement);
    if (statement.elseStatement) {
      if (ts.isBlock(statement.elseStatement)) children.push(...statement.elseStatement.statements);
      else children.push(statement.elseStatement);
    }
    return children;
  }
  if (ts.isTryStatement(statement)) {
    return [
      ...statement.tryBlock.statements,
      ...(statement.catchClause?.block?.statements || []),
      ...(statement.finallyBlock?.statements || []),
    ];
  }
  if (ts.isSwitchStatement(statement)) {
    return statement.caseBlock.clauses.flatMap((clause) => [...clause.statements]);
  }
  if ((ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) && ts.isBlock(statement.statement)) {
    return [...statement.statement.statements];
  }
  return [];
}

function buildSectionFromStatement(sourceFile, functionStableId, statement, sectionIndex, depth = 0) {
  const startLine = lineOf(sourceFile, statement);
  const endLine = endLineOf(sourceFile, statement);
  const kind = statementKind(statement);
  return {
    sourceFile,
    sectionIndex,
    stableKey: `${functionStableId}::section:${sectionIndex}:${startLine}-${endLine}`,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    statementKinds: [kind],
    kind,
    label: `Section ${sectionIndex}`,
    calls: collectCalls(sourceFile, statement),
    hasEarlyReturn: hasControlExit(statement),
    statements: [statement],
    depth,
    evidence: oneLine(stripComments(statement.getText(sourceFile)), 160),
  };
}

function collectFormalSections(sourceFile, functionStableId, statements, options, depth = 0, state = { index: 0 }) {
  const sections = [];
  for (const statement of statements) {
    const lineCount = endLineOf(sourceFile, statement) - lineOf(sourceFile, statement) + 1;
    const children = directChildStatements(statement);
    if (lineCount > options.maxSectionLines && children.length > 1) {
      sections.push(...collectFormalSections(sourceFile, functionStableId, children, options, depth + 1, state));
      continue;
    }
    state.index += 1;
    sections.push(buildSectionFromStatement(sourceFile, functionStableId, statement, state.index, depth));
  }
  return sections;
}

function stageKindForSections(sections) {
  const kinds = new Set(sections.flatMap((section) => section.statementKinds || []));
  if (kinds.has('branch')) return 'branch';
  if (kinds.has('loop')) return 'loop';
  if (kinds.has('try')) return 'try';
  if (kinds.has('return') || kinds.has('throw')) return 'exit';
  if (kinds.has('declaration')) return 'declaration';
  if (kinds.has('effect')) return 'effect';
  return 'linear';
}

function stageLabel(index) {
  return `Stage ${index}`;
}

function sectionLabel(index) {
  return `Step group ${index}`;
}

function mergeSectionsIntoStage(sections, functionStableId, stageIndex) {
  const startLine = Math.min(...sections.map((section) => section.startLine));
  const endLine = Math.max(...sections.map((section) => section.endLine));
  const calls = [...new Set(sections.flatMap((section) => section.calls || []))];
  const statementKinds = [...new Set(sections.flatMap((section) => section.statementKinds || []))];
  const kind = stageKindForSections(sections);
  return {
    ...sections[0],
    stageIndex,
    stableKey: `${functionStableId}::stage:${stageIndex}:${startLine}-${endLine}`,
    label: stageLabel(stageIndex),
    kind,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    calls,
    statementKinds,
    hasEarlyReturn: sections.some((section) => section.hasEarlyReturn),
    sections,
    evidence: sections.map((section) => section.evidence).join(' | '),
  };
}

function shouldStartNewStage(currentSections, nextSection, options) {
  if (!currentSections.length) return false;
  const startLine = Math.min(...currentSections.map((section) => section.startLine));
  const endLine = Math.max(...currentSections.map((section) => section.endLine), nextSection.endLine);
  const lineCount = endLine - startLine + 1;
  const stepCount = currentSections.reduce((sum, section) => sum + (section.stepCount || 0), 0) + (nextSection.stepCount || 0);
  const currentHasExit = currentSections.some((section) => section.hasEarlyReturn);
  const nextIsLargeControl = ['branch', 'loop', 'try'].includes(nextSection.kind) && nextSection.lineCount > Math.floor(options.maxStageLines * 0.5);
  const currentOnlyLargeControl = currentSections.length === 1
    && ['branch', 'loop', 'try'].includes(currentSections[0].kind)
    && currentSections[0].lineCount > Math.floor(options.maxStageLines * 0.5);
  return currentHasExit
    || currentOnlyLargeControl
    || nextIsLargeControl
    || stepCount > options.maxStageSteps
    || lineCount > options.maxStageLines;
}

function buildStages(sections, functionStableId, options) {
  const stages = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    stages.push(mergeSectionsIntoStage(current, functionStableId, stages.length + 1));
    current = [];
  };
  for (const section of sections) {
    if (shouldStartNewStage(current, section, options)) flush();
    current.push(section);
    if (section.hasEarlyReturn) flush();
  }
  flush();
  return stages;
}

function dedupeResourceTouches(resources) {
  const seen = new Set();
  return (resources || []).filter((resource) => {
    const key = `${resource.resourceKey || resource.resourceName}:${resource.accessType || resource.relType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function neo4jNumber(value) {
  return value?.toNumber?.() ?? value;
}

function resourceTouchFromRecord(record, { callSiteStepStableId = null } = {}) {
  return {
    stepStableId: record.get('stepStableId'),
    callSiteStepStableId,
    line: neo4jNumber(record.get('line')),
    column: neo4jNumber(record.get('column')),
    relType: record.get('relType'),
    accessType: record.get('accessType'),
    resourceKey: record.get('resourceKey'),
    resourceKind: record.get('resourceKind'),
    resourceSubkind: record.get('resourceSubkind'),
    resourceName: record.get('resourceName'),
    resourceCellName: record.get('resourceCellName'),
    asyncKind: record.get('asyncKind'),
    asyncPhase: record.get('asyncPhase'),
  };
}

async function loadGraphEvidence(items, fnStableId) {
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
        const base = { source: graphSource, fnStableId, startLine: item.startLine, endLine: item.endLine };
        const boundaryResult = await session.run(
          `MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})
           WHERE step.start_line >= $startLine AND step.start_line <= $endLine
           WITH step ORDER BY step.start_line, step.start_column
           RETURN collect(step.stableId)[0] AS headStepStableId,
                  collect(step.stableId)[-1] AS tailStepStableId,
                  count(step) AS stepCount`,
          base,
        );
        const callResult = await session.run(
          `MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})-[callRel]->(callee:Fn)
           WHERE step.start_line >= $startLine AND step.start_line <= $endLine
             AND callRel.source = $source
             AND (type(callRel) IN $functionCallRelTypes OR callRel.role = 'call')
           RETURN DISTINCT step.stableId AS stepStableId,
                  step.start_line AS startLine,
                  step.start_column AS startColumn,
                  step.operation_callee_text AS calleeText,
                  callee.stableId AS targetStableId,
                  callee.name AS targetName
           ORDER BY startLine, startColumn, targetStableId`,
          { ...base, functionCallRelTypes },
        );
        const resourceResult = await session.run(
          `MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})-[resourceRel]->(resource {source: $source})
           WHERE resource.resource_kind IS NOT NULL AND step.start_line >= $startLine AND step.start_line <= $endLine
             AND type(resourceRel) IN $resourceRelTypes
           RETURN DISTINCT step.stableId AS stepStableId,
                  step.start_line AS line,
                  step.start_column AS column,
                  type(resourceRel) AS relType,
                  resourceRel.access_type AS accessType,
                  resource.resource_key AS resourceKey,
                  resource.resource_kind AS resourceKind,
                  resource.resource_subkind AS resourceSubkind,
                  resource.resource_name AS resourceName,
                  resource.resource_cell_name AS resourceCellName,
                  resourceRel.async_kind AS asyncKind,
                  resourceRel.async_phase AS asyncPhase
           ORDER BY line, column, resourceKind, resourceSubkind, resourceName`,
          { ...base, resourceRelTypes },
        );
        const targetCalls = callResult.records.map((record) => ({
          stepStableId: record.get('stepStableId'),
          line: neo4jNumber(record.get('startLine')),
          column: neo4jNumber(record.get('startColumn')),
          calleeText: record.get('calleeText'),
          targetStableId: record.get('targetStableId'),
          targetName: record.get('targetName'),
          resources: [],
        }));
        const targetFnIds = [...new Set(targetCalls.map((call) => call.targetStableId).filter(Boolean))];
        const nestedResourceRows = targetFnIds.length
          ? await session.run(
            `CALL {
               MATCH (step:Step {source: $source})-[resourceRel]->(resource {source: $source})
               WHERE step.parentFnStableId IN $targetFnIds
                 AND resource.resource_kind IS NOT NULL
                 AND type(resourceRel) IN $resourceRelTypes
               RETURN step.parentFnStableId AS targetStableId,
                      step.stableId AS stepStableId,
                      step.start_line AS line,
                      step.start_column AS column,
                      type(resourceRel) AS relType,
                      resourceRel.access_type AS accessType,
                      resource.resource_key AS resourceKey,
                      resource.resource_kind AS resourceKind,
                      resource.resource_subkind AS resourceSubkind,
                      resource.resource_name AS resourceName,
                      resource.resource_cell_name AS resourceCellName,
                      resourceRel.async_kind AS asyncKind,
                      resourceRel.async_phase AS asyncPhase
               UNION
               MATCH (resource {source: $source})
               WHERE resource.resource_kind IS NOT NULL AND resource.parentFnStableId IN $targetFnIds
               RETURN resource.parentFnStableId AS targetStableId,
                      null AS stepStableId,
                      null AS line,
                      null AS column,
                      'RESOURCE_INVENTORY' AS relType,
                      'touch' AS accessType,
                      resource.resource_key AS resourceKey,
                      resource.resource_kind AS resourceKind,
                      resource.resource_subkind AS resourceSubkind,
                      resource.resource_name AS resourceName,
                      resource.resource_cell_name AS resourceCellName,
                      null AS asyncKind,
                      null AS asyncPhase
             }
             RETURN DISTINCT targetStableId,
                    stepStableId,
                    line,
                    column,
                    relType,
                    accessType,
                    resourceKey,
                    resourceKind,
                    resourceSubkind,
                    resourceName,
                    resourceCellName,
                    asyncKind,
                    asyncPhase
             ORDER BY targetStableId, line, column, resourceKind, resourceSubkind, resourceName`,
            { source: graphSource, targetFnIds, resourceRelTypes },
          )
          : { records: [] };
        const nestedResourcesByTarget = new Map();
        for (const record of nestedResourceRows.records) {
          const targetStableId = record.get('targetStableId');
          if (!nestedResourcesByTarget.has(targetStableId)) nestedResourcesByTarget.set(targetStableId, []);
          nestedResourcesByTarget.get(targetStableId).push(resourceTouchFromRecord(record));
        }
        for (const call of targetCalls) {
          call.resources = dedupeResourceTouches((nestedResourcesByTarget.get(call.targetStableId) || []).map((resource) => ({
            ...resource,
            callSiteStepStableId: call.stepStableId,
          })));
        }

        const boundary = boundaryResult.records[0];
        rows.push({
          ...item,
          headStepStableId: boundary?.get('headStepStableId') || null,
          tailStepStableId: boundary?.get('tailStepStableId') || null,
          stepCount: boundary?.get('stepCount')?.toNumber?.() ?? 0,
          targetCalls,
          resourceTouches: dedupeResourceTouches(resourceResult.records.map((record) => resourceTouchFromRecord(record))),
        });
      }
      return rows;
    } finally {
      await session.close();
    }
  } catch {
    return items;
  } finally {
    await driver.close();
  }
}

function serializeItem(item, type) {
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
    calls: (item.calls || []).slice(0, 12),
    targetCalls: item.targetCalls || [],
    resourceTouches: item.resourceTouches || [],
    hasEarlyReturn: item.hasEarlyReturn,
    evidence: item.evidence,
    sections: (item.sections || []).map((section, index) => serializeItem({
      ...section,
      label: sectionLabel(index + 1),
    }, 'section')),
  };
}

export async function deriveFunctionStages(functionSpec, program = createProgram(), options = {}) {
  if (!functionSpec?.stableId) return null;
  const owner = findOwnerFunction(program, functionSpec);
  if (!owner?.fn?.body || !ts.isBlock(owner.fn.body)) {
    throw new Error(`Owner function was not found: ${functionSpec.stableId}`);
  }
  const normalizedOptions = {
    maxStageLines: Number(options.maxStageLines || DEFAULT_MAX_STAGE_LINES),
    maxStageSteps: Number(options.maxStageSteps || DEFAULT_MAX_STAGE_STEPS),
    maxSectionLines: Number(options.maxSectionLines || DEFAULT_MAX_SECTION_LINES),
  };
  const statements = [...owner.fn.body.statements];
  const sections = await loadGraphEvidence(
    collectFormalSections(owner.sourceFile, owner.stableId, statements, normalizedOptions),
    owner.stableId,
  );
  const stages = await loadGraphEvidence(buildStages(sections, owner.stableId, normalizedOptions), owner.stableId);
  for (const stage of stages) {
    stage.sections = await loadGraphEvidence((stage.sections || []).map((section, index) => ({
      ...section,
      sectionIndex: index + 1,
      stableKey: `${stage.stableKey}::section:${index + 1}:${section.startLine}-${section.endLine}`,
      label: sectionLabel(index + 1),
    })), owner.stableId);
  }
  return {
    phase: {
      key: owner.stableId,
      label: functionSpec.name || owner.name,
      phaseKind: 'function',
      featureKey: null,
      order: null,
      direction: 'source-order',
    },
    function: {
      name: functionSpec.name || owner.name,
      stableId: owner.stableId,
      repoRelativePath: repoRelative(owner.sourceFile.fileName),
    },
    stages: stages.map((stage) => serializeItem(stage, 'stage')),
  };
}

function loadFunctionSpecs(functionsPath, fnStableId) {
  if (!fs.existsSync(functionsPath)) {
    if (!fnStableId) throw new Error(`Function catalog was not found: ${functionsPath}`);
    return [{ stableId: fnStableId }];
  }
  const payload = JSON.parse(fs.readFileSync(functionsPath, 'utf8'));
  const functions = (payload.functions || [])
    .filter((fn) => fn.stableId && fn.pinStatus !== 'schema-only')
    .map((fn) => ({
      stableId: fn.stableId,
      name: fn.name || fn.label,
      repoRelativePath: fn.file,
      file: fn.file,
    }));
  if (!fnStableId) return functions;
  if (functions.some((fn) => fn.stableId === fnStableId)) {
    return functions.filter((fn) => fn.stableId === fnStableId);
  }
  return [{ stableId: fnStableId }];
}

export async function deriveAllFunctionStages(options = {}) {
  const program = createProgram();
  const stageSets = [];
  const errors = [];
  const functionSpecs = (options.functionSpecs || loadFunctionSpecs(options.functionsPath || DEFAULT_FUNCTIONS_PATH, options.fnStableId))
    .map((functionSpec) => ({
      ...functionSpec,
      name: (
        options.functionName
        && functionSpec.stableId === options.fnStableId
        && (!functionSpec.name || functionSpec.name === '<anonymous>')
      )
          ? options.functionName
          : functionSpec.name,
    }));
  for (const functionSpec of functionSpecs) {
    try {
      const stageSet = await deriveFunctionStages(functionSpec, program, options);
      if (stageSet) stageSets.push(stageSet);
    } catch (error) {
      errors.push(`${functionSpec.stableId}: ${error.message}`);
    }
  }
  return { stageSets, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await deriveAllFunctionStages(parseArgs()), null, 2));
}

