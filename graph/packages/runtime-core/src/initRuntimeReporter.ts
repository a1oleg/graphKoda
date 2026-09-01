import { RuntimeReporter } from './index.js';
import { createWorkerRuntimeRelayTransport } from './createWorkerRuntimeRelayTransport';

declare const GRAPH_LOGGING_ENABLED_RAW: string | undefined;
declare const GRAPH_LOGGING_CONFIG_JSON_RAW: string | undefined;
declare const RUNTIME_RELAY_URL_RAW: string | undefined;
declare const GRAPH_TRANSPORT_BATCH_SIZE_RAW: string | undefined;
declare const GRAPH_TRANSPORT_FLUSH_INTERVAL_MS_RAW: string | undefined;
declare const GRAPH_TRANSPORT_PENDING_LIMIT_RAW: string | undefined;
declare const GRAPH_EVENT_BUFFER_LIMIT_RAW: string | undefined;

const RAW_GRAPH_LOGGING_ENABLED = GRAPH_LOGGING_ENABLED_RAW;
const RAW_GRAPH_LOGGING_CONFIG_JSON = GRAPH_LOGGING_CONFIG_JSON_RAW;
const RAW_RUNTIME_RELAY_URL = RUNTIME_RELAY_URL_RAW;
const RAW_GRAPH_TRANSPORT_BATCH_SIZE = GRAPH_TRANSPORT_BATCH_SIZE_RAW;
const RAW_GRAPH_TRANSPORT_FLUSH_INTERVAL_MS = GRAPH_TRANSPORT_FLUSH_INTERVAL_MS_RAW;
const RAW_GRAPH_TRANSPORT_PENDING_LIMIT = GRAPH_TRANSPORT_PENDING_LIMIT_RAW;
const RAW_GRAPH_EVENT_BUFFER_LIMIT = GRAPH_EVENT_BUFFER_LIMIT_RAW;

function resolveEnvString(value: string | undefined) {
  return value?.trim() || undefined;
}

function resolvePositiveIntegerEnv(rawValue: string | undefined, defaultValue: number) {
  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function resolveRuntimeLoggingConfig() {
  const rawValue = RAW_GRAPH_LOGGING_CONFIG_JSON;

  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRuntimeReporterConfig(rawConfig: Record<string, unknown>) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return {};
  }

  const requireExplicitSession = rawConfig.requireExplicitSession ?? rawConfig.runtimeRequireExplicitSession;

  return {
    ...rawConfig,
    requireExplicitSession: requireExplicitSession !== undefined
      ? Boolean(requireExplicitSession)
      : undefined,
  };
}

const isEnabled = RAW_GRAPH_LOGGING_ENABLED !== '0';
const gitRevision = typeof APP_REVISION !== 'undefined' ? APP_REVISION : undefined;
const relayUrl = resolveEnvString(RAW_RUNTIME_RELAY_URL);
const isRelayConfigured = Boolean(relayUrl);
const RELAY_BATCH_SIZE = resolvePositiveIntegerEnv(RAW_GRAPH_TRANSPORT_BATCH_SIZE, 100);
const RELAY_FLUSH_INTERVAL_MS = resolvePositiveIntegerEnv(RAW_GRAPH_TRANSPORT_FLUSH_INTERVAL_MS, 100);
const TRANSPORT_PENDING_LIMIT = resolvePositiveIntegerEnv(RAW_GRAPH_TRANSPORT_PENDING_LIMIT, 1000);
const EVENT_BUFFER_LIMIT = resolvePositiveIntegerEnv(RAW_GRAPH_EVENT_BUFFER_LIMIT, 1000);

function buildRuntimeReporterConfig() {
  const runtimeLoggingConfig = normalizeRuntimeReporterConfig(resolveRuntimeLoggingConfig());
  const { transport } = createWorkerRuntimeRelayTransport({
    isEnabled: isEnabled && isRelayConfigured,
    relayUrl: relayUrl || '',
    batchSize: RELAY_BATCH_SIZE,
    flushIntervalMs: RELAY_FLUSH_INTERVAL_MS,
  });

  return {
    ...runtimeLoggingConfig,
    enabled: isEnabled && isRelayConfigured,
    gitRevision,
    retainEvents: false,
    eventBufferLimit: EVENT_BUFFER_LIMIT,
    transportPendingLimit: TRANSPORT_PENDING_LIMIT,
    transport,
  };
}

RuntimeReporter.init({
  ...buildRuntimeReporterConfig(),
  enabled: isEnabled && isRelayConfigured,
});

export function activateDeferredRuntimeSession() {
  RuntimeReporter.init(buildRuntimeReporterConfig());
}

if (isEnabled && isRelayConfigured) {
  RuntimeReporter.logBoundaryEvent(
    'BootstrapProbe',
    {
      bootstrapProbe: 'initRuntimeReporter',
    },
    RuntimeReporter.stackTop(),
    {
      boundaryKind: 'bootstrap-probe',
      boundaryDirection: 'receive',
      boundaryTransport: 'renderer-init',
      boundaryMessageType: 'bootstrap-probe',
      bootstrapPhase: 'runtime-reporter-init',
      auto: true,
    },
  );
}
