import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import ts from 'typescript';

const workspaceRoot = process.cwd();
const graphSource = 'semantic/functionFlowGraph';
const phaseKeyArgIndex = process.argv.indexOf('--phase-key');
const phaseKey = phaseKeyArgIndex >= 0 ? process.argv[phaseKeyArgIndex + 1] : 'turn.input-intake';
const outputArgIndex = process.argv.indexOf('--output');
const phasesConfig = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'graph', 'phases.json'), 'utf8'));
const phaseDefinition = phasesConfig.phases.find((phase) => phase.key === phaseKey);
if (!phaseDefinition) {
  throw new Error(`Phase was not found in graph/phases.json: ${phaseKey}`);
}
const fnStableId = phaseDefinition.ownerFunction.stableId;
const repoRelativePath = phaseDefinition.ownerFunction.repoRelativePath || fnStableId.split(':')[0];
const sourceFilePath = path.join(workspaceRoot, repoRelativePath);
const outputPath = path.resolve(
  workspaceRoot,
  outputArgIndex >= 0
    ? process.argv[outputArgIndex + 1]
    : `graph/draw/${phaseKey}-phase-sections.drawio`,
);

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function normalizeNeo4jUri(uri) {
  return String(uri || '').replace('neo4j://localhost', 'bolt://localhost').replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(value, max = 70) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function createProgram() {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function stripComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function oneLine(text, max = 150) {
  const value = stripComments(text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function findFunctionByStableId(program) {
  const sourceFile = program.getSourceFile(sourceFilePath);
  if (!sourceFile) throw new Error(`Source file not found: ${sourceFilePath}`);
  const [, startLineText, startColumnText, endLineText, endColumnText] = fnStableId.match(/:(\d+):(\d+):(\d+):(\d+)$/) || [];
  const startLine = Number(startLineText);
  const startColumn = Number(startColumnText);
  const endLine = Number(endLineText);
  const endColumn = Number(endColumnText);
  let found;
  function visit(node) {
    if (found) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      if (start.line + 1 === startLine && start.character === startColumn && end.line + 1 === endLine && end.character === endColumn) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found || !found.body || !ts.isBlock(found.body)) throw new Error(`Function not found: ${fnStableId}`);
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

function hasReturn(statement) {
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

function classifySection(section) {
  const calls = new Set(section.calls);
  const text = section.text;
  if (calls.has('diagnosticTracker.handleQueryStart')) return ['Turn diagnostics start', 'diagnostics-start'];
  if (calls.has('maybeMarkProjectOnboardingComplete')) return ['Project onboarding marker', 'runtime-bootstrap'];
  if (calls.has('generateSessionTitle')) return ['Session title attempt', 'ui-feedback'];
  if (/store\.setState/.test(text) && /additionalAllowedTools/.test(text)) return ['Allowed tools scope write', 'runtime-bootstrap'];
  if (/!shouldQuery/.test(text)) return ['No-query cleanup branch', 'guard-return'];
  if (calls.has('buildQueryConfig')) return ['Query config build', 'runtime-bootstrap'];
  if (calls.has('getMessagesForConversation')) return ['Conversation messages snapshot', 'context-assembly'];
  if (calls.has('normalizeMessagesForAPI')) return ['API message normalization', 'context-assembly'];
  if (calls.has('applyToolResultBudget')) return ['Tool result budget shaping', 'context-assembly'];
  if (calls.has('prependUserContext') || calls.has('appendSystemContext')) return ['Context injection', 'context-assembly'];
  if (calls.has('deps.callModel')) return ['LLM handoff', 'context-handoff'];
  if (calls.has('addDisplayAssistantMessage')) return ['Visible assistant placeholder', 'ui-feedback'];
  if (calls.has('setAbortController') || calls.has('createAbortController')) return ['Abort controller setup', 'runtime-bootstrap'];
  if (calls.has('setIsLoading') || calls.has('setIsExternalLoading')) return ['Loading state setup', 'ui-feedback'];
  if (calls.has('getToolUseContext')) return ['Tool-use context handoff', 'context-handoff'];
  if (/shouldQuery/.test(text)) return ['Query decision guard', 'query-decision'];
  if (section.hasReturn) return ['Early return branch', 'guard-return'];
  return ['Input intake local step', 'local-step'];
}

function buildSections(sourceFile, fn, headLine, tailLine) {
  const candidateStatements = [];

  function collectStatement(statement) {
    const startLine = lineOf(sourceFile, statement);
    const endLine = endLineOf(sourceFile, statement);
    if (endLine < headLine || startLine > tailLine) {
      return;
    }

    const spansOutsidePhase = startLine < headLine || endLine > tailLine;
    const childStatements = [];
    statement.forEachChild((child) => {
      if (ts.isBlock(child) || ts.isCaseBlock(child)) {
        childStatements.push(...child.statements);
      } else if (ts.isIfStatement(child)) {
        if (ts.isBlock(child.thenStatement)) childStatements.push(...child.thenStatement.statements);
        if (child.elseStatement && ts.isBlock(child.elseStatement)) childStatements.push(...child.elseStatement.statements);
      }
    });

    if (spansOutsidePhase && childStatements.length) {
      childStatements.forEach(collectStatement);
      return;
    }

    candidateStatements.push(statement);
  }

  fn.body.statements.forEach(collectStatement);

  const raw = candidateStatements
    .map((statement) => {
      const calls = collectCalls(sourceFile, statement);
      const section = {
        startLine: lineOf(sourceFile, statement),
        endLine: endLineOf(sourceFile, statement),
        calls,
        hasReturn: hasReturn(statement),
        text: statement.getText(sourceFile),
        evidence: oneLine(statement.getText(sourceFile)),
      };
      const [label, kind] = classifySection(section);
      return { ...section, label, kind };
    });
  return raw.map((section, index) => ({ ...section, index: index + 1, key: `input-intake.section.${index + 1}` }));
}

async function loadPhaseBounds(session) {
  const result = await session.run(
    `
      MATCH (phase:Phase {key: $phaseKey})
      OPTIONAL MATCH (phase)-[:HEADS_AT]->(head)
      OPTIONAL MATCH (phase)-[:TAILS_AT]->(tail)
      RETURN head.start_line AS headLine, tail.start_line AS tailLine
    `,
    { phaseKey },
  );
  const record = result.records[0];
  return {
    headLine: record.get('headLine')?.toNumber?.() ?? record.get('headLine'),
    tailLine: record.get('tailLine')?.toNumber?.() ?? record.get('tailLine'),
  };
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources.filter((resource) => {
    const key = `${resource.resourceKey}:${resource.accessType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  return value?.toNumber?.() ?? value;
}

function getStatementControlKind(text) {
  const normalized = String(text || '').trim();
  if (/^if\b/.test(normalized)) return 'branch';
  if (/^(for|while)\b/.test(normalized)) return 'loop';
  if (/^try\b/.test(normalized)) return 'try';
  if (/^switch\b/.test(normalized)) return 'switch';
  if (/^return\b/.test(normalized)) return 'return';
  return 'straight';
}

function getSectionStageSignature(section) {
  const resourceFamilies = [...new Set((section.resources || []).map((resource) => resource.resourceKind).filter(Boolean))].sort();
  const hasAsyncBoundary = /\b(await|for\s+await|yield)\b/.test(section.text);
  const controlKind = getStatementControlKind(section.text);
  if (section.hasReturn || controlKind === 'return') return `terminal:${controlKind}`;
  if (resourceFamilies.length) return `resource:${resourceFamilies.join('+')}`;
  if (hasAsyncBoundary && controlKind !== 'straight') return `async-control:${controlKind}`;
  if (hasAsyncBoundary) return 'async';
  if (controlKind !== 'straight') return `control:${controlKind}`;
  return 'sync';
}

function labelStage(signature) {
  if (signature.startsWith('terminal:')) return 'Terminal/control branch';
  if (signature.startsWith('resource:')) return 'Resource side effects';
  if (signature.startsWith('async-control:')) return 'Async control block';
  if (signature === 'async') return 'Async work';
  if (signature.startsWith('control:')) return 'Control cluster';
  return 'Sync run';
}

function shouldStartNewStage(currentStage, section) {
  if (!currentStage) return true;
  const signature = getSectionStageSignature(section);
  const lastSection = currentStage.sections[currentStage.sections.length - 1];
  if (lastSection?.hasReturn) return true;
  if (section.hasReturn) return true;
  if (signature !== currentStage.signature) return true;
  return false;
}

function buildStages(sections) {
  const stages = [];
  let currentStage;
  for (const section of sections) {
    const signature = getSectionStageSignature(section);
    if (shouldStartNewStage(currentStage, section)) {
      currentStage = {
        index: stages.length + 1,
        key: `stage.${stages.length + 1}`,
        signature,
        label: labelStage(signature),
        sections: [],
      };
      stages.push(currentStage);
    }
    currentStage.sections.push(section);
  }

  return stages.map((stage) => ({
    ...stage,
    startLine: stage.sections[0].startLine,
    endLine: stage.sections[stage.sections.length - 1].endLine,
    stepCount: stage.sections.reduce((sum, section) => sum + section.stepCount, 0),
    targetCallCount: stage.sections.reduce((sum, section) => sum + section.targetCalls.length, 0),
    resourceTouchCount: stage.sections.reduce((sum, section) => sum + section.resources.length, 0),
  }));
}

async function enrichSections(session, sections) {
  const rows = [];
  for (const section of sections) {
    const result = await session.run(
      `
        MATCH (step:Step {source: $source, parentFnStableId: $fnStableId})
        WHERE step.start_line >= $startLine AND step.start_line <= $endLine
        OPTIONAL MATCH (step)-[callRel]->(callee:Fn)
        WHERE callRel.source = $source AND callRel.role = 'call'
        OPTIONAL MATCH (step)-[resourceRel]->(resource {source: $source})
        WHERE resource.resource_kind IS NOT NULL AND type(resourceRel) IN ['READS_RESOURCE','TESTS_RESOURCE','CREATES_RESOURCE','UPDATES_RESOURCE','DELETES_RESOURCE','CLEARS_RESOURCE','EMITS_TO','WAITS_ON','SUBSCRIBES_TO','SIGNALS_RESOURCE']
        RETURN count(DISTINCT step) AS stepCount,
               collect(DISTINCT {
                 line: step.start_line,
                 column: step.start_column,
                 calleeText: step.operation_callee_text,
                 targetStableId: callee.stableId,
                 targetName: callee.name
               }) AS calls,
               collect(DISTINCT {
                 line: step.start_line,
                 column: step.start_column,
                 relType: type(resourceRel),
                 accessType: resourceRel.access_type,
                 resourceKey: resource.resource_key,
                 resourceKind: resource.resource_kind,
                 resourceSubkind: resource.resource_subkind,
                 resourceName: resource.resource_name
               }) AS resources
      `,
      { source: graphSource, fnStableId, startLine: section.startLine, endLine: section.endLine },
    );
    const record = result.records[0];
    const targetCalls = (record.get('calls') || [])
      .filter((call) => call.targetStableId)
      .map((call) => ({ ...call, line: toNumber(call.line), column: toNumber(call.column) }))
      .sort((a, b) => (a.line - b.line) || (a.column - b.column));
    const resources = dedupeResources((record.get('resources') || [])
      .filter((resource) => resource.resourceKey && resource.resourceKind !== 'async-control')
      .map((resource) => ({ ...resource, line: toNumber(resource.line), column: toNumber(resource.column) }))
      .sort((a, b) => (a.line - b.line) || (a.column - b.column)));
    rows.push({
      ...section,
      stepCount: record.get('stepCount')?.toNumber?.() ?? 0,
      targetCalls,
      resources,
    });
  }
  return rows;
}

function styleForKind(kind) {
  const map = {
    'diagnostics-start': ['#e8f4ff', '#4f8cc9'],
    'ui-feedback': ['#eaf9fb', '#56a6b3'],
    'runtime-bootstrap': ['#f7f7f7', '#777777'],
    'context-assembly': ['#eaf3ff', '#4f77c9'],
    'context-handoff': ['#eaf3ff', '#4f77c9'],
    'query-decision': ['#fff4df', '#c08a2c'],
    'guard-return': ['#fff0f0', '#c45f5f'],
  };
  const [fill, stroke] = map[kind] || ['#f5f5f5', '#777777'];
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=1.4;fontColor=#1f1f1f;fontSize=11;align=left;verticalAlign=top;spacing=8;`;
}

function resourceStyle(resource) {
  const map = {
    'ui-state': ['#f3ecff', '#8b61bd'],
    'input-state': ['#eaf9fb', '#51a5b1'],
    'runtime-state': ['#f7f7f7', '#777777'],
    'telemetry-sink': ['#fff4df', '#c08a2c'],
    'config-store': ['#f0f0ff', '#7871c7'],
  };
  const [fill, stroke] = map[resource.resourceKind] || ['#ffffff', '#8a8a8a'];
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontColor=#242424;fontSize=10;align=left;verticalAlign=middle;spacing=8;`;
}

function cell(lines, id, value, style, x, y, width, height) {
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`);
}

function edge(lines, id, source, target, value = '', style = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#555555;strokeWidth=1.3;fontSize=9;') {
  lines.push(`<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${style}" edge="1" parent="1" source="${escapeXml(source)}" target="${escapeXml(target)}"><mxGeometry relative="1" as="geometry" /></mxCell>`);
}

function render(sections) {
  const lines = [];
  const uiX = 20;
  const laneX = 310;
  const callX = 760;
  const resourceX = 1070;
  const laneWidth = 380;
  const rowGap = 42;
  const startY = 150;
  const heights = sections.map((section) => Math.max(104, 84 + Math.max(section.targetCalls.length, section.resources.length) * 62));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0) + rowGap * sections.length + 220;

  lines.push('<mxfile host="app.diagrams.net" modified="2026-06-09T00:00:00.000Z" agent="Codex" version="24.7.17">');
  lines.push(`<diagram id="turn-input-intake-phase-sections" name="Input Intake"><mxGraphModel dx="1800" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1400" pageHeight="${totalHeight}" math="0" shadow="0"><root>`);
  lines.push('<mxCell id="0" /><mxCell id="1" parent="0" />');
  cell(lines, 'title', 'Phase sections&#xa;Input Intake&#xa;lane: onQueryImpl()', 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=18;fontStyle=1;', 30, 20, 780, 72);
  cell(lines, 'lane-header', `Fn lane&#xa;onQueryImpl()&#xa;${fnStableId}`, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#24292f;strokeColor=#24292f;fontColor=#ffffff;fontStyle=1;fontSize=12;align=center;verticalAlign=middle;', laneX, 80, laneWidth, 56);

  let y = startY;
  sections.forEach((section, index) => {
    const sectionId = `section-${section.index}`;
    const height = heights[index];
    const sectionLabel = `${section.index}. ${section.label}&#xa;${section.startLine}-${section.endLine} В· ${section.stepCount} flow steps${section.hasReturn ? ' В· return' : ''}&#xa;&#xa;${truncate(section.evidence, 110)}`;
    cell(lines, sectionId, sectionLabel, styleForKind(section.kind), laneX, y, laneWidth, height);
    if (index > 0) edge(lines, `flow-${index}`, `section-${sections[index - 1].index}`, sectionId);

    section.resources.filter((resource) => ['ui-state', 'input-state'].includes(resource.resourceKind)).forEach((resource, resourceIndex) => {
      const anchorId = `section-${section.index}-ui-anchor-${resourceIndex}`;
      const resourceId = `section-${section.index}-ui-resource-${resourceIndex}`;
      const ry = y + 12 + resourceIndex * 64;
      cell(lines, anchorId, '', 'ellipse;html=1;fillColor=#7a6ab0;strokeColor=#7a6ab0;', laneX - 4, ry + 23, 8, 8);
      cell(lines, resourceId, `${resource.accessType} ${resource.resourceName}&#xa;${resource.resourceKind}/${resource.resourceSubkind}&#xa;@ ${resource.line}:${resource.column}`, resourceStyle(resource), uiX, ry, 230, 54);
      edge(lines, `ui-${section.index}-${resourceIndex}`, anchorId, resourceId, resource.accessType, 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#7a6ab0;strokeWidth=1.2;fontSize=9;');
    });

    section.targetCalls.forEach((call, callIndex) => {
      const anchorId = `section-${section.index}-call-anchor-${callIndex}`;
      const callId = `section-${section.index}-call-${callIndex}`;
      const cy = y + 12 + callIndex * 64;
      cell(lines, anchorId, '', 'ellipse;html=1;fillColor=#4e6f9e;strokeColor=#4e6f9e;', laneX + laneWidth - 4, cy + 23, 8, 8);
      cell(lines, callId, `${call.targetName || call.calleeText}&#xa;call @ ${call.line}:${call.column}&#xa;${truncate(String(call.targetStableId || '').split(':')[0], 36)}`, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6f6f6f;fontColor=#2f2f2f;fontSize=10;align=left;verticalAlign=middle;spacing=8;', callX, cy, 250, 54);
      edge(lines, `call-${section.index}-${callIndex}`, anchorId, callId, truncate(call.calleeText || call.targetName, 24), 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#4e6f9e;strokeWidth=1.3;fontSize=9;');
      edge(lines, `return-${section.index}-${callIndex}`, callId, anchorId, 'return', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=open;dashed=1;strokeColor=#9b9b9b;strokeWidth=1;fontSize=9;');
    });

    section.resources.filter((resource) => !['ui-state', 'input-state'].includes(resource.resourceKind)).forEach((resource, resourceIndex) => {
      const resourceId = `section-${section.index}-resource-${resourceIndex}`;
      const ry = y + 12 + resourceIndex * 64;
      cell(lines, resourceId, `${resource.accessType} ${resource.resourceName}&#xa;${resource.resourceKind}/${resource.resourceSubkind}&#xa;@ ${resource.line}:${resource.column}`, resourceStyle(resource), resourceX, ry, 270, 54);
      edge(lines, `resource-${section.index}-${resourceIndex}`, sectionId, resourceId, resource.accessType, 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#8a6f3e;strokeWidth=1.2;fontSize=9;');
    });

    y += height + rowGap;
  });
  lines.push('</root></mxGraphModel></diagram></mxfile>');
  return lines.join('');
}

function renderWithStages(stages) {
  const lines = [];
  const uiX = 20;
  const stageX = 270;
  const laneX = 420;
  const callX = 850;
  const resourceX = 1160;
  const stageWidth = 120;
  const laneWidth = 360;
  const rowGap = 34;
  const stageGap = 46;
  const startY = 150;
  const sections = stages.flatMap((stage) => stage.sections);
  const sectionHeights = new Map();
  sections.forEach((section) => {
    sectionHeights.set(section.index, Math.max(92, 72 + Math.max(section.targetCalls.length, section.resources.length) * 58));
  });
  const stageHeights = stages.map((stage) => {
    const sectionTotal = stage.sections.reduce((sum, section) => sum + sectionHeights.get(section.index), 0);
    return Math.max(112, sectionTotal + rowGap * Math.max(0, stage.sections.length - 1) + 28);
  });
  const totalHeight = stageHeights.reduce((sum, height) => sum + height, 0) + stageGap * stages.length + 220;

  lines.push('<mxfile host="app.diagrams.net" modified="2026-06-09T00:00:00.000Z" agent="Codex" version="24.7.17">');
  lines.push(`<diagram id="${escapeXml(phaseKey)}-phase-stages" name="${escapeXml(phaseKey)}"><mxGraphModel dx="1900" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1500" pageHeight="${totalHeight}" math="0" shadow="0"><root>`);
  lines.push('<mxCell id="0" /><mxCell id="1" parent="0" />');
  cell(lines, 'title', `Phase stages&#xa;${phaseKey}&#xa;Function lane: ${fnStableId}`, 'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=18;fontStyle=1;', 30, 20, 900, 72);
  cell(lines, 'ui-header', 'UI / input side effects', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f3ecff;strokeColor=#8b61bd;fontColor=#242424;fontStyle=1;fontSize=11;align=center;verticalAlign=middle;', uiX, 88, 220, 44);
  cell(lines, 'stage-header', 'Stage', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e8eef7;strokeColor=#7086a7;fontColor=#1f2a37;fontStyle=1;fontSize=12;align=center;verticalAlign=middle;', stageX, 88, stageWidth, 44);
  cell(lines, 'lane-header', `Function&#xa;${String(fnStableId).split(':')[0]}`, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#24292f;strokeColor=#24292f;fontColor=#ffffff;fontStyle=1;fontSize=12;align=center;verticalAlign=middle;', laneX, 80, laneWidth, 56);
  cell(lines, 'call-header', 'Called functions', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#eef5ff;strokeColor=#6f8db8;fontColor=#24364d;fontStyle=1;fontSize=11;align=center;verticalAlign=middle;', callX, 88, 250, 44);
  cell(lines, 'resource-header', 'Stateful / external', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff7e8;strokeColor=#b98b43;fontColor=#3b2b12;fontStyle=1;fontSize=11;align=center;verticalAlign=middle;', resourceX, 88, 270, 44);

  let y = startY;
  let previousSectionId = null;
  stages.forEach((stage, stageIndex) => {
    const stageHeight = stageHeights[stageIndex];
    const stageId = `stage-${stage.index}`;
    const stageLabel = `${stage.index}. ${stage.label}&#xa;${stage.startLine}-${stage.endLine}&#xa;${stage.sections.length} sections / ${stage.stepCount} steps`;
    cell(lines, stageId, stageLabel, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f7f9fc;strokeColor=#9aa9bc;strokeWidth=1.6;fontColor=#1f2a37;fontSize=11;fontStyle=1;align=center;verticalAlign=middle;spacing=8;', stageX, y, stageWidth, stageHeight);

    let sectionY = y + 14;
    stage.sections.forEach((section) => {
      const sectionId = `section-${section.index}`;
      const height = sectionHeights.get(section.index);
      const sectionLabel = `${section.index}. ${section.label}&#xa;${section.startLine}-${section.endLine} В· ${section.stepCount} flow steps${section.hasReturn ? ' В· return' : ''}&#xa;&#xa;${truncate(section.evidence, 105)}`;
      cell(lines, sectionId, sectionLabel, styleForKind(section.kind), laneX, sectionY, laneWidth, height);
      edge(lines, `stage-owns-${stage.index}-${section.index}`, stageId, sectionId, '', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=none;strokeColor=#c4ccd6;strokeWidth=1;dashed=1;');
      if (previousSectionId) edge(lines, `flow-${section.index}`, previousSectionId, sectionId);
      previousSectionId = sectionId;

      section.resources.filter((resource) => ['ui-state', 'input-state'].includes(resource.resourceKind)).forEach((resource, resourceIndex) => {
        const anchorId = `section-${section.index}-ui-anchor-${resourceIndex}`;
        const resourceId = `section-${section.index}-ui-resource-${resourceIndex}`;
        const ry = sectionY + 10 + resourceIndex * 58;
        cell(lines, anchorId, '', 'ellipse;html=1;fillColor=#7a6ab0;strokeColor=#7a6ab0;', laneX - 4, ry + 22, 8, 8);
        cell(lines, resourceId, `${resource.accessType} ${resource.resourceName}&#xa;${resource.resourceKind}/${resource.resourceSubkind}&#xa;@ ${resource.line}:${resource.column}`, resourceStyle(resource), uiX, ry, 220, 50);
        edge(lines, `ui-${section.index}-${resourceIndex}`, anchorId, resourceId, resource.accessType, 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#7a6ab0;strokeWidth=1.2;fontSize=9;');
      });

      section.targetCalls.forEach((call, callIndex) => {
        const anchorId = `section-${section.index}-call-anchor-${callIndex}`;
        const callId = `section-${section.index}-call-${callIndex}`;
        const cy = sectionY + 10 + callIndex * 58;
        cell(lines, anchorId, '', 'ellipse;html=1;fillColor=#4e6f9e;strokeColor=#4e6f9e;', laneX + laneWidth - 4, cy + 22, 8, 8);
        cell(lines, callId, `${call.targetName || call.calleeText}&#xa;call @ ${call.line}:${call.column}&#xa;${truncate(String(call.targetStableId || '').split(':')[0], 36)}`, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6f6f6f;fontColor=#2f2f2f;fontSize=10;align=left;verticalAlign=middle;spacing=8;', callX, cy, 250, 50);
        edge(lines, `call-${section.index}-${callIndex}`, anchorId, callId, truncate(call.calleeText || call.targetName, 24), 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#4e6f9e;strokeWidth=1.3;fontSize=9;');
        edge(lines, `return-${section.index}-${callIndex}`, callId, anchorId, 'return', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=open;dashed=1;strokeColor=#9b9b9b;strokeWidth=1;fontSize=9;');
      });

      section.resources.filter((resource) => !['ui-state', 'input-state'].includes(resource.resourceKind)).forEach((resource, resourceIndex) => {
        const resourceId = `section-${section.index}-resource-${resourceIndex}`;
        const ry = sectionY + 10 + resourceIndex * 58;
        cell(lines, resourceId, `${resource.accessType} ${resource.resourceName}&#xa;${resource.resourceKind}/${resource.resourceSubkind}&#xa;@ ${resource.line}:${resource.column}`, resourceStyle(resource), resourceX, ry, 270, 50);
        edge(lines, `resource-${section.index}-${resourceIndex}`, sectionId, resourceId, resource.accessType, 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=#8a6f3e;strokeWidth=1.2;fontSize=9;');
      });

      sectionY += height + rowGap;
    });
    y += stageHeight + stageGap;
  });
  lines.push('</root></mxGraphModel></diagram></mxfile>');
  return lines.join('');
}

async function main() {
  const driver = neo4j.driver(normalizeNeo4jUri(process.env.NEO4J_URI), neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j', defaultAccessMode: neo4j.session.READ });
  try {
    const { headLine, tailLine } = await loadPhaseBounds(session);
    const { sourceFile, fn } = findFunctionByStableId(createProgram());
    const sections = await enrichSections(session, buildSections(sourceFile, fn, headLine, tailLine));
    const stages = buildStages(sections);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, renderWithStages(stages), 'utf8');
    console.log(JSON.stringify({
      saved: true,
      outputPath,
      phaseKey,
      fnStableId,
      headLine,
      tailLine,
      stageCount: stages.length,
      sectionCount: sections.length,
      targetCallCount: sections.reduce((sum, section) => sum + section.targetCalls.length, 0),
      resourceTouchCount: sections.reduce((sum, section) => sum + section.resources.length, 0),
      stages: stages.map((stage) => ({ index: stage.index, label: stage.label, signature: stage.signature, lines: `${stage.startLine}-${stage.endLine}`, sections: stage.sections.length, stepCount: stage.stepCount, targetCalls: stage.targetCallCount, resources: stage.resourceTouchCount })),
      sections: sections.map((section) => ({ index: section.index, label: section.label, lines: `${section.startLine}-${section.endLine}`, stepCount: section.stepCount, targetCalls: section.targetCalls.length, resources: section.resources.length })),
    }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();

