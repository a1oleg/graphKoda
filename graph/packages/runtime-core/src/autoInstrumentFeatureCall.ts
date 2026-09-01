import { RuntimeReporter } from './index.js';

type AutoInstrumentedFunctionCallOptions = {
  fnName: string;
  stableId?: string;
  filePath: string;
  fnStartLine: number;
  fnStartColumn: number;
  fnEndLine: number;
  fnEndColumn: number;
};

type FeatureTraceConfig = {
  featureKey?: string;
  allowedStableIds?: string[];
  bridgeFiles?: string[];
};

type OriginRuntimeTrace = {
  featureTraceToken?: string;
  featureTraceKey?: string;
  featureTraceRootStableId?: string;
};

function normalizeRepoRelativePath(filePath: string) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  const srcIndex = normalizedPath.lastIndexOf('/src/');

  if (srcIndex >= 0) {
    return normalizedPath.slice(srcIndex + 1);
  }

  return normalizedPath.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
}

function buildFeatureTraceToken(featureKey: string, configId: string | undefined) {
  return `${configId || 'runtime'}:${featureKey}`;
}

function appendAutoInstrumentationProbe(entry: Record<string, unknown>) {
  const probeKey = '__telegraphAutoInstrumentationProbe';
  const probeHost = globalThis as typeof globalThis & {
    [probeKey]?: {
      entries?: Record<string, unknown>[];
    };
  };

  const currentProbe = probeHost[probeKey] || {};
  const entries = Array.isArray(currentProbe.entries) ? currentProbe.entries : [];
  entries.push(entry);
  if (entries.length > 50) {
    entries.splice(0, entries.length - 50);
  }

  probeHost[probeKey] = {
    ...currentProbe,
    entries,
  };
}

function extractOriginRuntimeTrace(value: unknown, depth = 0, seen = new Set<unknown>()): OriginRuntimeTrace | undefined {
  if (depth > 5 || value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedTrace = extractOriginRuntimeTrace(item, depth + 1, seen);
      if (nestedTrace) {
        return nestedTrace;
      }
    }

    return undefined;
  }

  const maybeTrace = (value as Record<string, unknown>).__runtimeTrace;
  if (maybeTrace && typeof maybeTrace === 'object') {
    return maybeTrace as OriginRuntimeTrace;
  }

  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    const nestedTrace = extractOriginRuntimeTrace(nestedValue, depth + 1, seen);
    if (nestedTrace) {
      return nestedTrace;
    }
  }

  return undefined;
}

function buildFeatureTraceState(
  options: AutoInstrumentedFunctionCallOptions,
  parentContext: AnyLiteral | undefined,
  args: unknown[] | undefined,
) {
  const reporter = RuntimeReporter.ensureInstance() as AnyLiteral;
  const featureTrace = reporter?.config?.featureTrace as FeatureTraceConfig | undefined;

  if (!featureTrace?.featureKey) {
    return {
      shouldEmit: true,
      originRuntimeTrace: extractOriginRuntimeTrace(args),
    };
  }

  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const stableId = options.stableId;
  const allowedStableIds = new Set(featureTrace.allowedStableIds || []);
  const bridgeFiles = new Set(featureTrace.bridgeFiles || []);
  const originRuntimeTrace = extractOriginRuntimeTrace(args);
  const featureTraceToken = buildFeatureTraceToken(featureTrace.featureKey, reporter?.config?.configId || RuntimeReporter.configId);
  const hasActiveFeatureTrace = parentContext?.metadata?.featureTraceToken === featureTraceToken
    || parentContext?.metadata?.featureTraceKey === featureTrace.featureKey
    || originRuntimeTrace?.featureTraceToken === featureTraceToken
    || originRuntimeTrace?.featureTraceKey === featureTrace.featureKey;
  const isFeatureNode = Boolean(stableId && allowedStableIds.has(stableId));
  const isBridgeFile = bridgeFiles.has(repoRelativePath);
  const shouldEmit = isFeatureNode || hasActiveFeatureTrace;

  return {
    shouldEmit,
    originRuntimeTrace,
    featureTraceToken: shouldEmit ? featureTraceToken : undefined,
    featureTraceKey: shouldEmit ? featureTrace.featureKey : undefined,
    featureTraceRootStableId: shouldEmit
      ? (parentContext?.metadata?.featureTraceRootStableId || originRuntimeTrace?.featureTraceRootStableId || stableId)
      : undefined,
    featureTraceBridgeFile: shouldEmit && isBridgeFile ? true : undefined,
  };
}

export function logAutoInstrumentedFunctionCall(
  options: AutoInstrumentedFunctionCallOptions,
  parentContext = RuntimeReporter.stackTop(),
  args?: unknown[],
) {
  const reporter = RuntimeReporter.ensureInstance() as AnyLiteral;
  const featureTraceState = buildFeatureTraceState(options, parentContext, args);

  appendAutoInstrumentationProbe({
    atIso: new Date().toISOString(),
    fnName: options.fnName,
    stableId: options.stableId || null,
    shouldEmit: featureTraceState.shouldEmit,
    sessionId: RuntimeReporter.sessionId || null,
    configEnabled: Boolean(reporter?.config?.enabled),
    hasTransport: Boolean(reporter?.config?.transport),
    hasFeatureTrace: Boolean(reporter?.config?.featureTrace?.featureKey),
    featureTraceKey: reporter?.config?.featureTrace?.featureKey || null,
    configId: reporter?.config?.configId || RuntimeReporter.configId || null,
  });

  if (!featureTraceState.shouldEmit) {
    return undefined;
  }

  return RuntimeReporter.logCall(options.fnName, undefined, parentContext, {
    disableAutoStableIdDerivation: true,
    stableId: options.stableId,
    fnStableId: options.stableId,
    callerFile: options.filePath,
    fnStartLine: options.fnStartLine,
    fnStartColumn: options.fnStartColumn,
    fnEndLine: options.fnEndLine,
    fnEndColumn: options.fnEndColumn,
    originRuntimeTrace: featureTraceState.originRuntimeTrace,
    featureTraceToken: featureTraceState.featureTraceToken,
    featureTraceKey: featureTraceState.featureTraceKey,
    featureTraceRootStableId: featureTraceState.featureTraceRootStableId,
    featureTraceBridgeFile: featureTraceState.featureTraceBridgeFile,
  });
}

export function withAutoInstrumentedFunctionContext<T>(context: AnyLiteral | undefined, fn: () => T) {
  if (!context) {
    return fn();
  }

  return RuntimeReporter.withContext(context, fn);
}