type RuntimeWorkerChannelTransportOptions = {
  isEnabled: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
};

type RuntimeEventChannelSender = (events: unknown[]) => boolean | Promise<boolean>;

const FAILURE_COOLDOWN_MS = 250;
const MAX_PENDING_EVENTS = 2_000;

let channelSender: RuntimeEventChannelSender | undefined;
let pendingEvents: unknown[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushInFlight = Promise.resolve();

function trimPendingEvents() {
  if (pendingEvents.length > MAX_PENDING_EVENTS) {
    pendingEvents.splice(0, pendingEvents.length - MAX_PENDING_EVENTS);
  }
}

function scheduleFlush(flushPendingEvents: () => void, delayMs: number) {
  if (flushTimer) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushPendingEvents();
  }, delayMs);
}

export function bindRuntimeWorkerChannel(sender: RuntimeEventChannelSender) {
  channelSender = sender;

  if (pendingEvents.length) {
    scheduleFlush(() => {
      void flushInFlight;
    }, 0);
  }
}

export function createRuntimeWorkerChannelTransport({
  isEnabled,
  batchSize = 100,
  flushIntervalMs = 100,
}: RuntimeWorkerChannelTransportOptions) {
  async function flushPendingEvents() {
    if (!pendingEvents.length) {
      return;
    }

    const sender = channelSender;
    if (!sender) {
      scheduleFlush(() => {
        void flushPendingEvents();
      }, flushIntervalMs);
      return;
    }

    const events = pendingEvents.splice(0, batchSize);
    let wasAccepted = false;

    flushInFlight = flushInFlight
      .catch(() => undefined)
      .then(async () => {
        wasAccepted = await sender(events);
      });

    await flushInFlight;

    if (!wasAccepted) {
      pendingEvents.unshift(...events);
      trimPendingEvents();
      scheduleFlush(() => {
        void flushPendingEvents();
      }, FAILURE_COOLDOWN_MS);
      return;
    }

    if (pendingEvents.length) {
      void flushPendingEvents();
    }
  }

  const transport = isEnabled
    ? async (events: unknown[]) => {
      if (!events.length) {
        return;
      }

      pendingEvents.push(...events);
      trimPendingEvents();

      if (pendingEvents.length >= batchSize) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }

        void flushPendingEvents();
        return;
      }

      scheduleFlush(() => {
        void flushPendingEvents();
      }, flushIntervalMs);
    }
    : undefined;

  return {
    transport,
  };
}
