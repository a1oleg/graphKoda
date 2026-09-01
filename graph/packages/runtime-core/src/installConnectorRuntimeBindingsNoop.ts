type RuntimeConnectorBindings = {
  bindRuntimeWorkerChannel: (sender: (events: unknown[]) => boolean | Promise<boolean>) => void;
  startBuffering: () => void;
  flushBuffer: () => void;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __telegraphRuntimeConnectorBindings?: RuntimeConnectorBindings;
};

runtimeGlobal.__telegraphRuntimeConnectorBindings = {
  bindRuntimeWorkerChannel: () => {},
  startBuffering: () => {},
  flushBuffer: () => {},
};