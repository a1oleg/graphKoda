import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

const workspaceRoot = process.cwd();
const source = 'semantic/functionStages';

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function normalizeNeo4jUri(uri) {
  return String(uri || '')
    .replace('neo4j://localhost', 'bolt://localhost')
    .replace('neo4j://127.0.0.1', 'bolt://127.0.0.1');
}

function neo4jNumber(value) {
  return value?.toNumber?.() ?? value;
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(String(text));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeStage(row) {
  return {
    id: row.key,
    key: row.key,
    stableId: row.stableId || row.key,
    label: row.label,
    kind: row.kind,
    index: neo4jNumber(row.index) || 0,
    order: neo4jNumber(row.order) || neo4jNumber(row.index) || 0,
    displayIndex: row.displayIndex || '',
    renderer: row.renderer || 'bpmn',
    icon: row.icon || 'zap',
    lines: row.lines || '',
    startLine: neo4jNumber(row.startLine),
    endLine: neo4jNumber(row.endLine),
    stepCount: neo4jNumber(row.stepCount) || 0,
    headStepStableId: row.headStepStableId || null,
    tailStepStableId: row.tailStepStableId || null,
    targetCalls: parseJsonArray(row.targetCallsJson),
    resourceTouches: parseJsonArray(row.resourceTouchesJson),
    sections: parseJsonArray(row.sectionsJson),
  };
}

function normalizeFunction(record) {
  const fn = record.get('fn');
  const stages = (record.get('stages') || []).map(normalizeStage);
  return {
    id: fn.stableId,
    stableId: fn.stableId,
    label: fn.label || fn.name || fn.stableId,
    name: fn.name || fn.label,
    file: fn.file || '',
    lines: fn.lines || '',
    startLine: neo4jNumber(fn.startLine),
    endLine: neo4jNumber(fn.endLine),
    lineCount: neo4jNumber(fn.lineCount) || 0,
    phaseKey: fn.phaseKey || fn.stableId,
    phaseLabel: fn.phaseLabel || fn.label || fn.name,
    stageCount: neo4jNumber(fn.stageCount) || stages.length,
    stepCount: neo4jNumber(fn.stepCount) || 0,
    sizeClass: fn.sizeClass || (stages.length ? 'large' : 'small'),
    renderer: fn.renderer || (stages.length ? 'linear' : 'bpmn'),
    classificationReasons: fn.classificationReasons || [],
    icon: (fn.sizeClass || 'large') === 'large' ? 'folder' : 'zap',
    order: 1,
    displayIndex: '#1',
    stages: stages.map((stage, index) => ({
      ...stage,
      order: stage.order || index + 1,
      displayIndex: stage.displayIndex || `#1.${index + 1}`,
    })),
  };
}

export async function queryGraphExplorerFunctions() {
  const uri = normalizeNeo4jUri(process.env.NEO4J_URI);
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  if (!uri || !user || !password) {
    return {
      schema: { kind: 'graph-function-menu', version: 4 },
      generatedAt: null,
      functions: [],
      orderSource: 'neo4j:functionStages',
      errors: ['Neo4j settings are missing.'],
    };
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `
        MATCH (fn:Fn {function_menu_source: $source})
        OPTIONAL MATCH (fn)-[:HAS_FUNCTION_STAGE {source: $source}]->(stage:FunctionStage {source: $source})
        WITH fn, stage
        ORDER BY coalesce(stage.stage_order, stage.stage_index, 0), stage.start_line
        WITH fn, collect(stage {
          .key,
          stableId: stage.stableId,
          .label,
          .kind,
          index: stage.stage_index,
          order: stage.stage_order,
          displayIndex: stage.display_index,
          .renderer,
          .icon,
          .lines,
          startLine: stage.start_line,
          endLine: stage.end_line,
          stepCount: stage.step_count,
          headStepStableId: stage.headStepStableId,
          tailStepStableId: stage.tailStepStableId,
          targetCallsJson: stage.target_calls_json,
          resourceTouchesJson: stage.resource_touches_json,
          sectionsJson: stage.sections_json
        }) AS stages
        RETURN fn {
          stableId: fn.stableId,
          name: fn.name,
          label: fn.graph_explorer_label,
          file: fn.graph_explorer_file,
          lines: fn.graph_explorer_lines,
          startLine: fn.graph_explorer_start_line,
          endLine: fn.graph_explorer_end_line,
          lineCount: fn.graph_explorer_line_count,
          phaseKey: fn.graph_explorer_phase_key,
          phaseLabel: fn.graph_explorer_phase_label,
          stageCount: fn.graph_explorer_stage_count,
          stepCount: fn.graph_explorer_step_count,
          sizeClass: fn.graph_explorer_size_class,
          renderer: fn.graph_explorer_renderer,
          classificationReasons: fn.graph_explorer_classification_reasons
        } AS fn,
        stages
        ORDER BY fn.file, fn.startLine, fn.label
      `,
      { source },
    );
    const functions = result.records.map(normalizeFunction);
    functions.forEach((fn, index) => {
      fn.order = index + 1;
      fn.displayIndex = `#${index + 1}`;
      fn.stages = (fn.stages || []).map((stage, stageIndex) => ({
        ...stage,
        displayIndex: `#${index + 1}.${stageIndex + 1}`,
      }));
    });
    return {
      schema: { kind: 'graph-function-menu', version: 4 },
      generatedAt: new Date().toISOString(),
      functions,
      orderSource: 'neo4j:functionStages',
      errors: [],
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = await queryGraphExplorerFunctions();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

