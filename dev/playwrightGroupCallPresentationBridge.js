import { chromium } from '@playwright/test';

const baseUrl = process.env.GROUP_CALL_PRESENTATION_BRIDGE_BASE_URL || 'http://localhost:1235/';
const scenario = process.env.GROUP_CALL_PRESENTATION_BRIDGE_SCENARIO || 'default';
const timeoutMs = Number(process.env.GROUP_CALL_PRESENTATION_BRIDGE_TIMEOUT_MS || 90_000);
const settleMs = Number(process.env.GROUP_CALL_PRESENTATION_BRIDGE_SETTLE_MS || 3_000);
const isHeadless = process.env.GROUP_CALL_PRESENTATION_BRIDGE_HEADLESS !== '0';

function buildTargetUrl() {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();

  params.set('mockScenario', scenario);
  params.set('tgWebAuthTest', '1');
  params.set('tgGraphGroupCallPresentationBridge', '1');
  url.hash = `?${params.toString()}`;

  return url.toString();
}

async function waitForApp(page) {
  const targetUrl = buildTargetUrl();

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(
    () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
    { timeout: timeoutMs },
  );
  await page.waitForFunction(() => {
    const global = window.getGlobal?.();

    return Boolean(
      global
      && global.connectionState === 'connectionStateReady'
      && global.auth?.state === 'authorizationStateReady'
    );
  }, { timeout: timeoutMs });
  await page.waitForTimeout(settleMs);

  return targetUrl;
}

async function flushRuntimeReporter(page) {
  await page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return;
    }

    chunkGlobal.push([[Symbol('group-call-presentation-bridge-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

async function driveGroupCallPresentationBridge(page) {
  return page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      throw new Error('webpack runtime is unavailable');
    }

    chunkGlobal.push([[Symbol('group-call-presentation-bridge-probe')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const moduleIds = Object.keys(requireFn.m);
    const findModuleId = (fragment) => moduleIds.find((key) => key.toLowerCase().includes(fragment));
    const getModule = (fragment) => {
      const resolvedId = findModuleId(fragment);
      if (!resolvedId) {
        throw new Error(`Unable to resolve module: ${fragment}`);
      }

      return requireFn(resolvedId);
    };
    const gramJs = getModule('/src/api/gramjs/index.');
    const runtimeCore = getModule('graph/packages/runtime-core/src/index.js');

    const getEventCount = () => runtimeCore.RuntimeReporter.instance?.events?.length || 0;
    const getRawEventDelta = (startCount) => runtimeCore.RuntimeReporter.instance?.events?.slice(startCount) || [];
    const summarizeEventDelta = (events) => events.map((event) => ({
      kind: event.kind,
      fnName: event.context?.fnName || event.fnName,
      correlationId: event.options?.correlationId,
      boundaryKind: event.options?.boundaryKind,
      boundaryDirection: event.options?.boundaryDirection,
      boundaryChannel: event.options?.boundaryChannel,
      boundaryMessageType: event.options?.boundaryMessageType,
      resourceKind: event.options?.resourceKind,
      resourceId: event.options?.resourceId,
    }));

    const fakeGroupCall = {
      id: '1',
      accessHash: '1',
      participantsCount: 1,
      version: 1,
      participants: {},
      connectionState: 'connecting',
    };
    const fakeJoinPayload = {
      ufrag: 'presentation-ufrag',
      pwd: 'presentation-pwd',
      fingerprints: [{
        hash: 'sha-256',
        setup: 'active',
        fingerprint: 'AA:BB:CC:DD',
      }],
      ssrc: 1,
      'ssrc-groups': [],
    };
    let joinResult;
    let joinError;
    const joinStart = getEventCount();

    globalThis.__tgGraphGroupCallPresentationBridgeEnabled = true;
    runtimeCore.RuntimeReporter.init();

    try {
      joinResult = await gramJs.callApi('joinGroupCallPresentation', {
        call: fakeGroupCall,
        params: fakeJoinPayload,
      });
    } catch (error) {
      joinError = String(error?.message || error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const updateStart = getEventCount();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    return {
      joinResult: joinResult ?? null,
      joinError: joinError || null,
      joinEvents: summarizeEventDelta(getRawEventDelta(joinStart)),
      apiUpdateEvents: summarizeEventDelta(getRawEventDelta(updateStart)),
      recentEvents: summarizeEventDelta(runtimeCore.RuntimeReporter.instance?.events?.slice(-40) || []),
    };
  });
}

const browser = await chromium.launch({ headless: isHeadless });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const relayStatuses = [];
  let relayPostCount = 0;

  await page.route('**/graph-relay', async (route) => {
    relayPostCount += 1;

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

  const targetUrl = await waitForApp(page);
  const probeState = await driveGroupCallPresentationBridge(page);
  await flushRuntimeReporter(page);
  await page.waitForTimeout(3_000);

  console.log(JSON.stringify({
    targetUrl,
    scenario,
    probeState,
    relayPostCount,
    relayStatuses,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
