import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveAllFunctionStages } from './deriveFunctionStages.mjs';

const workspaceRoot = process.cwd();
const DEFAULT_OUTPUT_PATH = path.join(workspaceRoot, 'graph', 'functions.json');
const DEFAULT_FUNCTION_SEEDS = [
  {
    stableId: 'screens/REPL.tsx:3142:31:3533:3',
    name: 'onSubmit',
    repoRelativePath: 'screens/REPL.tsx',
    file: 'screens/REPL.tsx',
  },
];

function parseStableId(stableId) {
  const parts = String(stableId || '').split(':');
  if (parts.length < 5) return { file: '', startLine: null, startColumn: null, endLine: null, endColumn: null };
  const endColumn = Number(parts.at(-1));
  const endLine = Number(parts.at(-2));
  const startColumn = Number(parts.at(-3));
  const startLine = Number(parts.at(-4));
  return {
    file: parts.slice(0, -4).join(':'),
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}

function classifyFunction({ lineCount, stepCount, stageCount }) {
  const reasons = [];
  if (lineCount >= 120) reasons.push(`lineCount>=120 (${lineCount})`);
  if (stepCount >= 60) reasons.push(`stepCount>=60 (${stepCount})`);
  if (stageCount > 1) reasons.push(`stageCount>1 (${stageCount})`);
  return {
    sizeClass: reasons.length ? 'large' : 'small',
    renderer: reasons.length ? 'linear' : 'bpmn',
    reasons,
  };
}

function normalizeSection(section) {
  return {
    id: section.key,
    key: section.key,
    stableId: section.stableId || section.key,
    label: section.label,
    kind: section.kind,
    lines: section.lines,
    startLine: section.startLine,
    endLine: section.endLine,
    stepCount: section.stepCount || 0,
    headStepStableId: section.headStepStableId || null,
    tailStepStableId: section.tailStepStableId || null,
    targetCalls: section.targetCalls || [],
    resourceTouches: section.resourceTouches || [],
  };
}

function normalizeStage(stage) {
  return {
    id: stage.key,
    key: stage.key,
    stableId: stage.stableId || stage.key,
    label: stage.label,
    kind: stage.kind,
    lines: stage.lines,
    startLine: stage.startLine,
    endLine: stage.endLine,
    stepCount: stage.stepCount || 0,
    headStepStableId: stage.headStepStableId || null,
    tailStepStableId: stage.tailStepStableId || null,
    targetCalls: stage.targetCalls || [],
    resourceTouches: stage.resourceTouches || [],
    sections: (stage.sections || []).map(normalizeSection),
    renderer: 'bpmn',
    icon: 'zap',
  };
}

function assignDisplayOrder(functions) {
  functions.forEach((fn, functionIndex) => {
    const order = functionIndex + 1;
    fn.order = order;
    fn.displayIndex = `#${order}`;
    (fn.stages || []).forEach((stage, stageIndex) => {
      stage.order = stageIndex + 1;
      stage.displayIndex = `#${order}.${stageIndex + 1}`;
    });
  });
}

function compareFunctionOrder(left, right) {
  return (left.file || '').localeCompare(right.file || '')
    || (left.startLine || 0) - (right.startLine || 0)
    || (left.label || '').localeCompare(right.label || '');
}

export function buildGraphFunctionsPayload(payload) {
  const functions = [];
  for (const stageSet of payload.stageSets || []) {
    const parsed = parseStableId(stageSet.function.stableId);
    const lineCount = parsed.startLine && parsed.endLine ? parsed.endLine - parsed.startLine + 1 : 0;
    const stages = (stageSet.stages || []).map(normalizeStage);
    const stageCount = stages.length;
    const stepCount = stages.reduce((sum, stage) => sum + (stage.stepCount || 0), 0);
    const classification = classifyFunction({ lineCount, stepCount, stageCount });
    functions.push({
      id: stageSet.function.stableId,
      stableId: stageSet.function.stableId,
      label: stageSet.function.name && stageSet.function.name !== '<anonymous>'
        ? stageSet.function.name
        : stageSet.phase.label,
      name: stageSet.function.name,
      file: stageSet.function.repoRelativePath || parsed.file,
      lines: parsed.startLine && parsed.endLine ? `${parsed.startLine}-${parsed.endLine}` : '',
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      lineCount,
      phaseKey: stageSet.phase.key,
      phaseLabel: stageSet.phase.label,
      stageCount,
      stepCount,
      sizeClass: classification.sizeClass,
      renderer: classification.renderer,
      classificationReasons: classification.reasons,
      icon: classification.sizeClass === 'large' ? 'folder' : 'zap',
      stages,
    });
  }
  functions.sort(compareFunctionOrder);
  assignDisplayOrder(functions);
  return {
    schema: {
      kind: 'graph-function-menu',
      version: 3,
      largeThresholds: {
        lineCount: 120,
        stepCount: 60,
        stageCount: 1,
      },
    },
    generatedAt: new Date().toISOString(),
    functions,
    orderSource: 'function-stage-catalog',
    errors: payload.errors || [],
  };
}

export async function deriveGraphFunctions(options = {}) {
  const normalizedOptions = { ...options };
  if (!normalizedOptions.fnStableId && !normalizedOptions.functionsPath) {
    normalizedOptions.functionSpecs = DEFAULT_FUNCTION_SEEDS;
  }
  const payload = await deriveAllFunctionStages(normalizedOptions);
  return buildGraphFunctionsPayload(payload);
}

export function writeGraphFunctions(payload, outputPath = DEFAULT_OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? path.resolve(process.cwd(), process.argv[outputIndex + 1]) : DEFAULT_OUTPUT_PATH;
  const functionsPathIndex = process.argv.indexOf('--functions-path');
  const functionsPath = functionsPathIndex >= 0 ? path.resolve(process.cwd(), process.argv[functionsPathIndex + 1]) : undefined;
  const fnStableIdIndex = process.argv.indexOf('--fn-stable-id');
  const fnStableId = fnStableIdIndex >= 0 ? process.argv[fnStableIdIndex + 1] : undefined;
  const payload = await deriveGraphFunctions({ functionsPath, fnStableId });
  if (payload.errors.length) {
    throw new Error(payload.errors.join('\n'));
  }
  writeGraphFunctions(payload, outputPath);
  console.log(`Wrote ${payload.functions.length} function(s) to ${path.relative(workspaceRoot, outputPath)}`);
}

