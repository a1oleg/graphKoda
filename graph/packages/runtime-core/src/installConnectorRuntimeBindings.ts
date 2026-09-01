import { bindRuntimeWorkerChannel } from './createRuntimeWorkerChannelTransport';
import { startBuffering, flushBuffer } from './runtimeSession';

type RuntimeConnectorBindings = {
  bindRuntimeWorkerChannel: typeof bindRuntimeWorkerChannel;
  startBuffering: typeof startBuffering;
  flushBuffer: typeof flushBuffer;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __telegraphRuntimeConnectorBindings?: RuntimeConnectorBindings;
};

runtimeGlobal.__telegraphRuntimeConnectorBindings = {
  bindRuntimeWorkerChannel,
  startBuffering,
  flushBuffer,
};