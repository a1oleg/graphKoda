import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  buildDerivedFeatureLoggingProfile,
  countFeatureInstrumentationTargets,
  resolveFeatureLoggingPayload,
} from './featureLogging.js';
import { buildFeatureDrawDiagram } from './featureDraw.js';
import { loadFeatureRuntimeNodeLogs } from './featureRuntimeLogs.js';
import { buildFeatureReproFilePayload, saveFeatureReproFile } from './featureRepro.js';
import {
  isDefaultFeatureJsonPath,
  readFeatureJsonPayload,
  resolveFeatureBabelFunctionSetPath,
  resolveFeatureEntity,
  resolveFeatureJsonPath,
  resolveFeaturePrimaryFunctionSetPath,
  resolveFeatureRequestedStableIdsPath,
} from './featureRestore.js';
import {
  ensureInfraReadiness,
  runFeatureScenario,
} from './serviceManagement.js';

function readJsonFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
}

function resolveGroupCallPrimaryPayloadPath() {
  const primaryPayloadPath = resolveFeaturePrimaryFunctionSetPath();
  if (fs.existsSync(primaryPayloadPath)) {
    return primaryPayloadPath;
  }

  const babelPayloadPath = resolveFeatureBabelFunctionSetPath();
  if (fs.existsSync(babelPayloadPath)) {
    return babelPayloadPath;
  }

  return resolveFeatureRequestedStableIdsPath();
}

function resolveFeatureLoggingPayloadPath(featureJsonPath) {
  if (isDefaultFeatureJsonPath(featureJsonPath)) {
    return resolveGroupCallPrimaryPayloadPath();
  }

  const babelConfigPath = resolveFeatureBabelFunctionSetPath(featureJsonPath);

  if (fs.existsSync(babelConfigPath)) {
    return babelConfigPath;
  }

  return resolveFeatureRequestedStableIdsPath(featureJsonPath);
}

function buildMergedGroupCallPayload(payload) {
  const fallbackPayload = readJsonFileIfExists(resolveFeatureBabelFunctionSetPath());
  if (!fallbackPayload) {
    return payload;
  }

  return {
    ...payload,
    featureTrace: payload.featureTrace && typeof payload.featureTrace === 'object'
      ? payload.featureTrace
      : fallbackPayload.featureTrace,
    instrumentationInclude: [],
    functionStableIdsByLocation: payload.functionStableIdsByLocation && Object.keys(payload.functionStableIdsByLocation).length
      ? payload.functionStableIdsByLocation
      : fallbackPayload.functionStableIdsByLocation || {},
    functionMetadataByLocation: payload.functionMetadataByLocation && Object.keys(payload.functionMetadataByLocation).length
      ? payload.functionMetadataByLocation
      : fallbackPayload.functionMetadataByLocation || {},
  };
}

function loadFeatureLoggingPayloadFromFile(feature, featureJsonPath) {
  const payloadFilePath = resolveFeatureLoggingPayloadPath(featureJsonPath);
  if (!fs.existsSync(payloadFilePath)) {
    return null;
  }

  const rawPayload = JSON.parse(fs.readFileSync(payloadFilePath, 'utf8')) || {};
  const payload = isDefaultFeatureJsonPath(featureJsonPath)
    ? buildMergedGroupCallPayload(rawPayload)
    : rawPayload;
  const payloadItems = Array.isArray(payload.functions)
    ? payload.functions
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  const backboneFunctionNodes = payloadItems
    .map((item) => {
      if (!item?.stableId) {
        return undefined;
      }

      return {
        kind: 'Fn',
        stableId: item.stableId,
        name: item.name || item.requestedName || undefined,
        repoRelativePath: item.repoRelativePath || item.requestedRepoRelativePath || undefined,
        isExternal: item.stableId.startsWith('external:'),
        layer: item.layer || undefined,
        labels: Array.isArray(item.labels) ? item.labels : [],
      };
    })
    .filter(Boolean);

  const sourceKind = Array.isArray(payload.functions)
    ? 'feature-babel-function-file'
    : 'feature-stable-id-file';

  return {
    schema: { kind: sourceKind === 'feature-babel-function-file' ? 'feature-babel-function-file-logging' : 'feature-stable-id-file-logging', version: 1 },
    generatedAt: payload.generatedAt || payload.source?.generatedAt || new Date().toISOString(),
    source: sourceKind,
    feature,
    stableIdsFilePath: payloadFilePath,
    requestedCount: payload.functionCount || payload.requestedCount || backboneFunctionNodes.length,
    backboneFunctionNodes,
    featureTrace: payload.featureTrace && typeof payload.featureTrace === 'object'
      ? payload.featureTrace
      : undefined,
    instrumentationInclude: [],
    functionStableIdsByLocation: payload.functionStableIdsByLocation || {},
    functionMetadataByLocation: payload.functionMetadataByLocation || {},
  };
}

function buildFeatureLoggingConfigBundle(loggingConfig) {
  return {
    resolvedConfig: loggingConfig,
  };
}

async function loadFeatureRuntimeNodeLogsWithRetry(feature, options, context) {
  const maxAttempts = 8;
  const retryDelayMs = 500;
  const relayObservedRetryBudgetMs = 15000;
  const backboneFunctionNodes = Array.isArray(options?.backboneFunctionNodes)
    ? options.backboneFunctionNodes.filter((node) => node?.stableId)
    : [];
  const relaySessionIds = Array.isArray(options?.scenarioSummary?.relaySessionIds)
    ? options.scenarioSummary.relaySessionIds.map((value) => String(value || '')).filter(Boolean)
    : [];
  const relayPostedForSession = Boolean(
    options?.sessionId
      && options?.scenarioSummary?.relayPostCount > 0
      && relaySessionIds.includes(options.sessionId),
  );
  const retryDeadline = relayPostedForSession
    ? Date.now() + relayObservedRetryBudgetMs
    : null;
  let runtimeNodeLogs = await loadFeatureRuntimeNodeLogs(feature, options, context);

  if (!options?.sessionId || runtimeNodeLogs.nodeCount > 0 || !backboneFunctionNodes.length) {
    return runtimeNodeLogs;
  }

  for (let attempt = 2; attempt <= maxAttempts || (retryDeadline && Date.now() < retryDeadline); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

    runtimeNodeLogs = await loadFeatureRuntimeNodeLogs(feature, options, context);
    if (runtimeNodeLogs.nodeCount > 0) {
      return runtimeNodeLogs;
    }
  }

  return runtimeNodeLogs;
}

function buildFeatureLoggingConfigFromPayload(loggingPayload, featureKey, sessionId) {
  const featureTrace = loggingPayload?.featureTrace;
  if (!featureTrace || !Array.isArray(featureTrace.headStableIds) || !Array.isArray(featureTrace.allowedStableIds)) {
    return null;
  }

  return {
    loggingEnabled: true,
    runtimeProfile: 'static-replay-minimal',
    runtimeRequireExplicitSession: true,
    sessionId,
    instrumentationInclude: [],
    featureTrace: {
      featureKey,
      headStableIds: featureTrace.headStableIds,
      allowedStableIds: featureTrace.allowedStableIds,
      functionStableIdsByLocation: loggingPayload.functionStableIdsByLocation || {},
      bridgeFiles: [
        'src/api/gramjs/worker/connector.ts',
        'src/api/gramjs/worker/worker.ts',
        'src/lib/teact/teactn.tsx',
        'src/util/browser/multitab.ts',
        'src/api/gramjs/methods/init.ts',
        'src/api/gramjs/updates/apiUpdateEmitter.ts',
        'src/api/gramjs/updates/updateManager.ts',
      ],
    },
    deferManualScreenShareStartup: false,
  };
}

export async function buildReproForResolvedGraphFeature(driver, database, feature, { outputPath } = {}) {
  if (!feature?.stableId || !(feature?.endFnStableIds || []).length) {
    throw new Error('Feature selectors must resolve before buildRepro can build a repro file.');
  }

  return saveFeatureReproFile(driver, database, feature, {
    outputPath,
  });
}

export async function makeReproForResolvedGraphFeature(driver, database, feature, options = {}) {
  return buildReproForResolvedGraphFeature(driver, database, feature, options);
}

function resolveFeatureReproLaunchSpec(featureJsonPath, requestedReproFilePath) {
  const featurePayload = readFeatureJsonPayload(featureJsonPath);
  const reproConfig = featurePayload?.repro || {};

  if (!reproConfig || typeof reproConfig !== 'object') {
    throw new Error(`Feature repro config is not available in ${resolveFeatureJsonPath(featureJsonPath)}.`);
  }

  return {
    featurePayload,
    reproConfig,
    script: reproConfig.script || 'graph:scenario:candidate-build',
    args: Array.isArray(reproConfig.args) ? reproConfig.args.map((value) => String(value)).filter(Boolean) : [],
  };
}

function resolveFeatureReproFileLaunchSpec(featureJsonPath, requestedReproFilePath) {
  const launchSpec = resolveFeatureReproLaunchSpec(featureJsonPath, requestedReproFilePath);
  const reproConfig = launchSpec.reproConfig || {};
  const reproFilePath = path.resolve(
    process.cwd(),
    requestedReproFilePath || reproConfig.filePath || '',
  );

  if (!requestedReproFilePath && !reproConfig.filePath) {
    throw new Error(`Feature repro file is not configured in ${resolveFeatureJsonPath(featureJsonPath)}.`);
  }

  if (!fs.existsSync(reproFilePath)) {
    throw new Error(`Feature repro file does not exist: ${reproFilePath}`);
  }

  const reproPayload = JSON.parse(fs.readFileSync(reproFilePath, 'utf8')) || {};

  return {
    ...launchSpec,
    reproPayload,
    reproFilePath,
    args: [...launchSpec.args],
  };
}

function buildFeatureScenarioMetadataArgs(feature) {
  const args = [];

  if (feature?.key) {
    args.push(`--feature-key=${feature.key}`);
  }
  if (feature?.name) {
    args.push(`--feature-name=${feature.name}`);
  }
  if (feature?.label) {
    args.push(`--feature-label=${feature.label}`);
  }

  return args;
}

function buildFeatureScenarioReproArgs(reproFilePath) {
  if (!reproFilePath) {
    return [];
  }

  return [`--repro-file=${reproFilePath}`];
}

function buildFeatureScenarioGatewayArgs(gatewayUrl) {
  if (!gatewayUrl || !/^https?:\/\//.test(String(gatewayUrl))) {
    return [];
  }

  return [`--gateway-url=${gatewayUrl}`];
}

function buildFeatureScenarioLoggingArgs(loggingEnabled) {
  if (loggingEnabled === undefined) {
    return [];
  }

  return [`--logging-enabled=${loggingEnabled ? 'true' : 'false'}`];
}

function resolveFeatureBabelInstrumentationConfigPath(featureJsonPath, enableLogs) {
  if (!enableLogs) {
    return undefined;
  }

  const babelConfigPath = resolveFeatureBabelFunctionSetPath(featureJsonPath);

  return fs.existsSync(babelConfigPath)
    ? babelConfigPath
    : undefined;
}

function createFeatureLoggingSessionId() {
  return crypto.randomUUID();
}

function buildFeatureReproScenarioVisibility(summary) {
  if (!summary || typeof summary !== 'object') {
    return undefined;
  }

  const sessionRecovery = summary.sessionRecovery && typeof summary.sessionRecovery === 'object'
    ? summary.sessionRecovery
    : undefined;
  const launch = summary.launch && typeof summary.launch === 'object'
    ? summary.launch
    : undefined;
  const launchStatus = launch?.launch && typeof launch.launch === 'object'
    ? launch.launch
    : undefined;

  return {
    skipLaunch: Boolean(summary.skipLaunch),
    isHeadless: Boolean(summary.isHeadlessRun),
    usedSavedStorageState: Boolean(sessionRecovery?.storageStateExistsAtLaunch),
    effectiveBaseUrl: summary.effectiveBaseUrl || summary.baseUrl || null,
    storageStatePath: summary.storageStatePath || null,
    launchRequested: Boolean(!summary.skipLaunch),
    launchReportedRunning: Boolean(launchStatus?.running),
    launchReportedPid: launchStatus?.pid || null,
  };
}

export async function resolveFeatureReproContext(driver, database, {
  feature,
  featureStableId,
  featureKey,
  featureJsonPath,
  enableLogs = false,
}) {
  const graphFeature = feature?.stableId && Array.isArray(feature?.endFnStableIds)
    ? feature
    : await resolveFeatureEntity(driver, database, {
      stableId: featureStableId,
      key: featureKey,
      jsonPath: featureJsonPath,
    });

  if (!graphFeature?.stableId) {
    throw new Error('Feature could not be resolved for runRepro.');
  }

  const graphLoggingPayload = enableLogs
    ? loadFeatureLoggingPayloadFromFile(graphFeature, featureJsonPath)
    : null;

  if (enableLogs && !(graphLoggingPayload?.backboneFunctionNodes || []).length) {
    throw new Error(`Feature logging payload file is missing or empty for ${featureJsonPath || graphFeature?.key || graphFeature?.stableId}.`);
  }

  const effectiveLoggingPayload = graphLoggingPayload
    ? await resolveFeatureLoggingPayload(driver, database, graphLoggingPayload)
    : null;
  const loggingSessionId = enableLogs ? createFeatureLoggingSessionId() : undefined;
  const fileLoggingConfig = enableLogs
    ? buildFeatureLoggingConfigFromPayload(
      graphLoggingPayload,
      graphFeature?.key,
      loggingSessionId,
    )
    : null;

  if (enableLogs && !fileLoggingConfig) {
    throw new Error(`Feature trace fields are missing inside ${graphLoggingPayload?.stableIdsFilePath || featureJsonPath || 'feature JSON'}.`);
  }

  const loggingConfigBundle = effectiveLoggingPayload
    ? fileLoggingConfig
      ? buildFeatureLoggingConfigBundle(fileLoggingConfig)
      : buildDerivedFeatureLoggingProfile(effectiveLoggingPayload, { sessionId: loggingSessionId })
    : buildNoLoggingFeatureRunProfile();

  return {
    graphFeature,
    graphLoggingPayload,
    effectiveLoggingPayload,
    loggingSessionId,
    loggingConfigBundle,
  };
}

async function runResolvedFeatureReproWithPayload(driver, database, graphFeature, launchSpec, reproPayload, {
  runtimeStore,
  gatewayUrl,
  orchestratorConfig,
  enableLogs,
  buildDrawAfterRun,
  reproContext,
  reproFilePath,
  featureJsonPath,
}) {
  const { effectiveLoggingPayload, graphLoggingPayload, loggingConfigBundle, loggingSessionId } = reproContext;
  const preflight = await ensureInfraReadiness({ driver, database, runtimeStore }, {
    loggingEnabled: loggingConfigBundle.resolvedConfig.loggingEnabled,
    config: loggingConfigBundle.resolvedConfig,
    requireNeo4j: false,
    enableBabelAutoInstrumentation: loggingConfigBundle.resolvedConfig.loggingEnabled,
    babelInstrumentationConfigPath: resolveFeatureBabelInstrumentationConfigPath(
      featureJsonPath,
      loggingConfigBundle.resolvedConfig.loggingEnabled,
    ),
  });

  if (!preflight.ready) {
    throw new Error(`Infra readiness failed before feature repro: ${preflight.missingRequirements.join(' ')}`);
  }

  const scenario = await runFeatureScenario(graphFeature, {
    script: launchSpec.script,
    args: [
      ...launchSpec.args,
      '--skip-launch=true',
      ...buildFeatureScenarioLoggingArgs(loggingConfigBundle.resolvedConfig.loggingEnabled),
      ...buildFeatureScenarioGatewayArgs(gatewayUrl),
      ...buildFeatureScenarioReproArgs(reproFilePath),
      ...buildFeatureScenarioMetadataArgs(graphFeature),
    ],
  });

  const session = preflight.dependencies.ordinarySession;
  // One-shot repro must resolve runtime logs before rendering so draw consumes
  // the same synchronous runtime payload that will be returned to the orchestrator caller.
  const runtimeNodeLogs = await loadFeatureRuntimeNodeLogsWithRetry(
    graphFeature,
    {
      sessionId: loggingSessionId,
      backboneFunctionNodes: effectiveLoggingPayload?.backboneFunctionNodes,
      scenarioSummary: scenario.summary,
    },
    { runtimeStore, driver, database },
  );

  const drawDiagram = buildDrawAfterRun
    && scenario.ok
    ? await buildFeatureDrawDiagram(driver, database, graphFeature, {
      runtimeStore,
      sessionId: loggingSessionId,
      runtimeNodeLogs,
      orchestratorConfig,
      featureJsonPath,
    })
    : null;

  return {
    feature: graphFeature,
    reproFilePath: reproFilePath || null,
    logging: {
      enabled: Boolean(loggingConfigBundle.resolvedConfig.loggingEnabled),
      sessionId: loggingSessionId || null,
      source: enableLogs ? (effectiveLoggingPayload?.source || graphLoggingPayload?.source || 'feature-file') : 'disabled',
      sourcePath: enableLogs ? (graphLoggingPayload?.stableIdsFilePath || null) : null,
      functionNodeCount: countFeatureInstrumentationTargets(effectiveLoggingPayload),
      functionNodes: (effectiveLoggingPayload?.backboneFunctionNodes || []).map((node) => ({
        stableId: node?.stableId,
        name: node?.name,
        repoRelativePath: node?.repoRelativePath,
        isExternal: Boolean(node?.isExternal),
      })),
    },
    session,
    backboneFunctionCount: countFeatureInstrumentationTargets(effectiveLoggingPayload),
    runtimeNodeLogs,
    script: scenario.script,
    args: scenario.args || [],
    scenarioOk: Boolean(scenario.ok),
    scenarioExitCode: scenario.exitCode ?? null,
    scenarioSignal: scenario.signal || null,
    scenarioFailureKind: scenario.failure?.kind || null,
    scenarioFailureMessage: scenario.failure?.message || null,
    scenarioVisibility: buildFeatureReproScenarioVisibility(scenario.summary),
    drawDiagram,
    summary: scenario.summary,
    stdout: scenario.stdout,
    stderr: scenario.stderr,
  };
}

function buildNoLoggingFeatureRunProfile() {
  const resolvedConfig = {
    runtimeProfile: 'static-replay-minimal',
    runtimeRequireExplicitSession: false,
    loggingEnabled: false,
    instrumentationInclude: [],
    deferManualScreenShareStartup: false,
  };

  const env = {
    GRAPH_LOGGING_ENABLED: '0',
    GRAPH_LOGGING_CONFIG_JSON: JSON.stringify(resolvedConfig),
    RUNTIME_PROFILE: resolvedConfig.runtimeProfile,
  };

  return {
    resolvedConfig,
    env,
    graph: {
      seedCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      graphJsonPath: null,
      runtimeBridgeIncluded: false,
      runtimeBridgeNodeCount: 0,
    },
    seedFunctions: [],
  };
}

export async function runResolvedFeatureRepro(driver, database, {
  feature,
  featureStableId,
  featureKey,
  featureJsonPath,
  source = 'FILE',
  buildDrawAfterRun = true,
  runtimeStore,
  orchestratorConfig,
  enableLogs = false,
  reproFilePath,
  gatewayUrl,
}) {
  const reproContext = await resolveFeatureReproContext(driver, database, {
    feature,
    featureStableId,
    featureKey,
    featureJsonPath,
    enableLogs,
  });
  const { graphFeature } = reproContext;

  if (source === 'FILE') {
    const launchSpec = resolveFeatureReproFileLaunchSpec(featureJsonPath, reproFilePath);
    return runResolvedFeatureReproWithPayload(driver, database, graphFeature, launchSpec, launchSpec.reproPayload, {
      runtimeStore,
      gatewayUrl,
      orchestratorConfig,
      enableLogs,
      buildDrawAfterRun,
      reproContext,
      reproFilePath: launchSpec.reproFilePath,
      featureJsonPath,
    });
  }

  const launchSpec = resolveFeatureReproLaunchSpec(featureJsonPath);
  const reproPayload = await buildFeatureReproFilePayload(driver, database, graphFeature);

  return runResolvedFeatureReproWithPayload(driver, database, graphFeature, launchSpec, reproPayload, {
    runtimeStore,
    gatewayUrl,
    orchestratorConfig,
    enableLogs,
    buildDrawAfterRun,
    reproContext,
    reproFilePath: null,
    featureJsonPath,
  });
}

