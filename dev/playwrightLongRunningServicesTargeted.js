import { chromium } from '@playwright/test';

import defaultMockData from '../src/lib/gramjs/client/__mocks__/default.json' with { type: 'json' };

const baseUrl = process.env.LONG_RUNNING_TARGETED_BASE_URL || 'http://localhost:1235/';
const scenario = process.env.LONG_RUNNING_TARGETED_SCENARIO || 'default';
const timeoutMs = Number(process.env.LONG_RUNNING_TARGETED_TIMEOUT_MS || 45_000);
const settleMs = Number(process.env.LONG_RUNNING_TARGETED_SETTLE_MS || 3_000);
const channelDifferenceRepeats = Number(process.env.LONG_RUNNING_TARGETED_CHANNEL_DIFFERENCE_REPEATS || 3);
const isHeadless = process.env.LONG_RUNNING_TARGETED_HEADLESS !== '0';

function buildTargetUrl() {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  params.set('mockScenario', scenario);
  params.set('tgWebAuthTest', '1');
  params.set('tgGraphTargetedLongRunning', '1');
  url.hash = `?${params.toString()}`;
  return url.toString();
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

async function waitForApp(page) {
  const targetUrl = buildTargetUrl();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(
    () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(settleMs);
  return targetUrl;
}

async function driveSeededChannelDifference(page, mockData, repeats) {
  return page.evaluate(async ({ innerMockData, innerRepeats }) => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      throw new Error('webpack runtime is unavailable');
    }

    chunkGlobal.push([[Symbol('long-running-services-targeted')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const moduleIds = Object.keys(requireFn.m);
    const tryRequire = (candidates) => {
      for (const candidate of candidates) {
        try {
          return requireFn(candidate);
        } catch {
          // Try the next candidate.
        }
      }

      return undefined;
    };
    const findModuleId = (fragment) => moduleIds.find((key) => key.toLowerCase().includes(fragment));

    const gramJsModule = tryRequire([
      './src/api/gramjs/index.ts',
      './src/api/gramjs/index.js',
    ]);
    const gramJsId = gramJsModule ? undefined : findModuleId('/src/api/gramjs/index.');

    if (!gramJsModule && !gramJsId) {
      throw new Error(`Unable to resolve gramjs connector module: ${JSON.stringify(moduleIds.slice(0, 80))}`);
    }

    const gramJs = gramJsModule || requireFn(gramJsId);

    const rawChannelId = innerMockData.channels[0]?.id;
    if (!rawChannelId) {
      throw new Error('Mock data does not contain a channel');
    }

    const channelId = `${-(10n ** 12n) - BigInt(rawChannelId)}`;
    const seededLocalDb = {
      chats: {
        [channelId]: {
          CONSTRUCTOR_ID: 473084188,
          className: 'Channel',
          id: { value: channelId },
          accessHash: { value: '1' },
          title: innerMockData.channels[0].title,
          verified: true,
          scam: true,
          photo: {
            CONSTRUCTOR_ID: 935395612,
            className: 'ChatPhotoEmpty',
          },
          date: 1,
        },
      },
      users: {},
      documents: {},
      stickerSets: {},
      photos: {},
      webDocuments: {},
      commonBoxState: {
        seq: 1,
        date: 1,
        pts: 1,
        qts: 1,
      },
      channelPtsById: {
        [channelId]: 1,
      },
    };

    gramJs.updateFullLocalDb(seededLocalDb);

    await gramJs.initApi(
      () => undefined,
      {
        userAgent: navigator.userAgent,
        platform: navigator.platform || 'Unknown platform',
        sessionData: undefined,
        isWebmSupported: true,
        maxBufferSize: 1024 * 1024,
        webAuthToken: undefined,
        dcId: undefined,
        mockScenario: 'default',
        shouldAllowHttpTransport: false,
        shouldForceHttpTransport: false,
        shouldDebugExportedSenders: false,
        langCode: 'en',
        isTestServerRequested: true,
        accountIds: [],
        hasPasskeySupport: false,
      },
    );

    for (let attempt = 0; attempt < innerRepeats; attempt += 1) {
      await gramJs.callApi('requestChannelDifference', channelId);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    if (!channelId) {
      throw new Error('Failed to compute seeded channel id');
    }

    return {
      channelId,
      channelPts: seededLocalDb.channelPtsById[channelId],
      localDbChatCount: Object.keys(seededLocalDb.chats).length,
    };
  }, { innerMockData: mockData, innerRepeats: repeats });
}

async function flushRuntimeReporter(page) {
  await page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return;
    }

    chunkGlobal.push([[Symbol('long-running-services-targeted-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

const browser = await chromium.launch({ headless: isHeadless });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const relaySessionIds = new Set();
  const relayStatuses = [];
  let relayPostCount = 0;

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

  const targetUrl = await waitForApp(page);
  const seededState = await driveSeededChannelDifference(page, defaultMockData, channelDifferenceRepeats);

  await flushRuntimeReporter(page);
  await page.waitForTimeout(500);

  const finalState = await page.evaluate(() => {
    const global = window.getGlobal?.();
    return {
      authState: global?.auth?.state,
      connectionState: global?.connectionState,
      currentUserId: global?.currentUserId,
      chatCount: global?.chats?.byId ? Object.keys(global.chats.byId).length : 0,
    };
  });

  console.log(JSON.stringify({
    targetUrl,
    scenario,
    seededState,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayStatuses,
    finalState,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
