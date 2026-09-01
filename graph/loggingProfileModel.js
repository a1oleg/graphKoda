import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAPH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_LOG_CONTRACT_PATH = path.join(GRAPH_DIR, 'runtime-log-contract.json');

const FUNCTION_RUNTIME_LOGGABLE_EVENT_KINDS = new Set([
  'call',
  'call-completion',
  'response',
  'error',
]);

const STEP_RUNTIME_LOGGABLE_EVENT_KINDS = new Set([
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
]);

const DEFAULT_STEP_LABELS_ALLOWED_WITHOUT_RESOURCE_EDGE = [
  'Branch',
  'Switch',
  'Case',
  'Merge',
  'BreakStop',
  'ThrowStop',
];

const DEFAULT_RUNTIME_REPORTER_CALLS_ALLOWED_WITHOUT_RESOURCE_EDGE = [
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
];

function dedupeArray(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeMaybeArray(values) {
  if (values === null) {
    return null;
  }

  if (!Array.isArray(values)) {
    return undefined;
  }

  return dedupeArray(values);
}

function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectDeep);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortObjectDeep(value[key]);
    return acc;
  }, {});
}

function buildCanonicalConfigSeed(config) {
  return sortObjectDeep({
    runtimeProfile: config.runtimeProfile,
    runtimeRequireExplicitSession: Boolean(config.runtimeRequireExplicitSession),
    loggingEnabled: Boolean(config.loggingEnabled),
    instrumentationInclude: dedupeArray(config.instrumentationInclude),
    featureTrace: config.featureTrace ? {
      featureKey: config.featureTrace.featureKey,
      headStableIds: dedupeArray(config.featureTrace.headStableIds),
      allowedStableIds: dedupeArray(config.featureTrace.allowedStableIds),
      functionStableIdsByLocation: config.featureTrace.functionStableIdsByLocation,
      bridgeFiles: dedupeArray(config.featureTrace.bridgeFiles),
    } : undefined,
    stepLabelsAllowedWithoutResourceEdge: dedupeArray(config.stepLabelsAllowedWithoutResourceEdge),
    runtimeReporterCallsAllowedWithoutResourceEdge: dedupeArray(config.runtimeReporterCallsAllowedWithoutResourceEdge),
    deferManualScreenShareStartup: Boolean(config.deferManualScreenShareStartup),
  });
}

function buildGraphLoggingConfigId(config) {
  const digest = crypto.createHash('sha1').update(JSON.stringify(buildCanonicalConfigSeed(config))).digest('hex');
  return `glc_${digest.slice(0, 16)}`;
}

export function buildRuntimeLogContract(config) {
  return {
    version: 1,
    configId: config.configId,
    function: {
      runtimeLoggable: true,
      runtimeLogAnchorKind: 'function',
      runtimeLoggableKinds: [...FUNCTION_RUNTIME_LOGGABLE_EVENT_KINDS],
    },
    step: {
      runtimeLogAnchorKind: 'step',
      runtimeLoggableKinds: [...STEP_RUNTIME_LOGGABLE_EVENT_KINDS],
      eligibility: {
        resourceEdgeRequired: true,
        stepLabelsAllowedWithoutResourceEdge: dedupeArray(
          config.stepLabelsAllowedWithoutResourceEdge || DEFAULT_STEP_LABELS_ALLOWED_WITHOUT_RESOURCE_EDGE,
        ),
        runtimeReporterCallsAllowedWithoutResourceEdge: dedupeArray(
          config.runtimeReporterCallsAllowedWithoutResourceEdge
            || DEFAULT_RUNTIME_REPORTER_CALLS_ALLOWED_WITHOUT_RESOURCE_EDGE,
        ),
      },
    },
  };
}

export function finalizeGraphLoggingConfig(config) {
  const nextConfig = {
    ...config,
    instrumentationInclude: dedupeArray(config.instrumentationInclude),
    featureTrace: config.featureTrace ? {
      featureKey: config.featureTrace.featureKey,
      headStableIds: dedupeArray(config.featureTrace.headStableIds),
      allowedStableIds: dedupeArray(config.featureTrace.allowedStableIds),
      functionStableIdsByLocation: config.featureTrace.functionStableIdsByLocation,
      bridgeFiles: dedupeArray(config.featureTrace.bridgeFiles),
    } : undefined,
    stepLabelsAllowedWithoutResourceEdge: dedupeArray(
      config.stepLabelsAllowedWithoutResourceEdge || DEFAULT_STEP_LABELS_ALLOWED_WITHOUT_RESOURCE_EDGE,
    ),
    runtimeReporterCallsAllowedWithoutResourceEdge: dedupeArray(
      config.runtimeReporterCallsAllowedWithoutResourceEdge
        || DEFAULT_RUNTIME_REPORTER_CALLS_ALLOWED_WITHOUT_RESOURCE_EDGE,
    ),
  };

  nextConfig.configId = nextConfig.configId || buildGraphLoggingConfigId(nextConfig);
  nextConfig.runtimeLogContract = nextConfig.runtimeLogContract || buildRuntimeLogContract(nextConfig);

  return nextConfig;
}

export function writeRuntimeLogContract(config) {
  const runtimeLogContract = config.runtimeLogContract || buildRuntimeLogContract(config);
  fs.writeFileSync(RUNTIME_LOG_CONTRACT_PATH, `${JSON.stringify(runtimeLogContract, null, 2)}\n`, 'utf8');
}
