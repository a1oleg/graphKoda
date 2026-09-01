import path from 'node:path';

export const DEVOPS_SERVICE_LOG_DIR = path.resolve(process.cwd(), 'tmp', 'devops-service-logs');
export const INFRA_SERVICE_LOG_DIR = path.resolve(process.cwd(), 'tmp', 'infra-service-logs');
export const REVERSE_SERVICE_LOG_DIR = path.resolve(process.cwd(), 'tmp', 'reverse-service-logs');
export const DEFAULT_ORCHESTRATOR_PORT = Number(process.env.ORCHESTRATOR_PORT || process.env.GRAPH_GATEWAY_PORT || 8791);

function parseBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function buildOrchestratorConfig(overrides = {}) {
  const isStateless = overrides.isStateless ?? parseBooleanEnv('ORCHESTRATOR_STATELESS', false);
  return {
    isStateless,
    allowStatefulMutations: overrides.allowStatefulMutations ?? parseBooleanEnv('ORCHESTRATOR_ALLOW_STATEFUL_MUTATIONS', !isStateless),
    persistProcessState: overrides.persistProcessState ?? parseBooleanEnv('ORCHESTRATOR_PERSIST_PROCESS_STATE', !isStateless),
    useLatestSessionIfMissingByDefault: overrides.useLatestSessionIfMissingByDefault ?? parseBooleanEnv('ORCHESTRATOR_USE_LATEST_SESSION_IF_MISSING', false),
    allowStaticDrawFallback: overrides.allowStaticDrawFallback ?? parseBooleanEnv('ORCHESTRATOR_ALLOW_STATIC_DRAW_FALLBACK', false),
  };
}
