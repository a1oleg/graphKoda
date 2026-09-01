import { RuntimeReporter } from './index.js';
import { createWorkerRuntimeRelayTransport } from './createWorkerRuntimeRelayTransport';

declare const GRAPH_LOGGING_ENABLED_RAW: string | undefined;
declare const GRAPH_LOGGING_CONFIG_JSON_RAW: string | undefined;
declare const RUNTIME_RELAY_URL_RAW: string | undefined;
declare const GRAPH_TRANSPORT_PENDING_LIMIT_RAW: string | undefined;
declare const GRAPH_EVENT_BUFFER_LIMIT_RAW: string | undefined;

const RAW_GRAPH_LOGGING_ENABLED = GRAPH_LOGGING_ENABLED_RAW;
const RAW_GRAPH_LOGGING_CONFIG_JSON = GRAPH_LOGGING_CONFIG_JSON_RAW;
const RAW_RUNTIME_RELAY_URL = RUNTIME_RELAY_URL_RAW;
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

const isGraphLoggingEnabled = RAW_GRAPH_LOGGING_ENABLED !== '0';
const relayUrl = resolveEnvString(RAW_RUNTIME_RELAY_URL);
const isRelayConfigured = Boolean(relayUrl);
const TRANSPORT_PENDING_LIMIT = resolvePositiveIntegerEnv(RAW_GRAPH_TRANSPORT_PENDING_LIMIT, 1000);
const EVENT_BUFFER_LIMIT = resolvePositiveIntegerEnv(RAW_GRAPH_EVENT_BUFFER_LIMIT, 1000);
const { transport } = createWorkerRuntimeRelayTransport({
  isEnabled: isGraphLoggingEnabled && isRelayConfigured,
  relayUrl: relayUrl || '',
});

function buildWorkerRuntimeReporterConfig() {
  const runtimeLoggingConfig = normalizeRuntimeReporterConfig(resolveRuntimeLoggingConfig());
  return {
    ...runtimeLoggingConfig,
    enabled: isGraphLoggingEnabled && isRelayConfigured,
    gitRevision: typeof APP_REVISION !== 'undefined' ? APP_REVISION : undefined,
    retainEvents: false,
    eventBufferLimit: EVENT_BUFFER_LIMIT,
    transportPendingLimit: TRANSPORT_PENDING_LIMIT,
    transport,
  };
}

export function initWorkerRuntimeReporter() {
  RuntimeReporter.init(buildWorkerRuntimeReporterConfig());
}

export async function forwardWorkerRuntimeEvents(events: Parameters<NonNullable<typeof transport>>[0]) {
  if (transport) {
    await transport(events);
  }
}

initWorkerRuntimeReporter();
