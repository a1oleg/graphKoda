import fs from 'node:fs';
import path from 'node:path';

const CONTRACT_PATH = path.resolve(process.cwd(), 'graph', 'runtime-log-contract.json');

const FALLBACK_CONTRACT = {
  version: 1,
  configId: null,
  function: {
    runtimeLoggable: true,
    runtimeLogAnchorKind: 'function',
    runtimeLoggableKinds: ['call', 'response', 'error'],
  },
  step: {
    runtimeLogAnchorKind: 'step',
    runtimeLoggableKinds: [
      'decision',
      'predicate-eval',
      'branch-hit',
      'async-event',
      'boundary-event',
      'exception-handling-event',
      'control-flow-guard-event',
      'retry-transport-fallback-event',
      'loop-control-event',
      'path-checkpoint',
      'store-affect',
    ],
    eligibility: {
      resourceEdgeRequired: true,
      stepLabelsAllowedWithoutResourceEdge: ['Branch', 'Switch', 'Case', 'Merge', 'BreakStop', 'ThrowStop'],
      runtimeReporterCallsAllowedWithoutResourceEdge: [
        'logDecision',
        'logPredicateEval',
        'logBranchHit',
        'logAsyncEvent',
        'logBoundaryEvent',
        'logExceptionHandlingEvent',
        'logControlFlowGuardEvent',
        'logRetryTransportFallbackEvent',
        'logLoopControlEvent',
        'logPathCheckpoint',
      ],
    },
  },
};

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value.map((item) => String(item || '').trim()).filter(Boolean);
  return normalized.length ? normalized : [...fallback];
}

function normalizeKinds(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value.map((item) => String(item || '').trim()).filter(Boolean);
  return normalized.length ? normalized : [...fallback];
}

export function getRuntimeLogContract() {
  let parsed = {};

  try {
    if (fs.existsSync(CONTRACT_PATH)) {
      parsed = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')) || {};
    }
  } catch {
    parsed = {};
  }

  return {
    version: Number(parsed?.version) || FALLBACK_CONTRACT.version,
    configId: parsed?.configId || FALLBACK_CONTRACT.configId,
    function: {
      runtimeLoggable: parsed?.function?.runtimeLoggable !== false,
      runtimeLogAnchorKind: parsed?.function?.runtimeLogAnchorKind || FALLBACK_CONTRACT.function.runtimeLogAnchorKind,
      runtimeLoggableKinds: normalizeKinds(parsed?.function?.runtimeLoggableKinds, FALLBACK_CONTRACT.function.runtimeLoggableKinds),
    },
    step: {
      runtimeLogAnchorKind: parsed?.step?.runtimeLogAnchorKind || FALLBACK_CONTRACT.step.runtimeLogAnchorKind,
      runtimeLoggableKinds: normalizeKinds(parsed?.step?.runtimeLoggableKinds, FALLBACK_CONTRACT.step.runtimeLoggableKinds),
      eligibility: {
        resourceEdgeRequired: parsed?.step?.eligibility?.resourceEdgeRequired !== false,
        stepLabelsAllowedWithoutResourceEdge: normalizeStringArray(
          parsed?.step?.eligibility?.stepLabelsAllowedWithoutResourceEdge,
          FALLBACK_CONTRACT.step.eligibility.stepLabelsAllowedWithoutResourceEdge,
        ),
        runtimeReporterCallsAllowedWithoutResourceEdge: normalizeStringArray(
          parsed?.step?.eligibility?.runtimeReporterCallsAllowedWithoutResourceEdge,
          FALLBACK_CONTRACT.step.eligibility.runtimeReporterCallsAllowedWithoutResourceEdge,
        ),
      },
    },
  };
}

export function getFunctionRuntimeLogContract() {
  return getRuntimeLogContract().function;
}

export function getStepRuntimeLogContract() {
  return getRuntimeLogContract().step;
}

