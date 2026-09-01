type RuntimeContext = {
  nodeid?: string;
  parentNodeid?: string;
  callId?: string;
  parentCallId?: string;
  sessionId?: string;
  metadata?: AnyLiteral;
};

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createContext(overrides: RuntimeContext = {}): RuntimeContext {
  const nodeid = overrides.nodeid || createId();
  const parentNodeid = overrides.parentNodeid;

  return {
    nodeid,
    parentNodeid,
    callId: overrides.callId || nodeid,
    parentCallId: overrides.parentCallId || parentNodeid,
    sessionId: overrides.sessionId || RuntimeReporter.sessionId,
    metadata: overrides.metadata,
  };
}

export class RuntimeReporter {
  static _stack: RuntimeContext[] = [];

  static _sessionId: string | undefined = undefined;

  static _hasExplicitSession = false;

  static _gitRevision = 'runtime-disabled';

  static _configId = 'runtime-disabled';

  static init(config: AnyLiteral = {}) {
    if (typeof config.sessionId === 'string' && config.sessionId) {
      RuntimeReporter._sessionId = config.sessionId;
      RuntimeReporter._hasExplicitSession = true;
    }

    if (typeof config.gitRevision === 'string' && config.gitRevision) {
      RuntimeReporter._gitRevision = config.gitRevision;
    }

    if (typeof config.configId === 'string' && config.configId) {
      RuntimeReporter._configId = config.configId;
    }

    return RuntimeReporter;
  }

  static get sessionId() {
    return RuntimeReporter._sessionId;
  }

  static get gitRevision() {
    return RuntimeReporter._gitRevision;
  }

  static get configId() {
    return RuntimeReporter._configId;
  }

  static get hasExplicitSession() {
    return RuntimeReporter._hasExplicitSession;
  }

  static ensureExplicitSession(sessionId?: string) {
    if (sessionId) {
      RuntimeReporter._sessionId = sessionId;
    }

    RuntimeReporter._hasExplicitSession = true;
    return RuntimeReporter._sessionId;
  }

  static stackTop() {
    return RuntimeReporter._stack.at(-1);
  }

  static pushContext(context?: RuntimeContext) {
    RuntimeReporter._stack.push(context || createContext());
  }

  static popContext() {
    return RuntimeReporter._stack.pop();
  }

  static logCall(_fnName: string, _args?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    if (typeof options.sessionId === 'string' && options.sessionId) {
      RuntimeReporter._sessionId = options.sessionId;
    }

    if (options.isUserActionRoot) {
      RuntimeReporter._hasExplicitSession = true;
    }

    const resolvedParentContext = _parentContext || RuntimeReporter.stackTop();

    return createContext({
      parentNodeid: resolvedParentContext?.nodeid,
      parentCallId: resolvedParentContext?.nodeid,
      sessionId: RuntimeReporter._sessionId,
      metadata: options,
    });
  }

  static logResponse() {}

  static logError() {}

  static logStoreAffect() {}

  static logDecision(_decisionName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logPredicateEval() {}

  static logBranchHit() {}

  static logAsyncEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      sessionId: typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : RuntimeReporter._sessionId,
      metadata: options,
    });
  }

  static logBoundaryEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logExceptionHandlingEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logControlFlowGuardEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logRetryTransportFallbackEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logLoopControlEvent(_eventName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static logPathCheckpoint(_checkpointName: string, _props?: AnyLiteral, _parentContext?: RuntimeContext, options: AnyLiteral = {}) {
    return createContext({
      parentNodeid: _parentContext?.nodeid,
      parentCallId: _parentContext?.nodeid,
      metadata: options,
    });
  }

  static flush() {
    return Promise.resolve();
  }

  static withContext<T>(context: RuntimeContext, fn: () => T) {
    RuntimeReporter.pushContext(context);

    try {
      const result = fn();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).finally(() => {
          RuntimeReporter.popContext();
        });
      }

      RuntimeReporter.popContext();
      return result;
    } catch (error) {
      RuntimeReporter.popContext();
      throw error;
    }
  }
}

export function traceCallApiRuntimeInvoke<T>(invoke: () => T) {
  return invoke();
}
