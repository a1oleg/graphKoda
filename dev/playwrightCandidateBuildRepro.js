import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '@playwright/test';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8791/';
const DEFAULT_LOGGING_ENABLED = false;
const DEFAULT_OUTPUT_DIR = path.resolve('tmp', 'candidate-build-repro');
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_MS = 1_500;
const LOGGING_ENABLED_DEFAULT_TIMEOUT_MS = 120_000;
const LOGGING_ENABLED_DEFAULT_INTERACTION_TIMEOUT_MS = 30_000;
const LOGGING_ENABLED_DEFAULT_SETTLE_MS = 3_000;
const DEFAULT_FLOW = 'chat-probe';
const FREEZE_HEARTBEAT_WARNING_MS = 1_500;
const STAGE_WATCHDOG_INTERVAL_MS = 1_500;
const STAGE_WATCHDOG_HEARTBEAT_TIMEOUT_MS = 1_200;
const LOGGING_ENABLED_STAGE_WATCHDOG_HEARTBEAT_TIMEOUT_MS = 4_000;
const LOGGING_ENABLED_HEARTBEAT_FAILURE_THRESHOLD = 3;
const CRITICAL_ERROR_BURST_WINDOW_MS = 2_500;
const CRITICAL_ERROR_BURST_THRESHOLD = 4;
const OOM_LIKE_ERROR_PATTERN = /out of memory|\boom\b|heap limit|allocation failed|renderer process|page crash|unresponsive/i;
const INVALID_SAVED_SESSION_PATTERN = /session_revoked|auth_key_unregistered|401:\s*session_revoked|401:\s*auth_key_unregistered/i;
const SERVICE_WORKER_CONSOLE_ERROR_PATTERN = /^\[SW\]/i;
const LANGUAGE_DETECTOR_CONSOLE_ERROR_PATTERN = /failed to initialize language detector/i;
const UNEXPECTED_MUTATION_CONSOLE_ERROR_PATTERN = /unexpected mutation detected/i;
const EXPECTED_SEARCH_INPUT_CARET_MUTATION_PATTERN = /unexpected mutation detected: `style` on input#telegram-search-input\.form-control(?: style="caret-color: transparent !important;")?/i;
const EXPECTED_TOP_PEERS_FLOOD_WAIT_PATTERN = /floodwaiterror: a wait of \d+ seconds is required \(caused by contacts\.gettoppeers\)/i;
const WEBSOCKET_TRANSPORT_CONSOLE_ERROR_PATTERN = /websocket connection timeout|^websocket error\b|^socket .* closed\.|connection closed while (sending|receiving) data|error:\s*not connected/i;
const AUTH_SCREEN_MARKERS = [
  'Log in to Telegram by QR Code',
  'Open Telegram on your phone',
  'Your Phone Number',
  'Confirm phone number',
  'Scan From Mobile App',
  'Next',
];

const DEFAULT_HEADED_SCREEN_SHARE_CONFIRM_TIMEOUT_MS = 20_000;
const DEFAULT_HEADED_SCREEN_SHARE_POST_CLICK_PAUSE_MS = 7_000;
const LOGGING_ENABLED_HEADED_SCREEN_SHARE_CONFIRM_TIMEOUT_MS = 45_000;
const LOGGING_ENABLED_HEADED_SCREEN_SHARE_POST_CLICK_PAUSE_MS = 15_000;
const DEFAULT_SCREEN_SHARE_AUTO_SELECT_SOURCE = 'Entire screen';
const DEFAULT_BROWSER_JS_HEAP_MB = 8_192;

const REPRO_FILE_FLOW_MATCHERS = [
  {
    flow: 'group-call',
    matches: /join-group-call|joingroupcall|voice chat|group.?call/i,
  },
  {
    flow: 'group-call-screen-share',
    matches: /screen|share|presentation/i,
  },
];

function parseArgs(argv) {
  return argv.reduce((result, arg) => {
    if (!arg.startsWith('--')) {
      return result;
    }

    const [rawKey, ...rawValueParts] = arg.slice(2).split('=');
    result[rawKey] = rawValueParts.length ? rawValueParts.join('=') : 'true';
    return result;
  }, {});
}

function toBooleanFlag(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function sanitizeStem(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-');
}

function serializeError(error) {
  if (!error) {
    return undefined;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function truncateText(value, maxLength = 500) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function extractSessionIdsFromPayload(rows) {
  const sessionIds = new Set();

  if (!Array.isArray(rows)) {
    return [];
  }

  rows.forEach((row) => {
    const sessionId = row?.nodeProps?.sessionId || row?.meta?.sessionId || row?.entities?.[0]?.props?.sessionId;
    if (sessionId) {
      sessionIds.add(sessionId);
    }
  });

  return [...sessionIds];
}

function resolveReproFilePath(candidatePath) {
  if (!candidatePath) {
    return undefined;
  }

  return path.resolve(candidatePath);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function buildBrowserLaunchArgs({
  browserJsHeapMb,
  effectiveBaseUrl,
  flow,
  autoSelectSource,
}) {
  const launchArgs = [];

  if (browserJsHeapMb) {
    launchArgs.push(`--js-flags=--max-old-space-size=${browserJsHeapMb}`);
  }

  if (flow === 'group-call-screen-share') {
    launchArgs.push(...buildScreenShareLaunchArgs({
      effectiveBaseUrl,
      autoSelectSource,
    }));
  }

  return launchArgs;
}

function buildScreenShareLaunchArgs({ effectiveBaseUrl, autoSelectSource }) {
  const launchArgs = [
    '--enable-usermedia-screen-capturing',
    '--use-fake-ui-for-media-stream',
  ];

  if (effectiveBaseUrl?.startsWith('http://')) {
    launchArgs.push('--allow-http-screen-capture');
  }

  if (autoSelectSource) {
    launchArgs.push(`--auto-select-desktop-capture-source=${autoSelectSource}`);
  }

  return launchArgs;
}

async function flushRuntimeReporter(page) {
  await page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return;
    }

    chunkGlobal.push([[Symbol('candidate-build-repro-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

async function inspectRuntimeReporter(page) {
  return page.evaluate(() => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return {
        available: false,
        reason: 'webpack-runtime-unavailable',
      };
    }

    chunkGlobal.push([[Symbol('candidate-build-repro-runtime-inspect')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return {
        available: false,
        reason: 'runtime-core-module-unavailable',
      };
    }

    const runtimeCore = requireFn(runtimeCoreId);
    const reporterClass = runtimeCore?.RuntimeReporter;
    const instance = reporterClass?.instance;

    return {
      available: true,
      processDefined: typeof process !== 'undefined',
      rawLoggingEnabledEnv: typeof process !== 'undefined' ? process.env?.GRAPH_LOGGING_ENABLED ?? null : null,
      rawRelayUrlEnv: typeof process !== 'undefined' ? process.env?.RUNTIME_RELAY_URL ?? null : null,
      rawLoggingConfigEnvPresent: typeof process !== 'undefined'
        ? Boolean(process.env?.GRAPH_LOGGING_CONFIG_JSON)
        : false,
      hasClass: Boolean(reporterClass),
      hasInstance: Boolean(instance),
      sessionId: reporterClass?.sessionId || null,
      hasExplicitSession: Boolean(reporterClass?.hasExplicitSession),
      configEnabled: Boolean(instance?.config?.enabled),
      hasTransport: Boolean(instance?.config?.transport),
      retainEvents: Boolean(instance?.config?.retainEvents),
      requireExplicitSession: Boolean(instance?.config?.requireExplicitSession),
      eventCount: Array.isArray(instance?.events) ? instance.events.length : null,
      pendingTransportEventCount: Array.isArray(instance?.pendingTransportEvents)
        ? instance.pendingTransportEvents.length
        : null,
      pendingTransportCount: instance?.pendingTransports?.size ?? null,
      transportBatchSize: instance?.config?.transportBatchSize ?? null,
      transportFlushIntervalMs: instance?.config?.transportFlushIntervalMs ?? null,
      transportPendingLimit: instance?.config?.transportPendingLimit ?? null,
      autoInstrumentationProbe: window.__telegraphAutoInstrumentationProbe || null,
    };
  });
}

async function readReproPayload(reproFilePath) {
  if (!reproFilePath) {
    return undefined;
  }

  const raw = await readFile(reproFilePath, 'utf8');
  return JSON.parse(raw);
}

function readFeatureMetadataFromArgs(args) {
  const key = args['feature-key'] || process.env.CANDIDATE_REPRO_FEATURE_KEY;
  const name = args['feature-name'] || process.env.CANDIDATE_REPRO_FEATURE_NAME;
  const label = args['feature-label'] || process.env.CANDIDATE_REPRO_FEATURE_LABEL;

  if (!key && !name && !label) {
    return undefined;
  }

  return {
    key: key || undefined,
    name: name || undefined,
    label: label || undefined,
  };
}

function resolveFlowFromReproPayload(reproPayload) {
  const haystack = [
    reproPayload?.feature?.key,
    reproPayload?.feature?.name,
    reproPayload?.feature?.label,
    reproPayload?.source,
  ].filter(Boolean).join(' ');

  return REPRO_FILE_FLOW_MATCHERS.find((entry) => entry.matches.test(haystack))?.flow;
}

async function pathExists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function callOrchestrator(gatewayUrl, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(pathname, gatewayUrl), {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Orchestrator request failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function withTimeout(stage, task, timeoutMs) {
  let timeoutId;

  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${stage} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function flushPayload(payload, jsonPath) {
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
}

function createExternallyRejectedPromise() {
  let reject;
  const promise = new Promise((_, currentReject) => {
    reject = currentReject;
  });

  return { promise, reject };
}

function buildHealthSignals() {
  const fatalSignal = createExternallyRejectedPromise();

  return {
    pageErrors: [],
    consoleErrors: [],
    expectedConsoleErrors: [],
    consoleWarnings: [],
    savedSessionRejections: [],
    requestFailures: [],
    pageCrashed: false,
    crashAtIso: undefined,
    closeAtIso: undefined,
    fatalSignal,
    fatalSignalReason: undefined,
  };
}

function markFatalHealthSignal(signals, details) {
  if (signals.fatalSignalReason) {
    return;
  }

  signals.fatalSignalReason = {
    atIso: new Date().toISOString(),
    ...details,
  };
  signals.fatalSignal.reject(new Error(details.reason));
}

function hasCriticalErrorBurst(entries, selector) {
  if (entries.length < CRITICAL_ERROR_BURST_THRESHOLD) {
    return undefined;
  }

  const recentEntries = entries.slice(-CRITICAL_ERROR_BURST_THRESHOLD);
  const firstEntry = recentEntries[0];
  const lastEntry = recentEntries.at(-1);
  const firstTs = new Date(firstEntry.atIso).getTime();
  const lastTs = new Date(lastEntry.atIso).getTime();

  if ((lastTs - firstTs) > CRITICAL_ERROR_BURST_WINDOW_MS) {
    return undefined;
  }

  return selector(recentEntries);
}

function isOomLikeText(text) {
  return OOM_LIKE_ERROR_PATTERN.test(text || '');
}

function isInvalidSavedSessionText(text) {
  return INVALID_SAVED_SESSION_PATTERN.test(text || '');
}

function isExpectedSessionRecoveryConsoleError(text, signals) {
  if (isInvalidSavedSessionText(text)) {
    return true;
  }

  return /error:\s*not connected/i.test(text || '') && Boolean((signals.savedSessionRejections || []).length);
}

function isExpectedSearchInputCaretMutation(text) {
  return EXPECTED_SEARCH_INPUT_CARET_MUTATION_PATTERN.test(text || '');
}

function isExpectedTopPeersFloodWait(text) {
  return EXPECTED_TOP_PEERS_FLOOD_WAIT_PATTERN.test(text || '');
}

function collectConsoleErrorBuckets(entries) {
  const buckets = {
    serviceWorker: [],
    languageDetector: [],
    unexpectedMutation: [],
    websocketTransport: [],
    unclassified: [],
  };

  entries.forEach((entry) => {
    const text = entry.text || '';

    if (SERVICE_WORKER_CONSOLE_ERROR_PATTERN.test(text)) {
      buckets.serviceWorker.push(entry);
      return;
    }

    if (LANGUAGE_DETECTOR_CONSOLE_ERROR_PATTERN.test(text)) {
      buckets.languageDetector.push(entry);
      return;
    }

    if (UNEXPECTED_MUTATION_CONSOLE_ERROR_PATTERN.test(text)) {
      buckets.unexpectedMutation.push(entry);
      return;
    }

    if (WEBSOCKET_TRANSPORT_CONSOLE_ERROR_PATTERN.test(text)) {
      buckets.websocketTransport.push(entry);
      return;
    }

    buckets.unclassified.push(entry);
  });

  return buckets;
}

function attachPageHealthSignals(page, signals) {
  page.on('pageerror', (error) => {
    const entry = {
      atIso: new Date().toISOString(),
      error: serializeError(error),
    };
    signals.pageErrors.push(entry);

    const burst = hasCriticalErrorBurst(signals.pageErrors, (recentEntries) => {
      const matchedMessages = recentEntries
        .map((currentEntry) => currentEntry.error?.message)
        .filter((message) => isOomLikeText(message));

      return matchedMessages.length === recentEntries.length ? matchedMessages.join(' | ') : undefined;
    });
    if (burst) {
      markFatalHealthSignal(signals, {
        code: 'page-error-burst',
        reason: `Critical page error burst detected: ${burst}`,
      });
    }
  });

  page.on('console', (message) => {
    const entry = {
      atIso: new Date().toISOString(),
      type: message.type(),
      text: truncateText(message.text(), 2_000),
      location: message.location(),
    };

    if (message.type() === 'error') {
      if (isInvalidSavedSessionText(entry.text)) {
        signals.expectedConsoleErrors.push(entry);
        signals.savedSessionRejections.push(entry);
        return;
      }

      if (isExpectedSessionRecoveryConsoleError(entry.text, signals)) {
        signals.expectedConsoleErrors.push(entry);
        return;
      }

      if (isExpectedSearchInputCaretMutation(entry.text)) {
        signals.expectedSearchInputCaretMutations ||= [];
        signals.expectedSearchInputCaretMutations.push(entry);
        return;
      }

      if (isExpectedTopPeersFloodWait(entry.text)) {
        signals.expectedTopPeersFloodWaitErrors ||= [];
        signals.expectedTopPeersFloodWaitErrors.push(entry);
        return;
      }

      signals.consoleErrors.push(entry);

      if (isOomLikeText(entry.text)) {
        markFatalHealthSignal(signals, {
          code: 'oom-like-console-signal',
          reason: `OOM-like console error detected: ${entry.text}`,
        });
        return;
      }

      const burst = hasCriticalErrorBurst(signals.consoleErrors, (recentEntries) => {
        const matchedMessages = recentEntries
          .map((currentEntry) => currentEntry.text)
          .filter((text) => isOomLikeText(text));

        return matchedMessages.length === recentEntries.length ? matchedMessages.join(' | ') : undefined;
      });
      if (burst) {
        markFatalHealthSignal(signals, {
          code: 'console-error-burst',
          reason: `Critical console error burst detected: ${burst}`,
        });
      }

      return;
    }

    if (message.type() === 'warning') {
      signals.consoleWarnings.push(entry);
    }
  });

  page.on('requestfailed', (request) => {
    signals.requestFailures.push({
      atIso: new Date().toISOString(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failureText: request.failure()?.errorText,
    });
  });

  page.on('crash', () => {
    signals.pageCrashed = true;
    signals.crashAtIso = new Date().toISOString();
    markFatalHealthSignal(signals, {
      code: 'page-crash',
      reason: 'The browser page crashed during the repro flow.',
    });
  });

  page.on('close', () => {
    signals.closeAtIso = new Date().toISOString();
  });
}

async function collectHealthSnapshot(page, label, interactionTimeoutMs) {
  const heartbeatStartedAt = Date.now();
  const heartbeat = await withTimeout(
    `${label}-heartbeat`,
    () => page.evaluate(() => ({
      href: window.location.href,
      now: performance.now(),
      timeOrigin: performance.timeOrigin,
    })),
    interactionTimeoutMs,
  );
  const heartbeatDurationMs = Date.now() - heartbeatStartedAt;

  const dom = await withTimeout(
    `${label}-dom-health`,
    () => page.evaluate(() => {
      const spinnerSelectors = [
        '.Spinner',
        '.Loading',
        '.qr-loading',
        '[class*="Spinner"]',
        '[class*="spinner"]',
        '[class*="Loading"]',
        '[class*="loading"]',
      ];
      const spinnerNodes = spinnerSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
      const uniqueSpinnerNodes = [...new Set(spinnerNodes)].filter((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();

        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || '1') !== 0
          && rect.width >= 0
          && rect.height >= 0;
      });

      const loadingTexts = uniqueSpinnerNodes
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
        .map((text) => text.slice(0, 120))
        .slice(0, 10);

      const activeModals = [...document.querySelectorAll('[role="dialog"], .modal, .Modal')].length;

      return {
        title: document.title,
        readyState: document.readyState,
        rootChildCount: document.querySelector('#root')?.childElementCount ?? -1,
        bodyTextSample: document.body?.innerText?.slice(0, 300) || '',
        visibleSpinnerCount: uniqueSpinnerNodes.length,
        visibleLoadingTexts: loadingTexts,
        activeModalCount: activeModals,
        activeElementTagName: document.activeElement?.tagName,
        activeElementAriaLabel: document.activeElement?.getAttribute?.('aria-label') || undefined,
        isDocumentHidden: document.hidden,
        memory: globalThis.performance && 'memory' in globalThis.performance
          ? {
              jsHeapSizeLimit: globalThis.performance.memory.jsHeapSizeLimit,
              totalJSHeapSize: globalThis.performance.memory.totalJSHeapSize,
              usedJSHeapSize: globalThis.performance.memory.usedJSHeapSize,
            }
          : undefined,
      };
    }),
    interactionTimeoutMs,
  );

  return {
    label,
    capturedAtIso: new Date().toISOString(),
    heartbeatDurationMs,
    heartbeat,
    dom,
  };
}

async function pushHealthSnapshot(payload, page, label, interactionTimeoutMs) {
  try {
    const snapshot = await collectHealthSnapshot(page, label, interactionTimeoutMs);
    payload.healthSnapshots.push(snapshot);
    return snapshot;
  } catch (error) {
    let stallDiagnostics;

    if (page && !page.isClosed() && /timed out/i.test(String(error?.message || ''))) {
      const earlyFailureScreenshotPath = payload.screenshotPath.replace(/\.png$/i, `-${sanitizeStem(label)}-early.png`);

      stallDiagnostics = {
        label,
        capturedAtIso: new Date().toISOString(),
        url: page.url(),
        title: await page.title().catch(() => undefined),
        bodyTextSample: await page.locator('body').textContent({ timeout: 500 })
          .then((text) => truncateText((text || '').trim(), 500))
          .catch(() => undefined),
        rootVisible: await page.locator('#root').isVisible({ timeout: 500 }).catch(() => undefined),
        earlyFailureScreenshotPath,
      };

      await page.screenshot({ path: earlyFailureScreenshotPath, fullPage: true }).catch(() => undefined);

      payload.watchdogFailureDiagnostics ||= [];
      payload.watchdogFailureDiagnostics.push(stallDiagnostics);
    }

    const snapshot = {
      label,
      capturedAtIso: new Date().toISOString(),
      error: serializeError(error),
      stallDiagnostics,
    };
    payload.healthSnapshots.push(snapshot);
    return snapshot;
  }
}

async function closePageTree(page, payload, reason) {
  if (!page || payload.didClosePageTreeEarly) {
    return;
  }

  payload.didClosePageTreeEarly = true;
  payload.earlyCloseReason = reason;
  payload.earlyCloseAtIso = new Date().toISOString();

  const context = page.context?.();
  const browser = context?.browser?.();

  await page.close().catch(() => undefined);
  if (context) {
    await context.close().catch(() => undefined);
  }
  if (browser) {
    await browser.close().catch(() => undefined);
  }
}

async function runStageWatchdog(page, payload, options) {
  const {
    stage,
    timeoutMs,
    intervalMs = STAGE_WATCHDOG_INTERVAL_MS,
    heartbeatTimeoutMs = payload.loggingEnabled
      ? LOGGING_ENABLED_STAGE_WATCHDOG_HEARTBEAT_TIMEOUT_MS
      : STAGE_WATCHDOG_HEARTBEAT_TIMEOUT_MS,
    heartbeatFailureThreshold = payload.loggingEnabled
      ? LOGGING_ENABLED_HEARTBEAT_FAILURE_THRESHOLD
      : 1,
    spinnerFailAfterChecks,
  } = options;

  const startedAt = Date.now();
  let isStopped = false;
  let consecutiveHeartbeatFailures = 0;
  let stableSpinnerChecks = 0;
  let lastSpinnerSignature;

  const loop = async () => {
    while (!isStopped) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(intervalMs, timeoutMs - elapsedMs));
      });

      if (isStopped) {
        return;
      }

      const snapshot = await pushHealthSnapshot(payload, page, `${stage}-watchdog-${Date.now() - startedAt}ms`, heartbeatTimeoutMs);

      if (snapshot.error) {
        consecutiveHeartbeatFailures += 1;

        if (consecutiveHeartbeatFailures >= heartbeatFailureThreshold) {
          const watchdogError = new Error(`${stage} watchdog heartbeat failed early: ${snapshot.error.message}`);
          payload.primaryWatchdogError = serializeError(watchdogError);
          throw watchdogError;
        }

        continue;
      }

      consecutiveHeartbeatFailures = 0;

      if (payload.healthSignals?.pageCrashed) {
        throw new Error(`${stage} detected a browser page crash.`);
      }

      if (spinnerFailAfterChecks && snapshot.dom?.visibleSpinnerCount > 0) {
        const spinnerSignature = JSON.stringify({
          href: snapshot.heartbeat?.href,
          visibleSpinnerCount: snapshot.dom.visibleSpinnerCount,
          visibleLoadingTexts: snapshot.dom.visibleLoadingTexts,
        });

        if (spinnerSignature === lastSpinnerSignature) {
          stableSpinnerChecks += 1;
        } else {
          stableSpinnerChecks = 1;
          lastSpinnerSignature = spinnerSignature;
        }

        if (stableSpinnerChecks >= spinnerFailAfterChecks) {
          throw new Error(
            `${stage} detected a persistent spinner for ${stableSpinnerChecks} consecutive watchdog checks.`,
          );
        }
      } else {
        stableSpinnerChecks = 0;
        lastSpinnerSignature = undefined;
      }
    }
  };

  return {
    promise: loop(),
    stop: () => {
      isStopped = true;
    },
  };
}

async function runWithStageWatchdog(page, payload, options, task) {
  const watchdog = await runStageWatchdog(page, payload, options);

  try {
    return await Promise.race([
      task(),
      watchdog.promise,
      payload.healthSignals.fatalSignal.promise,
    ]);
  } catch (error) {
    const primaryWatchdogError = payload.primaryWatchdogError;
    const shouldPreferPrimaryWatchdogError = primaryWatchdogError
      && /Target page, context or browser has been closed|page has been closed/i.test(String(error?.message || ''));

    await closePageTree(page, payload, `diagnosis-clear:${options.stage}`);
    if (shouldPreferPrimaryWatchdogError) {
      const restoredError = new Error(primaryWatchdogError.message);
      restoredError.name = primaryWatchdogError.name || restoredError.name;
      restoredError.stack = primaryWatchdogError.stack || restoredError.stack;
      throw restoredError;
    }

    throw error;
  } finally {
    watchdog.stop();
    await watchdog.promise.catch(() => undefined);
  }
}

function classifyHealth(payload) {
  const failures = [];
  const warnings = [];
  const runtimeSignals = payload.healthSignals || {};
  const snapshots = Array.isArray(payload.healthSnapshots) ? payload.healthSnapshots : [];
  const successfulSnapshots = snapshots.filter((snapshot) => !snapshot.error);
  const consoleErrorBuckets = collectConsoleErrorBuckets(runtimeSignals.consoleErrors || []);

  if (runtimeSignals.pageCrashed) {
    failures.push({
      code: 'page-crash',
      reason: 'The browser page crashed during the repro flow. This is the strongest available browser-level signal for an OOM-like failure.',
      atIso: runtimeSignals.crashAtIso,
    });
  }

  if (runtimeSignals.fatalSignalReason) {
    failures.push(runtimeSignals.fatalSignalReason);
  }

  const invalidSavedSessionError = (runtimeSignals.savedSessionRejections || [])[0];
  if (invalidSavedSessionError && !payload.sessionRecovery?.recovered) {
    warnings.push({
      code: 'saved-session-rejected',
      reason: invalidSavedSessionError.text,
      atIso: invalidSavedSessionError.atIso,
    });
  }

  if (payload.sessionRecovery?.recovered) {
    warnings.push({
      code: 'session-recovered-during-repro',
      reason: `The repro fell through to the Telegram authorization screen, re-saved storageState to ${payload.sessionRecovery.savedStorageStatePath}, and continued.`,
      atIso: payload.sessionRecovery.recoveredAtIso,
    });
  }

  if (payload.error?.message?.toLowerCase().includes('timed out')) {
    failures.push({
      code: 'ui-freeze-timeout',
      reason: payload.error.message,
    });
  }

  successfulSnapshots.forEach((snapshot) => {
    if (snapshot.heartbeatDurationMs >= FREEZE_HEARTBEAT_WARNING_MS) {
      warnings.push({
        code: 'slow-heartbeat',
        reason: `Snapshot ${snapshot.label} required ${snapshot.heartbeatDurationMs}ms for a basic page heartbeat.`,
      });
    }
  });

  const recentSnapshots = successfulSnapshots.slice(-2);
  if (recentSnapshots.length === 2) {
    const [previousSnapshot, latestSnapshot] = recentSnapshots;
    if (
      previousSnapshot.dom?.visibleSpinnerCount > 0
      && latestSnapshot.dom?.visibleSpinnerCount > 0
      && previousSnapshot.dom?.visibleSpinnerCount === latestSnapshot.dom?.visibleSpinnerCount
      && previousSnapshot.heartbeat?.href === latestSnapshot.heartbeat?.href
    ) {
      warnings.push({
        code: 'persistent-spinner',
        reason: `Visible spinner count stayed at ${latestSnapshot.dom.visibleSpinnerCount} between ${previousSnapshot.label} and ${latestSnapshot.label} without page-location progress.`,
      });
    }
  }

  if (consoleErrorBuckets.serviceWorker.length) {
    warnings.push({
      code: 'service-worker-errors',
      reason: `Observed ${consoleErrorBuckets.serviceWorker.length} service-worker console error message(s).`,
    });
  }

  if (consoleErrorBuckets.languageDetector.length) {
    warnings.push({
      code: 'language-detector-errors',
      reason: `Observed ${consoleErrorBuckets.languageDetector.length} language-detector console error message(s).`,
    });
  }

  if (consoleErrorBuckets.unexpectedMutation.length) {
    warnings.push({
      code: 'unexpected-mutation-errors',
      reason: `Observed ${consoleErrorBuckets.unexpectedMutation.length} unexpected-mutation console error message(s).`,
    });
  }

  if (consoleErrorBuckets.websocketTransport.length) {
    warnings.push({
      code: 'websocket-transport-errors',
      reason: `Observed ${consoleErrorBuckets.websocketTransport.length} websocket/transport console error message(s).`,
    });
  }

  if (consoleErrorBuckets.unclassified.length) {
    warnings.push({
      code: 'console-errors',
      reason: `Observed ${consoleErrorBuckets.unclassified.length} unclassified console error message(s).`,
    });
  }

  if ((runtimeSignals.expectedSearchInputCaretMutations || []).length) {
    warnings.push({
      code: 'expected-search-input-caret-mutations',
      reason: `Observed ${runtimeSignals.expectedSearchInputCaretMutations.length} expected stricterdom search-input caret mutation message(s).`,
    });
  }

  if ((runtimeSignals.expectedTopPeersFloodWaitErrors || []).length) {
    warnings.push({
      code: 'expected-top-peers-floodwait-errors',
      reason: `Observed ${runtimeSignals.expectedTopPeersFloodWaitErrors.length} expected contacts.GetTopPeers flood-wait console error message(s).`,
    });
  }

  if ((runtimeSignals.expectedConsoleErrors || []).length && !payload.sessionRecovery?.recovered) {
    warnings.push({
      code: 'expected-session-recovery-console-errors',
      reason: `Observed ${runtimeSignals.expectedConsoleErrors.length} expected console error message(s) caused by stale-session recovery.`,
    });
  }

  if ((runtimeSignals.pageErrors || []).length) {
    warnings.push({
      code: 'page-errors',
      reason: `Observed ${runtimeSignals.pageErrors.length} unhandled page error(s).`,
    });
  }

  const oomLikeConsoleError = (runtimeSignals.consoleErrors || []).find((entry) => isOomLikeText(entry.text));
  if (oomLikeConsoleError) {
    failures.push({
      code: 'oom-like-console-signal',
      reason: oomLikeConsoleError.text,
      atIso: oomLikeConsoleError.atIso,
    });
  }

  return {
    failures,
    warnings,
    summary: {
      pageCrashed: Boolean(runtimeSignals.pageCrashed),
      pageErrorCount: (runtimeSignals.pageErrors || []).length,
      consoleErrorCount: (runtimeSignals.consoleErrors || []).length,
      serviceWorkerConsoleErrorCount: consoleErrorBuckets.serviceWorker.length,
      languageDetectorConsoleErrorCount: consoleErrorBuckets.languageDetector.length,
      unexpectedMutationConsoleErrorCount: consoleErrorBuckets.unexpectedMutation.length,
      websocketTransportConsoleErrorCount: consoleErrorBuckets.websocketTransport.length,
      unclassifiedConsoleErrorCount: consoleErrorBuckets.unclassified.length,
      expectedConsoleErrorCount: (runtimeSignals.expectedConsoleErrors || []).length,
      expectedSearchInputCaretMutationCount: (runtimeSignals.expectedSearchInputCaretMutations || []).length,
      expectedTopPeersFloodWaitCount: (runtimeSignals.expectedTopPeersFloodWaitErrors || []).length,
      requestFailureCount: (runtimeSignals.requestFailures || []).length,
      snapshotCount: snapshots.length,
      lastSnapshotLabel: snapshots.at(-1)?.label,
    },
  };
}

async function waitForAppReady(page, payload, timeoutMs, settleMs) {
  await runWithStageWatchdog(
    page,
    payload,
    {
      stage: 'wait-runtime-hooks',
      timeoutMs,
    },
    () => page.waitForFunction(
      () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
      { timeout: timeoutMs },
    ),
  );

  await waitForAuthorizationOrRecovery(page, payload, timeoutMs);

  await runWithStageWatchdog(
    page,
    payload,
    {
      stage: 'wait-chat-list',
      timeoutMs,
      spinnerFailAfterChecks: 3,
    },
    () => page.waitForSelector('#LeftColumn .chat-list .Chat .ListItem-button', { timeout: timeoutMs }),
  );

  await page.waitForTimeout(settleMs);
}

async function persistRecoveredStorageState(page, storageStatePath) {
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  await page.context().storageState({ path: storageStatePath });
}

async function readAuthorizationSnapshot(page) {
  return page.evaluate((authScreenMarkers) => {
    const global = window.getGlobal?.();
    const bodyText = document.body?.innerText || '';

    return {
      href: window.location.href,
      authState: global?.auth?.state,
      connectionState: global?.connectionState,
      currentUserId: global?.currentUserId,
      hasAuthScreenMarker: authScreenMarkers.some((marker) => bodyText.includes(marker)),
      bodyTextSample: bodyText.slice(0, 500),
    };
  }, AUTH_SCREEN_MARKERS);
}

function isAuthorizedSnapshot(snapshot) {
  return Boolean(
    snapshot
    && snapshot.connectionState === 'connectionStateReady'
    && snapshot.authState === 'authorizationStateReady'
    && snapshot.currentUserId,
  );
}

function isAuthorizationScreenSnapshot(snapshot) {
  return Boolean(
    snapshot
    && (
      snapshot.authState === 'authorizationStateWaitQrCode'
      || snapshot.authState === 'authorizationStateWaitPhoneNumber'
      || snapshot.hasAuthScreenMarker
    ),
  );
}

async function waitForAuthorizationOrRecovery(page, payload, timeoutMs) {
  const startedAt = Date.now();
  let hasEnteredRecovery = false;

  while ((Date.now() - startedAt) < timeoutMs) {
    const snapshot = await runWithStageWatchdog(
      page,
      payload,
      {
        stage: 'wait-auth-ready',
        timeoutMs: Math.min(timeoutMs, 10_000),
      },
      () => readAuthorizationSnapshot(page),
    );

    payload.lastAuthorizationSnapshot = snapshot;

    if (isAuthorizedSnapshot(snapshot)) {
      await persistRecoveredStorageState(page, payload.storageStatePath);

      if (hasEnteredRecovery) {
        payload.sessionRecovery = {
          ...(payload.sessionRecovery || {}),
          recovered: true,
          recoveredAtIso: new Date().toISOString(),
          savedStorageStatePath: payload.storageStatePath,
        };
      }

      return snapshot;
    }

    if (isAuthorizationScreenSnapshot(snapshot)) {
      if (payload.isHeadlessRun) {
        throw new Error('The saved session fell through to the Telegram authorization screen while the repro is running headless. Re-run headed so login can be completed and persisted automatically.');
      }

      if (!hasEnteredRecovery) {
        hasEnteredRecovery = true;
        payload.sessionRecovery = {
          ...(payload.sessionRecovery || {}),
          triggered: true,
          startedAtIso: new Date().toISOString(),
          reason: 'Saved session fell through to the Telegram authorization screen during repro startup.',
          storageStatePath: payload.storageStatePath,
        };
      }

      await page.waitForTimeout(2_000);
      continue;
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`Timed out waiting for authorization at ${page.url() || 'unknown URL'}`);
}

async function collectUiState(page) {
  return page.evaluate(() => {
    const global = window.getGlobal?.();
    const chatRows = [...document.querySelectorAll('#LeftColumn .chat-list .Chat')];
    const selectedRows = chatRows.filter((row) => row.classList.contains('selected'));
    const chatButtons = [...document.querySelectorAll('#LeftColumn .chat-list .Chat .ListItem-button')];
    const searchInputs = [...document.querySelectorAll('#LeftColumn input')];
    const scrollContainer = document.querySelector('#LeftColumn .chat-list');

    return {
      href: window.location.href,
      readyState: document.readyState,
      authState: global?.auth?.state,
      connectionState: global?.connectionState,
      currentUserId: global?.currentUserId,
      chatRowCount: chatRows.length,
      selectedChatCount: selectedRows.length,
      chatButtonCount: chatButtons.length,
      searchInputCount: searchInputs.length,
      scrollTop: scrollContainer?.scrollTop ?? null,
      bodyClassName: document.body?.className || '',
      activeElementTagName: document.activeElement?.tagName,
    };
  });
}

async function collectGroupCallState(page) {
  return page.evaluate(() => {
    const global = window.getGlobal?.();
    const activeGroupCallId = global?.groupCalls?.activeGroupCallId;
    const activeGroupCall = activeGroupCallId ? global?.groupCalls?.byId?.[activeGroupCallId] : undefined;
    const meParticipant = activeGroupCallId && global?.currentUserId
      ? activeGroupCall?.participants?.[global.currentUserId]
      : undefined;
    const currentChatId = window.location.hash.replace(/^#/, '').split('/')[0] || undefined;
    const actionButtons = [...document.querySelectorAll('[aria-label]')]
      .map((element) => ({
        ariaLabel: element.getAttribute('aria-label'),
        role: element.getAttribute('role'),
      }))
      .filter(({ ariaLabel }) => Boolean(ariaLabel))
      .slice(0, 20);

    return {
      href: window.location.href,
      currentChatId,
      activeGroupCallId,
      activeGroupCallChatId: activeGroupCall?.chatId,
      activeGroupCallParticipantsCount: activeGroupCall?.participantsCount,
      activeGroupCallConnectionState: activeGroupCall?.connectionState,
      activeGroupCallHasVideo: Boolean(activeGroupCall?.participants),
      meParticipantExists: Boolean(meParticipant),
      meHasPresentationStream: Boolean(meParticipant?.hasPresentationStream),
      labeledActions: actionButtons,
    };
  });
}

function resolveScenarioHooks(reproPayload, flow) {
  const runner = reproPayload?.runner;

  if (!runner || typeof runner !== 'object') {
    return {};
  }

  const hooks = runner[flow];
  return hooks && typeof hooks === 'object' ? hooks : {};
}

function matchesScenarioCondition(state, condition) {
  if (!condition || typeof condition !== 'object') {
    return true;
  }

  const field = condition.field;
  if (!field) {
    return true;
  }

  const actualValue = state?.[field];

  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    const expectedValue = condition.equals;
    return typeof expectedValue === 'boolean'
      ? Boolean(actualValue) === expectedValue
      : actualValue === expectedValue;
  }

  return Boolean(actualValue);
}

async function waitForScenarioCondition(page, timeoutMs, condition) {
  if (!condition || typeof condition !== 'object' || !condition.field) {
    return;
  }

  await page.waitForFunction((currentCondition) => {
    const global = window.getGlobal?.();
    const activeGroupCallId = global?.groupCalls?.activeGroupCallId;
    const activeGroupCall = activeGroupCallId ? global?.groupCalls?.byId?.[activeGroupCallId] : undefined;
    const meParticipant = activeGroupCallId && global?.currentUserId
      ? activeGroupCall?.participants?.[global.currentUserId]
      : undefined;
    const state = {
      href: window.location.href,
      activeGroupCallId,
      activeGroupCallChatId: activeGroupCall?.chatId,
      activeGroupCallConnectionState: activeGroupCall?.connectionState,
      meHasPresentationStream: Boolean(meParticipant?.hasPresentationStream),
    };
    const actualValue = state[currentCondition.field];

    if (Object.prototype.hasOwnProperty.call(currentCondition, 'equals')) {
      return typeof currentCondition.equals === 'boolean'
        ? Boolean(actualValue) === currentCondition.equals
        : actualValue === currentCondition.equals;
    }

    return Boolean(actualValue);
  }, condition, { timeout: timeoutMs });
}

function classifyPostScreenShareBlocker({ diagnosisSnapshot, externalChooserExpected, screenShareAwait, pageCrashed }) {
  if (pageCrashed) {
    return 'page-crashed';
  }

  const diagnosisErrorMessage = diagnosisSnapshot?.error?.message || '';
  if (/timed out/i.test(diagnosisErrorMessage)) {
    if (externalChooserExpected && screenShareAwait?.detected !== 'me-has-presentation-stream') {
      return 'native-chooser-or-browser-capture-ui';
    }

    return 'page-main-thread-or-renderer-blocked';
  }

  if (diagnosisSnapshot?.dom?.activeModalCount > 0) {
    return 'app-modal-or-overlay';
  }

  if (screenShareAwait?.detected === 'me-has-presentation-stream') {
    return 'screen-share-started-but-page-responsive';
  }

  return 'undetermined';
}

async function diagnosePostScreenShareState(page, payload, interactionTimeoutMs, {
  externalChooserExpected,
  screenShareAwait,
} = {}) {
  const diagnosisTimeoutMs = Math.max(500, Math.min(interactionTimeoutMs, STAGE_WATCHDOG_HEARTBEAT_TIMEOUT_MS));
  const diagnosisSnapshot = await pushHealthSnapshot(payload, page, 'post-screen-share-diagnosis', diagnosisTimeoutMs);

  return {
    diagnosisTimeoutMs,
    externalChooserExpected: Boolean(externalChooserExpected),
    screenShareAwait: screenShareAwait || null,
    pageCrashed: Boolean(payload.healthSignals?.pageCrashed),
    diagnosisSnapshot,
    likelyBlocker: classifyPostScreenShareBlocker({
      diagnosisSnapshot,
      externalChooserExpected,
      screenShareAwait,
      pageCrashed: payload.healthSignals?.pageCrashed,
    }),
  };
}

async function runConfiguredScenarioActions(page, timeoutMs, settleMs, stageName, actionConfigs) {
  const configuredActions = Array.isArray(actionConfigs) ? actionConfigs : [];
  const beforeState = await collectGroupCallState(page);
  const executions = [];

  for (const actionConfig of configuredActions) {
    const currentState = await collectGroupCallState(page);
    const shouldRun = matchesScenarioCondition(currentState, actionConfig?.when);

    if (!shouldRun) {
      executions.push({
        name: actionConfig?.name || '<unknown>',
        skipped: true,
        because: 'condition-not-met',
        state: currentState,
      });
      continue;
    }

    const dispatch = await withTimeout(
      `${stageName}-${actionConfig.name || 'action'}-dispatch`,
      () => page.evaluate(({ name, payload }) => {
        const actions = window.getActions?.();
        const action = name ? actions?.[name] : undefined;

        if (typeof action !== 'function') {
          return {
            available: false,
            dispatched: false,
          };
        }

        const result = action(payload);
        return {
          available: true,
          dispatched: true,
          returnedType: typeof result,
          isPromiseLike: Boolean(result && typeof result.then === 'function'),
        };
      }, {
        name: actionConfig?.name,
        payload: actionConfig?.payload,
      }),
      timeoutMs,
    );

    if (dispatch.dispatched && actionConfig?.waitFor) {
      await waitForScenarioCondition(page, timeoutMs, actionConfig.waitFor);
      await page.waitForTimeout(settleMs);
    }

    executions.push({
      name: actionConfig?.name || '<unknown>',
      dispatch,
      afterActionState: await collectGroupCallState(page),
    });
  }

  return {
    configuredActionCount: configuredActions.length,
    beforeState,
    executions,
    afterState: await collectGroupCallState(page),
  };
}

async function waitForScreenShareStarted(page, timeoutMs) {
  return withTimeout(
    'wait-screen-share-started',
    () => page.waitForFunction(() => {
      const global = window.getGlobal?.();
      const activeGroupCallId = global?.groupCalls?.activeGroupCallId;
      const currentUserId = global?.currentUserId;
      const activeGroupCall = activeGroupCallId ? global?.groupCalls?.byId?.[activeGroupCallId] : undefined;
      const meParticipant = activeGroupCallId && currentUserId
        ? activeGroupCall?.participants?.[currentUserId]
        : undefined;

      return Boolean(meParticipant?.hasPresentationStream);
    }, { timeout: timeoutMs }),
    timeoutMs,
  );
}

async function waitForScreenShareControlReady(page, ariaLabel, timeoutMs) {
  await withTimeout(
    'wait-screen-share-control-ready',
    () => page.waitForFunction(
      (currentAriaLabel) => {
        const button = document.querySelector(`[aria-label="${currentAriaLabel}"]`);

        if (!(button instanceof HTMLElement)) {
          return false;
        }

        const isDisabled = (button instanceof HTMLButtonElement && button.disabled)
          || button.getAttribute('aria-disabled') === 'true'
          || button.classList.contains('disabled');

        if (isDisabled) {
          return false;
        }

        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();

        return style.pointerEvents !== 'none'
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && rect.width > 0
          && rect.height > 0;
      },
      ariaLabel,
      { timeout: timeoutMs },
    ),
    timeoutMs,
  );

  await page.locator(`[aria-label="${ariaLabel}"]`).first().click({
    trial: true,
    timeout: timeoutMs,
  });
}

async function resolveSingleGroupCallChat(page, timeoutMs) {
  return withTimeout(
    'resolve-single-group-call-chat',
    () => page.evaluate(() => {
      const global = window.getGlobal?.();
      const chatsById = global?.chats?.byId || {};
      const fullInfoById = global?.chats?.fullInfoById || {};

      const candidatesByChatId = new Map();

      Object.entries(fullInfoById).forEach(([chatId, fullInfo]) => {
        if (!fullInfo?.groupCallId) {
          return;
        }

        const chat = chatsById[chatId];
        candidatesByChatId.set(chatId, {
          chatId,
          title: chat?.title || chat?.username || chatId,
          groupCallId: fullInfo.groupCallId,
          isCallActive: Boolean(chat?.isCallActive),
          isCallNotEmpty: Boolean(chat?.isCallNotEmpty),
          source: 'fullInfo.groupCallId',
        });
      });

      Object.entries(chatsById).forEach(([chatId, chat]) => {
        if (!chat?.isCallActive && !chat?.isCallNotEmpty) {
          return;
        }

        if (candidatesByChatId.has(chatId)) {
          return;
        }

        candidatesByChatId.set(chatId, {
          chatId,
          title: chat?.title || chat?.username || chatId,
          groupCallId: undefined,
          isCallActive: Boolean(chat?.isCallActive),
          isCallNotEmpty: Boolean(chat?.isCallNotEmpty),
          source: 'chat.callFlags',
        });
      });

      return {
        candidates: [...candidatesByChatId.values()],
      };
    }),
    timeoutMs,
  );
}

async function installScreenShareMediaProbeShim(context) {
  await context.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || (window).__candidateBuildMediaProbeShimInstalled) {
      return;
    }

    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    const originalGetDisplayMedia = typeof mediaDevices.getDisplayMedia === 'function'
      ? mediaDevices.getDisplayMedia.bind(mediaDevices)
      : undefined;

    function isRequested(constraint) {
      if (!constraint) {
        return false;
      }

      if (typeof constraint === 'boolean') {
        return constraint;
      }

      return true;
    }

    function shouldShimVideoOnlyRequest(constraints) {
      return isRequested(constraints?.video) && !isRequested(constraints?.audio);
    }

    function shouldShimAudioOnlyRequest(constraints) {
      return isRequested(constraints?.audio) && !isRequested(constraints?.video);
    }

    function buildFakeVideoStream() {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;

      const context2d = canvas.getContext('2d');
      if (context2d) {
        context2d.fillStyle = '#000';
        context2d.fillRect(0, 0, canvas.width, canvas.height);
      }

      return canvas.captureStream(1);
    }

    function buildFakeAudioStream() {
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      gain.gain.value = 0.0001;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();

      window.__candidateBuildMediaProbeResources ||= [];
      window.__candidateBuildMediaProbeResources.push({ audioContext, oscillator, gain, destination });

      return destination.stream;
    }

    mediaDevices.getUserMedia = async (constraints) => {
      if (shouldShimVideoOnlyRequest(constraints)) {
        return buildFakeVideoStream();
      }

      if (shouldShimAudioOnlyRequest(constraints)) {
        return buildFakeAudioStream();
      }

      if (!shouldShimVideoOnlyRequest(constraints)) {
        return originalGetUserMedia(constraints);
      }

      return originalGetUserMedia(constraints);
    };

    mediaDevices.getDisplayMedia = async (constraints) => {
      if (shouldShimVideoOnlyRequest(constraints)) {
        return buildFakeVideoStream();
      }

      if (shouldShimAudioOnlyRequest(constraints)) {
        return buildFakeAudioStream();
      }

      if (originalGetDisplayMedia) {
        return originalGetDisplayMedia(constraints);
      }

      return buildFakeVideoStream();
    };

    Object.defineProperty(window, '__candidateBuildMediaProbeShimInstalled', {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false,
    });
  });
}

async function runGroupCallScreenShareFlow(page, payload, timeoutMs, interactionTimeoutMs, settleMs, isHeadless, scenarioHooks) {
  const flow = {};
  try {
    if (scenarioHooks?.preflightActions) {
      flow.preflightActions = await runConfiguredScenarioActions(
        page,
        timeoutMs,
        settleMs,
        'scenario-preflight',
        scenarioHooks.preflightActions,
      );
    }
    const resolved = await resolveSingleGroupCallChat(page, interactionTimeoutMs);

    flow.candidates = resolved.candidates;

    if (resolved.candidates.length !== 1) {
      throw new Error(`Expected exactly one group-call chat, found ${resolved.candidates.length}.`);
    }

    const [targetChat] = resolved.candidates;
    flow.targetChat = targetChat;

    await withTimeout(
      'open-group-call-chat',
      () => page.evaluate(({ chatId }) => {
        window.getActions?.().openChat({ id: chatId });
      }, { chatId: targetChat.chatId }),
      interactionTimeoutMs,
    );

    await page.waitForFunction(
      (chatId) => window.location.hash.includes(chatId),
      targetChat.chatId,
      { timeout: timeoutMs },
    );
    await page.waitForTimeout(settleMs);

    flow.afterChatOpen = await collectUiState(page);

    const joinStartedAt = Date.now();
    flow.joinDispatch = await withTimeout(
      'join-group-call-dispatch',
      () => page.evaluate(({ chatId }) => {
        const result = window.getActions?.().requestMasterAndJoinGroupCall({ chatId });

        return {
          returnedType: typeof result,
          isPromiseLike: Boolean(result && typeof result.then === 'function'),
        };
      }, { chatId: targetChat.chatId }),
      interactionTimeoutMs,
    );
    flow.joinDispatchDurationMs = Date.now() - joinStartedAt;

    await page.waitForFunction(
      () => Boolean(window.getGlobal?.().groupCalls?.activeGroupCallId),
      { timeout: timeoutMs },
    );
    await page.waitForTimeout(settleMs);

    flow.afterJoin = await collectGroupCallState(page);

    const screenShareControl = flow.afterJoin.labeledActions
      ?.find(({ ariaLabel }) => {
        if (!ariaLabel) {
          return false;
        }

        const normalized = ariaLabel.toLowerCase();
        return normalized.includes('share screen') || normalized.includes('screen sharing');
      });

    flow.screenShareControl = screenShareControl;

    const triggerStartedAt = Date.now();
    if (screenShareControl?.ariaLabel) {
      const screenShareLocator = page.locator(`[aria-label="${screenShareControl.ariaLabel}"]`).first();

      flow.screenShareClickEvidence = {
        ariaLabel: screenShareControl.ariaLabel,
        beforeClick: {
          count: await page.locator(`[aria-label="${screenShareControl.ariaLabel}"]`).count(),
          isVisible: await screenShareLocator.isVisible().catch(() => false),
          isEnabled: await screenShareLocator.isEnabled().catch(() => false),
          boundingBox: await screenShareLocator.boundingBox().catch(() => undefined),
        },
      };

      await waitForScreenShareControlReady(page, screenShareControl.ariaLabel, timeoutMs);
      await screenShareLocator.click({
        timeout: interactionTimeoutMs,
      });
      flow.screenShareClickEvidence.afterClick = {
        atIso: new Date().toISOString(),
      };
      flow.afterScreenShareClickState = await collectGroupCallState(page).catch(() => undefined);

      if (payload.screenshotPath) {
        const parsedScreenshotPath = path.parse(payload.screenshotPath);
        const clickScreenshotPath = path.join(
          parsedScreenshotPath.dir,
          `${parsedScreenshotPath.name}.after-screen-share-click${parsedScreenshotPath.ext || '.png'}`,
        );

        flow.screenShareClickEvidence.screenshotPath = clickScreenshotPath;
        await page.screenshot({ path: clickScreenshotPath, fullPage: true }).catch((error) => {
          flow.screenShareClickEvidence.screenshotError = serializeError(error);
        });
      }

      flow.screenShareTrigger = 'ui-click';
    } else {
      flow.screenShareDispatch = await withTimeout(
        'trigger-screen-share-dispatch',
        () => page.evaluate(() => {
          const result = window.getActions?.().toggleGroupCallPresentation();

          return {
            returnedType: typeof result,
            isPromiseLike: Boolean(result && typeof result.then === 'function'),
          };
        }),
        interactionTimeoutMs,
      );
      flow.screenShareTrigger = 'action-fallback';
    }
    flow.screenShareDispatchDurationMs = Date.now() - triggerStartedAt;
    flow.screenShareMediaProbeShimInstalled = await page.evaluate(
      () => Boolean(window.__candidateBuildMediaProbeShimInstalled),
    ).catch(() => false);
    flow.externalChooserExpected = !flow.screenShareMediaProbeShimInstalled;

    if (!isHeadless) {
      const confirmTimeoutMs = Math.max(
        settleMs,
        flow.externalChooserExpected
          ? (payload.loggingEnabled
            ? LOGGING_ENABLED_HEADED_SCREEN_SHARE_CONFIRM_TIMEOUT_MS
            : DEFAULT_HEADED_SCREEN_SHARE_CONFIRM_TIMEOUT_MS)
          : interactionTimeoutMs,
      );
      const postClickPauseMs = Math.max(
        settleMs,
        flow.externalChooserExpected
          ? (payload.loggingEnabled
            ? LOGGING_ENABLED_HEADED_SCREEN_SHARE_POST_CLICK_PAUSE_MS
            : DEFAULT_HEADED_SCREEN_SHARE_POST_CLICK_PAUSE_MS)
          : settleMs,
      );

      flow.screenShareAwait = {
        confirmTimeoutMs,
        postClickPauseMs,
      };

      const waitStartedAt = Date.now();
      try {
        await waitForScreenShareStarted(page, confirmTimeoutMs);
        flow.screenShareAwait.detected = 'me-has-presentation-stream';
      } catch (error) {
        flow.screenShareAwait.detected = 'post-click-pause';
        flow.screenShareAwait.waitError = serializeError(error);
        await page.waitForTimeout(postClickPauseMs);
      }
      flow.screenShareAwait.durationMs = Date.now() - waitStartedAt;
    }

    try {
      flow.afterScreenShareTrigger = await withTimeout(
        'post-screen-share-eval',
        () => collectGroupCallState(page),
        interactionTimeoutMs,
      );
    } catch (error) {
      flow.postTriggerDiagnosis = await diagnosePostScreenShareState(page, payload, interactionTimeoutMs, {
        externalChooserExpected: flow.externalChooserExpected,
        screenShareAwait: flow.screenShareAwait,
      }).catch((diagnosisError) => ({
        diagnosisError: serializeError(diagnosisError),
        likelyBlocker: 'diagnosis-failed',
      }));
      throw error;
    }

    if (scenarioHooks?.afterTriggerActions) {
      flow.afterTriggerActions = await runConfiguredScenarioActions(
        page,
        timeoutMs,
        settleMs,
        'scenario-after-trigger',
        scenarioHooks.afterTriggerActions,
      );
    }

    return flow;
  } catch (error) {
    error.groupCallScreenShareFlow = flow;
    throw error;
  }
}

async function runGroupCallFlow(page, payload, timeoutMs, interactionTimeoutMs, settleMs, scenarioHooks) {
  const flow = {};

  try {
    if (scenarioHooks?.preflightActions) {
      flow.preflightActions = await runConfiguredScenarioActions(
        page,
        timeoutMs,
        settleMs,
        'scenario-preflight',
        scenarioHooks.preflightActions,
      );
    }

    const resolved = await resolveSingleGroupCallChat(page, interactionTimeoutMs);
    flow.candidates = resolved.candidates;

    if (resolved.candidates.length !== 1) {
      throw new Error(`Expected exactly one group-call chat, found ${resolved.candidates.length}.`);
    }

    const [targetChat] = resolved.candidates;
    flow.targetChat = targetChat;

    await withTimeout(
      'open-group-call-chat',
      () => page.evaluate(({ chatId }) => {
        window.getActions?.().openChat({ id: chatId });
      }, { chatId: targetChat.chatId }),
      interactionTimeoutMs,
    );

    await page.waitForFunction(
      (chatId) => window.location.hash.includes(chatId),
      targetChat.chatId,
      { timeout: timeoutMs },
    );
    await page.waitForTimeout(settleMs);

    flow.afterChatOpen = await collectUiState(page);

    const joinStartedAt = Date.now();
    flow.joinDispatch = await withTimeout(
      'join-group-call-dispatch',
      () => page.evaluate(({ chatId }) => {
        const result = window.getActions?.().requestMasterAndJoinGroupCall({ chatId });

        return {
          returnedType: typeof result,
          isPromiseLike: Boolean(result && typeof result.then === 'function'),
        };
      }, { chatId: targetChat.chatId }),
      interactionTimeoutMs,
    );
    flow.joinDispatchDurationMs = Date.now() - joinStartedAt;

    await page.waitForFunction(
      () => Boolean(window.getGlobal?.().groupCalls?.activeGroupCallId),
      { timeout: timeoutMs },
    );

    await page.waitForFunction(
      () => {
        const global = window.getGlobal?.();
        const activeGroupCallId = global?.groupCalls?.activeGroupCallId;
        const activeGroupCall = activeGroupCallId ? global?.groupCalls?.byId?.[activeGroupCallId] : undefined;
        const meParticipant = activeGroupCallId && global?.currentUserId
          ? activeGroupCall?.participants?.[global.currentUserId]
          : undefined;

        return Boolean(meParticipant) || Number(activeGroupCall?.participantsCount || 0) > 0;
      },
      { timeout: timeoutMs },
    );

    await page.waitForTimeout(settleMs);

    flow.afterJoin = await collectGroupCallState(page);

    if (!flow.afterJoin?.activeGroupCallId || (!flow.afterJoin.meParticipantExists
      && Number(flow.afterJoin?.activeGroupCallParticipantsCount || 0) <= 0)) {
      throw new Error('Group call repro did not reach a stable joined state.');
    }

    return flow;
  } catch (error) {
    error.groupCallFlow = flow;
    throw error;
  }
}

async function runResponsivenessProbes(page, interactionTimeoutMs) {
  const probe = {
    evalBefore: undefined,
    clickTarget: undefined,
    evalAfterClick: undefined,
    scrollResult: undefined,
    evalAfterScroll: undefined,
  };

  const evalBeforeStartedAt = Date.now();
  probe.evalBefore = await withTimeout(
    'eval-before',
    () => page.evaluate(() => ({ now: performance.now(), href: window.location.href })),
    interactionTimeoutMs,
  );
  probe.evalBefore.durationMs = Date.now() - evalBeforeStartedAt;

  const targetInfo = await withTimeout(
    'resolve-click-target',
    () => page.evaluate(() => {
      const rows = [...document.querySelectorAll('#LeftColumn .chat-list .Chat')];
      const targetIndex = rows.findIndex((row) => !row.classList.contains('selected'));
      const resolvedIndex = targetIndex === -1 ? 0 : targetIndex;
      const targetRow = rows[resolvedIndex];
      const button = targetRow?.querySelector('.ListItem-button');

      return {
        targetIndex: resolvedIndex,
        rowCount: rows.length,
        text: button?.textContent?.trim().slice(0, 160) || '',
        wasSelected: Boolean(targetRow?.classList.contains('selected')),
      };
    }),
    interactionTimeoutMs,
  );

  if (!targetInfo.rowCount) {
    throw new Error('No chat rows found for click probe.');
  }

  probe.clickTarget = targetInfo;

  const clickStartedAt = Date.now();
  await page.locator('#LeftColumn .chat-list .Chat .ListItem-button').nth(targetInfo.targetIndex).click({
    timeout: interactionTimeoutMs,
  });
  probe.clickTarget.clickDurationMs = Date.now() - clickStartedAt;

  const evalAfterClickStartedAt = Date.now();
  probe.evalAfterClick = await withTimeout(
    'eval-after-click',
    () => page.evaluate(() => ({ now: performance.now(), href: window.location.href })),
    interactionTimeoutMs,
  );
  probe.evalAfterClick.durationMs = Date.now() - evalAfterClickStartedAt;

  probe.scrollResult = await withTimeout(
    'scroll-chat-list',
    () => page.locator('#LeftColumn .chat-list').evaluate((element) => {
      const nextScrollTop = Math.min(element.scrollHeight, element.clientHeight * 2);
      element.scrollTop = nextScrollTop;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));

      return {
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
    }),
    interactionTimeoutMs,
  );

  const evalAfterScrollStartedAt = Date.now();
  probe.evalAfterScroll = await withTimeout(
    'eval-after-scroll',
    () => page.evaluate(() => ({ now: performance.now(), href: window.location.href })),
    interactionTimeoutMs,
  );
  probe.evalAfterScroll.durationMs = Date.now() - evalAfterScrollStartedAt;

  return probe;
}

const args = parseArgs(process.argv.slice(2));
const reproFilePath = resolveReproFilePath(args['repro-file'] || process.env.CANDIDATE_REPRO_FILE);
const reproPayload = await readReproPayload(reproFilePath);
const featureMetadata = readFeatureMetadataFromArgs(args);
const gatewayUrl = args['gateway-url'] || process.env.CANDIDATE_REPRO_GATEWAY_URL || DEFAULT_GATEWAY_URL;
const loggingEnabled = toBooleanFlag(
  args['logging-enabled'] ?? process.env.CANDIDATE_REPRO_LOGGING_ENABLED,
  DEFAULT_LOGGING_ENABLED,
);
const defaultTimeoutMs = loggingEnabled ? LOGGING_ENABLED_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
const defaultInteractionTimeoutMs = loggingEnabled
  ? LOGGING_ENABLED_DEFAULT_INTERACTION_TIMEOUT_MS
  : DEFAULT_INTERACTION_TIMEOUT_MS;
const defaultSettleMs = loggingEnabled ? LOGGING_ENABLED_DEFAULT_SETTLE_MS : DEFAULT_SETTLE_MS;
const outputDir = path.resolve(args['output-dir'] || process.env.CANDIDATE_REPRO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
const timeoutMs = Number(args.timeout || process.env.CANDIDATE_REPRO_TIMEOUT_MS || defaultTimeoutMs);
const interactionTimeoutMs = Number(
  args['interaction-timeout'] || process.env.CANDIDATE_REPRO_INTERACTION_TIMEOUT_MS || defaultInteractionTimeoutMs,
);
const settleMs = Number(args['settle-ms'] || process.env.CANDIDATE_REPRO_SETTLE_MS || defaultSettleMs);
const flow = args.flow
  || process.env.CANDIDATE_REPRO_FLOW
  || resolveFlowFromReproPayload(reproPayload)
  || DEFAULT_FLOW;
const isHeadless = toBooleanFlag(args.headless ?? process.env.CANDIDATE_REPRO_HEADLESS, flow === 'chat-probe');
const browserChannel = args.channel || process.env.CANDIDATE_REPRO_CHANNEL;
const browserJsHeapMb = toPositiveNumber(
  args['browser-js-heap-mb'] || process.env.CANDIDATE_REPRO_BROWSER_JS_HEAP_MB,
  DEFAULT_BROWSER_JS_HEAP_MB,
);
const screenShareAutoSelectSource = args['screen-share-source']
  || process.env.CANDIDATE_REPRO_SCREEN_SHARE_SOURCE
  || DEFAULT_SCREEN_SHARE_AUTO_SELECT_SOURCE;
const scenarioHooks = resolveScenarioHooks(reproPayload, flow);
const skipLaunch = toBooleanFlag(args['skip-launch'] ?? process.env.CANDIDATE_REPRO_SKIP_LAUNCH, false);
const outputStem = sanitizeStem(`logging-${loggingEnabled ? 'on' : 'off'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const jsonPath = path.join(outputDir, `${outputStem}.json`);
const screenshotPath = path.join(outputDir, `${outputStem}.png`);

await mkdir(outputDir, { recursive: true });

const payload = {
  startedAtIso: new Date().toISOString(),
  gatewayUrl,
  loggingEnabled,
  timeoutMs,
  interactionTimeoutMs,
  settleMs,
  flow,
  reproFilePath: reproFilePath || null,
  reproFeature: reproPayload?.feature || featureMetadata || null,
  isHeadless,
  browserChannel,
  browserJsHeapMb,
  screenShareAutoSelectSource: flow === 'group-call-screen-share' ? screenShareAutoSelectSource : null,
  skipLaunch,
  jsonPath,
  screenshotPath,
  healthSignals: buildHealthSignals(),
  healthSnapshots: [],
};

let browser;
let context;
let page;
const relaySessionIds = new Set();
const relayStatuses = [];
let relayPostCount = 0;

try {
  if (loggingEnabled) {
    payload.runtimeIngestionReadiness = await callOrchestrator(
      gatewayUrl,
      '/api/actions/ensure-runtime-ingestion-readiness',
      { method: 'POST', body: {} },
    );

    if (!payload.runtimeIngestionReadiness?.runtimePublishReady || !payload.runtimeIngestionReadiness?.analyticsReady) {
      throw new Error(
        payload.runtimeIngestionReadiness?.message
        || 'Runtime ingestion readiness preflight failed before the candidate repro launch.',
      );
    }
  }

  const statusData = await callOrchestrator(gatewayUrl, '/api/status/playwright-devops');

  payload.preLaunchStatus = statusData.ordinarySession;

  if (!skipLaunch) {
    payload.launch = await callOrchestrator(gatewayUrl, '/api/actions/launch-graph-session', {
      method: 'POST',
      body: {
        loggingEnabled,
        reproPayload: reproPayload && loggingEnabled ? reproPayload : undefined,
      },
    });
  }

  const effectiveBaseUrl = payload.launch?.baseUrl || payload.preLaunchStatus?.baseUrl;
  const storageStatePath = payload.preLaunchStatus?.storageStatePath;

  if (!effectiveBaseUrl) {
    throw new Error('Unable to resolve the ordinary session base URL.');
  }

  if (!storageStatePath) {
    throw new Error('Unable to resolve the ordinary session storageState path.');
  }

  const hasSavedStorageState = await pathExists(storageStatePath);
  payload.effectiveBaseUrl = effectiveBaseUrl;
  payload.storageStatePath = storageStatePath;
  payload.isHeadlessRun = isHeadless;
  payload.sessionRecovery = {
    triggered: false,
    storageStateExistsAtLaunch: hasSavedStorageState,
    savedSessionLikelyUsable: payload.preLaunchStatus?.savedSessionLikelyUsable,
    savedSessionCheckMessage: payload.preLaunchStatus?.savedSessionCheckMessage,
  };

  browser = await chromium.launch({
    headless: isHeadless,
    channel: browserChannel,
    args: buildBrowserLaunchArgs({
      browserJsHeapMb,
      effectiveBaseUrl,
      flow,
      autoSelectSource: screenShareAutoSelectSource,
    }),
  });
  context = await browser.newContext(hasSavedStorageState ? { storageState: storageStatePath } : undefined);
  if (flow === 'group-call-screen-share') {
    await installScreenShareMediaProbeShim(context);
  }
  await context.grantPermissions(['microphone', 'camera'], { origin: effectiveBaseUrl }).catch(() => undefined);

  page = await context.newPage();
  attachPageHealthSignals(page, payload.healthSignals);

  await page.route('**/graph-relay', async (route) => {
    const request = route.request();
    const postData = request.postData();

    relayPostCount += 1;

    if (postData) {
      try {
        const rows = JSON.parse(postData);
        extractSessionIdsFromPayload(rows).forEach((sessionId) => relaySessionIds.add(sessionId));
      } catch {
        // Ignore malformed relay payload capture and continue driving the scenario.
      }
    }

    await route.continue();
  });

  page.on('response', async (response) => {
    if (!response.url().includes('/graph-relay')) {
      return;
    }

    let body;
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }

    relayStatuses.push({
      status: response.status(),
      body,
    });
  });

  payload.goto = await withTimeout(
    'page-goto',
    async () => {
      const response = await page.goto(effectiveBaseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      return {
        ok: true,
        status: response?.status() || null,
        url: page.url(),
      };
    },
    timeoutMs,
  );
  await pushHealthSnapshot(payload, page, 'after-goto', interactionTimeoutMs);

  await waitForAppReady(page, payload, timeoutMs, settleMs);
  await pushHealthSnapshot(payload, page, 'after-app-ready', interactionTimeoutMs);
  payload.runtimeReporterBeforeProbe = await inspectRuntimeReporter(page).catch((error) => ({
    available: false,
    reason: 'inspect-before-probe-failed',
    error: serializeError(error),
  }));

  payload.preProbeState = await collectUiState(page);
  payload.probe = await runResponsivenessProbes(page, interactionTimeoutMs);
  payload.postProbeState = await collectUiState(page);
  await pushHealthSnapshot(payload, page, 'after-chat-probe', interactionTimeoutMs);

  if (flow === 'group-call') {
    payload.groupCall = await runGroupCallFlow(
      page,
      payload,
      timeoutMs,
      interactionTimeoutMs,
      settleMs,
      scenarioHooks,
    );
    await pushHealthSnapshot(payload, page, 'after-group-call', interactionTimeoutMs);
    payload.runtimeReporterAfterFlow = await inspectRuntimeReporter(page).catch((error) => ({
      available: false,
      reason: 'inspect-after-flow-failed',
      error: serializeError(error),
    }));
  }

  if (flow === 'group-call-screen-share') {
    payload.groupCallScreenShare = await runGroupCallScreenShareFlow(
      page,
      payload,
      timeoutMs,
      interactionTimeoutMs,
      settleMs,
      isHeadless,
      scenarioHooks,
    );
    await pushHealthSnapshot(payload, page, 'after-group-call-screen-share', interactionTimeoutMs);
  }

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch((error) => {
    payload.screenshotError = serializeError(error);
  });

  payload.healthSummary = classifyHealth(payload);
  payload.relayPostCount = relayPostCount;
  payload.relaySessionIds = [...relaySessionIds];
  payload.relayStatuses = relayStatuses;

  payload.ok = !payload.healthSummary.failures.length;
  payload.finishedAtIso = new Date().toISOString();
  await flushPayload(payload, jsonPath);

  console.log(JSON.stringify({
    ok: payload.ok,
    loggingEnabled,
    baseUrl: effectiveBaseUrl,
    storageStatePath,
    jsonPath,
    screenshotPath,
    preProbeState: payload.preProbeState,
    postProbeState: payload.postProbeState,
    probe: payload.probe,
    groupCall: payload.groupCall,
    groupCallScreenShare: payload.groupCallScreenShare,
    healthSummary: payload.healthSummary,
  }, null, 2));
  console.log(`FLOW_DONE ${JSON.stringify(payload)}`);
} catch (error) {
  payload.ok = false;
  payload.error = serializeError(error);

  if (error?.groupCallFlow) {
    payload.groupCall = error.groupCallFlow;
  }

  if (error?.groupCallScreenShareFlow) {
    payload.groupCallScreenShare = error.groupCallScreenShareFlow;
  }

  if (page && (flow === 'group-call' || flow === 'group-call-screen-share') && scenarioHooks?.errorActions) {
    payload.scenarioCleanupOnError = await runConfiguredScenarioActions(
      page,
      timeoutMs,
      settleMs,
      'scenario-error',
      scenarioHooks.errorActions,
    ).catch((cleanupError) => ({ error: serializeError(cleanupError) }));
  }

  payload.healthSummary = classifyHealth(payload);
  payload.relayPostCount = relayPostCount;
  payload.relaySessionIds = [...relaySessionIds];
  payload.relayStatuses = relayStatuses;
  payload.finishedAtIso = new Date().toISOString();
  await flushPayload(payload, jsonPath).catch(() => undefined);

  console.error(JSON.stringify({
    ok: false,
    loggingEnabled,
    jsonPath,
    screenshotPath,
    error: payload.error,
    healthSummary: payload.healthSummary,
  }, null, 2));
  console.error(`FLOW_DONE ${JSON.stringify(payload)}`);
  process.exitCode = 1;
} finally {
  if (page && (flow === 'group-call' || flow === 'group-call-screen-share') && scenarioHooks?.exitActions && !payload.scenarioCleanupOnError) {
    payload.scenarioCleanupOnExit = await runConfiguredScenarioActions(
      page,
      timeoutMs,
      settleMs,
      'scenario-exit',
      scenarioHooks.exitActions,
    ).catch(() => undefined);
  }

  if (page && loggingEnabled) {
    await flushRuntimeReporter(page).catch(() => undefined);
    payload.runtimeReporterAfterFlush = await inspectRuntimeReporter(page).catch((error) => ({
      available: false,
      reason: 'inspect-after-flush-failed',
      error: serializeError(error),
    }));
  }

  if (context) {
    await context.close().catch(() => undefined);
  }

  if (browser) {
    await browser.close().catch(() => undefined);
  }
}
