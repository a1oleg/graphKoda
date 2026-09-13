import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '@playwright/test';

const baseUrl = process.env.RUNTIME_DIAG_URL || 'http://127.0.0.1:1234/';
const storageStatePath = process.env.RUNTIME_DIAG_STORAGE_STATE;
const userDataDir = process.env.RUNTIME_DIAG_USER_DATA_DIR;
const browserChannel = process.env.RUNTIME_DIAG_CHANNEL;
const gotoTimeoutMs = Number(process.env.RUNTIME_DIAG_GOTO_TIMEOUT_MS || 30_000);
const settleMs = Number(process.env.RUNTIME_DIAG_SETTLE_MS || 5_000);
const evalTimeoutMs = Number(process.env.RUNTIME_DIAG_EVAL_TIMEOUT_MS || 3_000);
const cpuProfileDurationMs = Number(process.env.RUNTIME_DIAG_CPU_PROFILE_MS || 3_000);
const cdpTimeoutMs = Number(process.env.RUNTIME_DIAG_CDP_TIMEOUT_MS || 4_000);
const screenshotTimeoutMs = Number(process.env.RUNTIME_DIAG_SCREENSHOT_TIMEOUT_MS || 4_000);
const closeTimeoutMs = Number(process.env.RUNTIME_DIAG_CLOSE_TIMEOUT_MS || 2_000);
const outputDir = process.env.RUNTIME_DIAG_OUTPUT_DIR || path.resolve('.tmp', 'runtime-diagnosis');
const outputStem = process.env.RUNTIME_DIAG_OUTPUT_STEM || 'latest';
const isHeadless = process.env.RUNTIME_DIAG_HEADLESS !== '0';

function logStage(stage) {
  console.error(`[runtime-diag] ${stage}`);
}

function truncateText(value, maxLength = 500) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

function summarizeCpuProfile(profile) {
  const nodes = profile?.nodes || [];
  const samples = profile?.samples || [];

  if (!nodes.length || !samples.length) {
    return undefined;
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const countsByNodeId = new Map();

  samples.forEach((nodeId) => {
    countsByNodeId.set(nodeId, (countsByNodeId.get(nodeId) || 0) + 1);
  });

  return [...countsByNodeId.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
    .map(([nodeId, sampleCount]) => {
      const node = nodeById.get(nodeId);
      const callFrame = node?.callFrame;

      return {
        sampleCount,
        functionName: callFrame?.functionName || '(anonymous)',
        url: callFrame?.url,
        lineNumber: callFrame?.lineNumber,
        columnNumber: callFrame?.columnNumber,
      };
    });
}

async function withTimeout(task, timeoutMs, timeoutMessage) {
  let timeoutId;

  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

await mkdir(outputDir, { recursive: true });

const startedAtIso = new Date().toISOString();
const jsonPath = path.join(outputDir, `${outputStem}.json`);
const screenshotPath = path.join(outputDir, `${outputStem}.png`);

let browser;
let context;

const payload = {
  startedAtIso,
  baseUrl,
  storageStatePath,
  userDataDir,
  browserChannel,
  screenshotPath,
};

async function flushPayload() {
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
}

try {
  if (userDataDir) {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless,
      channel: browserChannel,
    });
  } else {
    browser = await chromium.launch({ headless: isHeadless, channel: browserChannel });
    context = await browser.newContext(storageStatePath ? { storageState: storageStatePath } : undefined);
  }

  logStage('browser-launched');

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const pageErrors = [];
  const consoleErrors = [];
  const consoleMessages = [];
  const runtimeExceptions = [];
  const runtimeConsoleEvents = [];
  const logEntries = [];

  page.on('pageerror', (error) => {
    pageErrors.push(serializeError(error));
  });

  page.on('console', (message) => {
    const entry = {
      type: message.type(),
      text: truncateText(message.text(), 2_000),
      location: message.location(),
    };

    if (message.type() === 'error') {
      consoleErrors.push(entry);
    } else {
      consoleMessages.push(entry);
    }
  });

  await withTimeout(() => cdp.send('Runtime.enable'), cdpTimeoutMs, 'Runtime.enable timed out');
  await withTimeout(() => cdp.send('Log.enable'), cdpTimeoutMs, 'Log.enable timed out');
  await withTimeout(() => cdp.send('Performance.enable'), cdpTimeoutMs, 'Performance.enable timed out');
  await withTimeout(() => cdp.send('Profiler.enable'), cdpTimeoutMs, 'Profiler.enable timed out');
  await withTimeout(() => cdp.send('HeapProfiler.enable'), cdpTimeoutMs, 'HeapProfiler.enable timed out');

  logStage('cdp-enabled');

  cdp.on('Runtime.exceptionThrown', (event) => {
    runtimeExceptions.push({
      timestamp: event.timestamp,
      text: event.exceptionDetails?.text,
      url: event.exceptionDetails?.url,
      lineNumber: event.exceptionDetails?.lineNumber,
      columnNumber: event.exceptionDetails?.columnNumber,
      exception: truncateText(event.exceptionDetails?.exception?.description || event.exceptionDetails?.exception?.value, 2_000),
    });
  });

  cdp.on('Runtime.consoleAPICalled', (event) => {
    runtimeConsoleEvents.push({
      type: event.type,
      args: (event.args || []).map((arg) => truncateText(arg?.value || arg?.description, 500)),
      executionContextId: event.executionContextId,
      timestamp: event.timestamp,
      stackPreview: event.stackTrace?.callFrames?.slice(0, 5),
    });
  });

  cdp.on('Log.entryAdded', (event) => {
    logEntries.push({
      level: event.entry?.level,
      source: event.entry?.source,
      text: truncateText(event.entry?.text, 2_000),
      url: event.entry?.url,
      lineNumber: event.entry?.lineNumber,
    });
  });

  let gotoStatus = 'not-started';
  let gotoError;

  try {
    const response = await page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: gotoTimeoutMs,
    });
    gotoStatus = `domcontentloaded:${response?.status?.() || 'no-response'}`;
  } catch (error) {
    gotoStatus = 'failed';
    gotoError = serializeError(error);
  }

  payload.gotoStatus = gotoStatus;
  payload.gotoError = gotoError;
  await flushPayload();

  logStage(`goto-${gotoStatus}`);

  await withTimeout(
    () => cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 32 * 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    }),
    cdpTimeoutMs,
    'HeapProfiler.startSampling timed out',
  ).catch((error) => {
    payload.heapSamplingStartError = serializeError(error);
  });

  await withTimeout(() => cdp.send('Profiler.start'), cdpTimeoutMs, 'Profiler.start timed out').catch((error) => {
    payload.cpuProfileStartError = serializeError(error);
  });

  logStage('profilers-started');

  await page.waitForTimeout(Math.max(settleMs, cpuProfileDurationMs));

  logStage('settle-finished');

  const performanceMetrics = await withTimeout(
    () => cdp.send('Performance.getMetrics'),
    cdpTimeoutMs,
    'Performance.getMetrics timed out',
  ).catch((error) => ({ error: serializeError(error) }));
  const cpuProfile = await withTimeout(
    () => cdp.send('Profiler.stop'),
    cdpTimeoutMs,
    'Profiler.stop timed out',
  ).catch((error) => ({ error: serializeError(error) }));
  const heapSamplingProfile = await withTimeout(
    () => cdp.send('HeapProfiler.stopSampling'),
    cdpTimeoutMs,
    'HeapProfiler.stopSampling timed out',
  ).catch((error) => ({ error: serializeError(error) }));

  logStage('profilers-stopped');

  const pageState = await withTimeout(
    () => page.evaluate(() => ({
      href: window.location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 500) || '',
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      hasRoot: Boolean(document.querySelector('#root')),
      rootChildCount: document.querySelector('#root')?.childElementCount ?? -1,
      memory: globalThis.performance && 'memory' in globalThis.performance
        ? {
            jsHeapSizeLimit: globalThis.performance.memory.jsHeapSizeLimit,
            totalJSHeapSize: globalThis.performance.memory.totalJSHeapSize,
            usedJSHeapSize: globalThis.performance.memory.usedJSHeapSize,
          }
        : undefined,
    })),
    evalTimeoutMs,
    `page.evaluate timed out after ${evalTimeoutMs}ms`,
  ).catch((error) => ({ error: serializeError(error) }));

  await withTimeout(
    () => page.screenshot({ path: screenshotPath, fullPage: true }),
    screenshotTimeoutMs,
    `page.screenshot timed out after ${screenshotTimeoutMs}ms`,
  ).catch((error) => {
    payload.screenshotError = serializeError(error);
  });

  payload.pageState = pageState;
  payload.pageErrors = pageErrors;
  payload.consoleErrors = consoleErrors;
  payload.consoleMessages = consoleMessages.slice(0, 50);
  payload.runtimeExceptions = runtimeExceptions;
  payload.runtimeConsoleEvents = runtimeConsoleEvents.slice(0, 50);
  payload.logEntries = logEntries.slice(0, 50);
  payload.performanceMetrics = performanceMetrics;
  payload.cpuProfileSummary = cpuProfile.profile
      ? {
          nodeCount: cpuProfile.profile.nodes?.length || 0,
          sampleCount: cpuProfile.profile.samples?.length || 0,
          timeDeltas: cpuProfile.profile.timeDeltas?.slice(0, 20) || [],
          hottestNodes: summarizeCpuProfile(cpuProfile.profile),
        }
      : cpuProfile;
  payload.heapSamplingSummary = heapSamplingProfile.profile
      ? {
          headChildren: heapSamplingProfile.profile.head?.children?.length || 0,
          samples: heapSamplingProfile.profile.samples?.length || 0,
        }
      : heapSamplingProfile;

  await flushPayload();

  logStage('payload-written');

  console.log(JSON.stringify({
    jsonPath,
    screenshotPath,
    gotoStatus,
    pageState,
    pageErrorsCount: pageErrors.length,
    consoleErrorsCount: consoleErrors.length,
    runtimeExceptionsCount: runtimeExceptions.length,
    logEntriesCount: logEntries.length,
  }, null, 2));
} finally {
  if (context) {
    await withTimeout(() => context.close(), closeTimeoutMs, `context.close timed out after ${closeTimeoutMs}ms`).catch(() => undefined);
  }

  if (browser) {
    await withTimeout(() => browser.close(), closeTimeoutMs, `browser.close timed out after ${closeTimeoutMs}ms`).catch(() => undefined);
  }
}
