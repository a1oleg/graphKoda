type RuntimeWorkerBindings = {
  forwardWorkerRuntimeEvents: (events: unknown[]) => Promise<void>;
  initWorkerRuntimeReporter: () => void;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __telegraphRuntimeWorkerBindings?: RuntimeWorkerBindings;
};

runtimeGlobal.__telegraphRuntimeWorkerBindings = {
  forwardWorkerRuntimeEvents: async () => {},
  initWorkerRuntimeReporter: () => {},
};