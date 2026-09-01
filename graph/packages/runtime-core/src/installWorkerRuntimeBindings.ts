import {
  forwardWorkerRuntimeEvents,
  initWorkerRuntimeReporter,
} from './workerRuntimeReporter';

type RuntimeWorkerBindings = {
  forwardWorkerRuntimeEvents: typeof forwardWorkerRuntimeEvents;
  initWorkerRuntimeReporter: typeof initWorkerRuntimeReporter;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __telegraphRuntimeWorkerBindings?: RuntimeWorkerBindings;
};

runtimeGlobal.__telegraphRuntimeWorkerBindings = {
  forwardWorkerRuntimeEvents,
  initWorkerRuntimeReporter,
};