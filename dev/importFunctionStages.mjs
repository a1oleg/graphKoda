import path from 'node:path';

import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';

import { deriveAllFunctionStages } from './deriveFunctionStages.mjs';
import { buildGraphFunctionsPayload } from './deriveGraphFunctions.mjs';

const workspaceRoot = process.cwd();
const source = 'semantic/functionStages';
const legacySource = 'semantic/functionComposition';

dotenv.config({ path: path.join(workspaceRoot, 'graph', '.env') });

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    fnStableId: undefined,
    functionsPath: undefined,
    maxStageLines: undefined,
    maxStageSteps: undefined,
    maxSectionLines: undefined,
    functionName: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--fn-stable-id') {
      args.fnStableId = value;
      index += 1;
    } else if (arg === '--functions-path') {
      args.functionsPath = path.resolve(workspaceRoot, value);
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
    } else if (arg === '--function-name') {
      args.functionName = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node dev/importFunctionStages.mjs [--fn-stable-id <stableID>]',
        '       [--functions-path <path>] [--max-stage-lines <n>] [--max-stage-steps <n>] [--max-section-lines <n>]',
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

function flattenStageSets(payload) {
  const rows = [];
  for (const stageSet of payload.stageSets || []) {
    for (const stage of stageSet.stages || []) {
      rows.push({
        type: 'stage',
        key: stage.key,
        label: stage.label,
        kind: stage.kind,
        index: stage.index,
        startLine: stage.startLine,
        endLine: stage.endLine,
        headStepStableId: stage.headStepStableId,
        tailStepStableId: stage.tailStepStableId,
        parentKey: null,
        parentType: null,
        phaseKey: stageSet.phase.key,
        phaseLabel: stageSet.phase.label,
        functionStableId: stageSet.function.stableId,
        functionName: stageSet.function.name,
      });
      for (const section of stage.sections || []) {
        rows.push({
          type: 'section',
          key: section.key,
          label: section.label,
          kind: section.kind,
          index: section.index,
          startLine: section.startLine,
          endLine: section.endLine,
          headStepStableId: section.headStepStableId,
          tailStepStableId: section.tailStepStableId,
          parentKey: stage.key,
          parentType: 'stage',
          phaseKey: stageSet.phase.key,
          phaseLabel: stageSet.phase.label,
          functionStableId: stageSet.function.stableId,
          functionName: stageSet.function.name,
        });
      }
    }
  }
  return rows.filter((row) => row.headStepStableId && row.tailStepStableId);
}

function flattenFunctions(functionsPayload) {
  return (functionsPayload.functions || []).map((fn) => ({
    stableId: fn.stableId,
    name: fn.name,
    label: fn.label,
    file: fn.file,
    lines: fn.lines,
    startLine: fn.startLine,
    endLine: fn.endLine,
    lineCount: fn.lineCount,
    phaseKey: fn.phaseKey,
    phaseLabel: fn.phaseLabel,
    stageCount: fn.stageCount,
    stepCount: fn.stepCount,
    sizeClass: fn.sizeClass,
    renderer: fn.renderer,
    classificationReasons: fn.classificationReasons || [],
  }));
}

function flattenFunctionStageNodes(functionsPayload) {
  return (functionsPayload.functions || []).flatMap((fn) => (fn.stages || []).map((stage) => ({
    key: stage.key,
    stableId: stage.stableId,
    label: stage.label,
    kind: stage.kind,
    index: stage.order || stage.index || 0,
    order: stage.order || stage.index || 0,
    displayIndex: stage.displayIndex || '',
    renderer: stage.renderer || 'bpmn',
    icon: stage.icon || 'zap',
    lines: stage.lines,
    startLine: stage.startLine,
    endLine: stage.endLine,
    stepCount: stage.stepCount || 0,
    headStepStableId: stage.headStepStableId,
    tailStepStableId: stage.tailStepStableId,
    targetCallsJson: JSON.stringify(stage.targetCalls || []),
    resourceTouchesJson: JSON.stringify(stage.resourceTouches || []),
    sectionsJson: JSON.stringify(stage.sections || []),
    functionStableId: fn.stableId,
    functionName: fn.name,
    phaseKey: fn.phaseKey,
    phaseLabel: fn.phaseLabel,
  })));
}

async function clearPrevious(session, fnStableId = null) {
  await session.executeWrite(async (tx) => {
    await tx.run(
      `
        MATCH (step:Step)
        WHERE (step.stages_source IN $sources OR step.composition_source IN $sources)
          AND ($fnStableId IS NULL OR step.stages_fn_stableId = $fnStableId OR step.parentFnStableId = $fnStableId)
        REMOVE step:StageHead:SectionHead
        REMOVE step.stages_source,
               step.composition_source,
               step.stage_key,
               step.stage_label,
               step.stage_kind,
               step.stage_index,
               step.stage_start_line,
               step.stage_end_line,
               step.stage_tailStepStableId,
               step.section_key,
               step.section_label,
               step.section_kind,
               step.section_index,
               step.section_start_line,
               step.section_end_line,
               step.section_tailStepStableId,
               step.section_parent_stage_key,
               step.stages_phase_key,
               step.stages_phase_label,
               step.stages_fn_stableId,
               step.stages_fn_name,
               step.composition_phase_key,
               step.composition_phase_label,
               step.composition_fn_stableId,
               step.composition_fn_name
      `,
      { sources: [source, legacySource], fnStableId },
    );
    await tx.run(
      `
        MATCH ()-[rel]->()
        WHERE rel.source = $source
          AND ($fnStableId IS NULL OR rel.function_stableId = $fnStableId)
        DELETE rel
      `,
      { source, fnStableId },
    );
    await tx.run(
      `
        MATCH (stage:FunctionStage {source: $source})
        WHERE $fnStableId IS NULL OR stage.function_stableId = $fnStableId
        DETACH DELETE stage
      `,
      { source, fnStableId },
    );
    await tx.run(
      `
        MATCH (fn:Fn)
        WHERE fn.function_menu_source = $source
          AND ($fnStableId IS NULL OR fn.stableId = $fnStableId)
        REMOVE fn.function_menu_source,
               fn.graph_explorer_label,
               fn.graph_explorer_file,
               fn.graph_explorer_lines,
               fn.graph_explorer_start_line,
               fn.graph_explorer_end_line,
               fn.graph_explorer_line_count,
               fn.graph_explorer_phase_key,
               fn.graph_explorer_phase_label,
               fn.graph_explorer_stage_count,
               fn.graph_explorer_step_count,
               fn.graph_explorer_size_class,
               fn.graph_explorer_renderer,
               fn.graph_explorer_classification_reasons
      `,
      { source, fnStableId },
    );
  });
}

async function writeStages(session, rows) {
  const stages = rows.filter((row) => row.type === 'stage');
  const sections = rows.filter((row) => row.type === 'section');
  await session.executeWrite(async (tx) => {
    await tx.run(
      `
        UNWIND $stages AS row
        MATCH (head:Step {stableId: row.headStepStableId})
        SET head:StageHead,
            head.stages_source = $source,
            head.stage_key = row.key,
            head.stage_label = row.label,
            head.stage_kind = row.kind,
            head.stage_index = row.index,
            head.stage_start_line = row.startLine,
            head.stage_end_line = row.endLine,
            head.stage_tailStepStableId = row.tailStepStableId,
            head.stages_phase_key = row.phaseKey,
            head.stages_phase_label = row.phaseLabel,
            head.stages_fn_stableId = row.functionStableId,
            head.stages_fn_name = row.functionName
      `,
      { stages, source },
    );
    await tx.run(
      `
        UNWIND $sections AS row
        MATCH (head:Step {stableId: row.headStepStableId})
        SET head:SectionHead,
            head.stages_source = $source,
            head.section_key = row.key,
            head.section_label = row.label,
            head.section_kind = row.kind,
            head.section_index = row.index,
            head.section_start_line = row.startLine,
            head.section_end_line = row.endLine,
            head.section_tailStepStableId = row.tailStepStableId,
            head.section_parent_stage_key = row.parentKey,
            head.stages_phase_key = row.phaseKey,
            head.stages_phase_label = row.phaseLabel,
            head.stages_fn_stableId = row.functionStableId,
            head.stages_fn_name = row.functionName
      `,
      { sections, source },
    );
  });
}

async function writeFunctionClassification(session, functions, stages) {
  await session.executeWrite(async (tx) => {
    await tx.run(
      `
        UNWIND $functions AS row
        MATCH (fn:Fn {stableId: row.stableId})
        SET fn.function_menu_source = $source,
            fn.graph_explorer_label = row.label,
            fn.graph_explorer_file = row.file,
            fn.graph_explorer_lines = row.lines,
            fn.graph_explorer_start_line = row.startLine,
            fn.graph_explorer_end_line = row.endLine,
            fn.graph_explorer_line_count = row.lineCount,
            fn.graph_explorer_phase_key = row.phaseKey,
            fn.graph_explorer_phase_label = row.phaseLabel,
            fn.graph_explorer_stage_count = row.stageCount,
            fn.graph_explorer_step_count = row.stepCount,
            fn.graph_explorer_size_class = row.sizeClass,
            fn.graph_explorer_renderer = row.renderer,
            fn.graph_explorer_classification_reasons = row.classificationReasons
      `,
      { functions, source },
    );
    await tx.run(
      `
        UNWIND $stages AS row
        MERGE (stage:FunctionStage {key: row.key})
        SET stage.source = $source,
            stage.stableId = row.stableId,
            stage.label = row.label,
            stage.kind = row.kind,
            stage.stage_index = row.index,
            stage.stage_order = row.order,
            stage.display_index = row.displayIndex,
            stage.renderer = row.renderer,
            stage.icon = row.icon,
            stage.lines = row.lines,
            stage.start_line = row.startLine,
            stage.end_line = row.endLine,
            stage.step_count = row.stepCount,
            stage.headStepStableId = row.headStepStableId,
            stage.tailStepStableId = row.tailStepStableId,
            stage.target_calls_json = row.targetCallsJson,
            stage.resource_touches_json = row.resourceTouchesJson,
            stage.sections_json = row.sectionsJson,
            stage.function_stableId = row.functionStableId,
            stage.function_name = row.functionName,
            stage.phase_key = row.phaseKey,
            stage.phase_label = row.phaseLabel
        WITH stage, row
        MATCH (fn:Fn {stableId: row.functionStableId})
        MERGE (fn)-[hasStage:HAS_FUNCTION_STAGE]->(stage)
        SET hasStage.source = $source,
            hasStage.function_stableId = row.functionStableId
        WITH stage, row
        MATCH (head:Step {stableId: row.headStepStableId})
        MERGE (stage)-[headRel:HEADS_AT]->(head)
        SET headRel.source = $source,
            headRel.function_stableId = row.functionStableId
        WITH stage, row
        MATCH (tail:Step {stableId: row.tailStepStableId})
        MERGE (stage)-[tailRel:TAILS_AT]->(tail)
        SET tailRel.source = $source,
            tailRel.function_stableId = row.functionStableId
      `,
      { stages, source },
    );
  });
}

async function main() {
  const args = parseArgs();
  const payload = await deriveAllFunctionStages(args);
  if (payload.errors?.length) {
    throw new Error(`stages extractor returned errors:\n${payload.errors.join('\n')}`);
  }
  const functionsPayload = buildGraphFunctionsPayload(payload);
  if (functionsPayload.errors?.length) {
    throw new Error(`function menu extractor returned errors:\n${functionsPayload.errors.join('\n')}`);
  }
  const rows = flattenStageSets(payload);
  const functions = flattenFunctions(functionsPayload);
  const functionStages = flattenFunctionStageNodes(functionsPayload).filter((row) => row.headStepStableId && row.tailStepStableId);
  const uri = normalizeNeo4jUri(process.env.NEO4J_URI);
  const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ database });
  try {
    await clearPrevious(session, args.fnStableId || null);
    await writeStages(session, rows);
    await writeFunctionClassification(session, functions, functionStages);
  } finally {
    await session.close();
    await driver.close();
  }
  console.log(`Imported ${functions.length} function classification(s), ${functionStages.length} function stage node(s), ${rows.filter((row) => row.type === 'stage').length} stage head(s) and ${rows.filter((row) => row.type === 'section').length} section head(s) into Neo4j.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

