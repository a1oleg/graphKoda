import { chromium } from '@playwright/test';

const baseUrl = process.env.PRODUCT_OUTCOMES_BASE_URL || 'http://localhost:1235/';
const scenario = process.env.PRODUCT_OUTCOMES_SCENARIO || 'default';
const timeoutMs = Number(process.env.PRODUCT_OUTCOMES_TIMEOUT_MS || 45_000);
const settleMs = Number(process.env.PRODUCT_OUTCOMES_SETTLE_MS || 3_000);
const isHeadless = process.env.PRODUCT_OUTCOMES_HEADLESS !== '0';
const relayUrl = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';

function buildTargetUrl() {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  params.set('mockScenario', scenario);
  params.set('tgWebAuthTest', '1');
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

function extractAnchorRows(rows) {
  const targetNames = new Set([
    'selectChatListType',
    'selectPaymentInputInvoice',
    'selectStarsPayment',
    'getRequestInputInvoice',
    'getCanPostInChat',
    'getHasAdminRight',
    'isUserRightBanned',
  ]);

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const props = row?.nodeProps || row?.entities?.[0]?.props || {};
      const labels = row?.labels || row?.entities?.[0]?.labels || [];
      return {
        labels,
        kind: props.kind,
        fnName: props.fnName,
        filePath: props.filePath,
        fnStartLine: props.fnStartLine,
        staticFnStartLine: props.staticFnStartLine,
      };
    })
    .filter((row) => row.fnName && targetNames.has(row.fnName));
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

async function flushRuntimeReporter(page) {
  await page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return;
    }

    chunkGlobal.push([[Symbol('product-outcomes-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

async function driveProductOutcomes(page) {
  return page.evaluate(async ({ innerRelayUrl }) => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      throw new Error('webpack runtime is unavailable');
    }

    chunkGlobal.push([[Symbol('product-outcomes-targeted')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const moduleIds = Object.keys(requireFn.m);
    const findModuleId = (fragment) => moduleIds.find((key) => key.toLowerCase().includes(fragment));
    const tryRequire = (candidates) => {
      for (const candidate of candidates) {
        try {
          return requireFn(candidate);
        } catch {
          // Ignore and continue.
        }
      }

      return undefined;
    };

    const getModule = (candidates, fragment) => {
      const direct = tryRequire(candidates);
      if (direct) {
        return direct;
      }

      const resolvedId = findModuleId(fragment);
      if (!resolvedId) {
        throw new Error(`Unable to resolve module: ${fragment}`);
      }

      return requireFn(resolvedId);
    };

    const global = window.getGlobal();
    const actions = window.getActions();
    const chatsById = global?.chats?.byId || {};
    const firstChat = Object.values(chatsById).find(Boolean);
    const syntheticChat = firstChat || {
      id: '-1009000000001',
      accessHash: '1',
      title: 'Graph Product Probe Chat',
      type: 'chatTypeChannel',
      folderId: 0,
      isCreator: false,
      isForbidden: false,
      isNotJoined: false,
      isMonoforum: false,
      adminRights: { postMessages: true },
      defaultBannedRights: {},
      currentUserBannedRights: {},
    };

    if (!firstChat) {
      global.chats.byId[syntheticChat.id] = syntheticChat;
      global.chats.listIds = global.chats.listIds || {};
      global.chats.listIds.active = [...(global.chats.listIds.active || []), syntheticChat.id];
      global.chats.totalCount = global.chats.totalCount || { all: 0, archived: 0 };
      global.chats.totalCount.all = Math.max(global.chats.totalCount.all || 0, 1);
    }

    const firstChatId = syntheticChat.id;

    const selectorsChats = getModule([
      './src/global/selectors/chats.ts',
      './src/global/selectors/chats.js',
    ], '/src/global/selectors/chats.');
    const selectorsPayments = getModule([
      './src/global/selectors/payments.ts',
      './src/global/selectors/payments.js',
    ], '/src/global/selectors/payments.');
    const helpersPayments = getModule([
      './src/global/helpers/payments.ts',
      './src/global/helpers/payments.js',
    ], '/src/global/helpers/payments.');
    const helpersChats = getModule([
      './src/global/helpers/chats.ts',
      './src/global/helpers/chats.js',
    ], '/src/global/helpers/chats.');
    const runtimeCore = getModule([
      './graph/packages/runtime-core/src/index.js',
    ], 'graph/packages/runtime-core/src/index.js');
    const graphEnvelope = getModule([
      './graph/packages/runtime-core/src/graphEnvelope.js',
    ], 'graph/packages/runtime-core/src/graphEnvelope.js');
    const getEventCount = () => runtimeCore.RuntimeReporter.instance?.events?.length || 0;
    const getRawEventDelta = (startCount) => runtimeCore.RuntimeReporter.instance?.events?.slice(startCount) || [];
    const summarizeEventDelta = (events) => events.map((event) => ({
      kind: event.kind,
      fnName: event.context?.fnName || event.fnName,
      filePath: event.options?.filePath,
      fnStartLine: event.options?.fnStartLine,
      staticFnStartLine: event.options?.staticFnStartLine,
    }));
    const relayEventDelta = async (events) => {
      const envelopes = graphEnvelope.buildRuntimeEnvelopes(events);
      if (!envelopes.length) {
        return { posted: 0, sampleEnvelope: undefined };
      }

      const response = await fetch(innerRelayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(envelopes),
      });

      return {
        posted: envelopes.length,
        status: response.status,
        sampleEnvelope: envelopes[0],
      };
    };

    actions.showNotification({
      message: 'graph product notification probe',
    });

    const selectChatListTypeStart = getEventCount();
    const chatListType = firstChatId ? selectorsChats.selectChatListType(global, firstChatId) : undefined;
    const selectChatListTypeRawEvents = getRawEventDelta(selectChatListTypeStart);
    const selectChatListTypeEvents = summarizeEventDelta(selectChatListTypeRawEvents);
    const selectChatListTypeRelay = await relayEventDelta(selectChatListTypeRawEvents);

    const selectPaymentInputInvoiceStart = getEventCount();
    const paymentInputInvoice = selectorsPayments.selectPaymentInputInvoice(global);
    const selectPaymentInputInvoiceRawEvents = getRawEventDelta(selectPaymentInputInvoiceStart);
    const selectPaymentInputInvoiceEvents = summarizeEventDelta(selectPaymentInputInvoiceRawEvents);
    const selectPaymentInputInvoiceRelay = await relayEventDelta(selectPaymentInputInvoiceRawEvents);

    const selectStarsPaymentStart = getEventCount();
    const starsPayment = selectorsPayments.selectStarsPayment(global);
    const selectStarsPaymentRawEvents = getRawEventDelta(selectStarsPaymentStart);
    const selectStarsPaymentEvents = summarizeEventDelta(selectStarsPaymentRawEvents);
    const selectStarsPaymentRelay = await relayEventDelta(selectStarsPaymentRawEvents);

    const getRequestInputInvoiceStart = getEventCount();
    const requestInputInvoice = helpersPayments.getRequestInputInvoice(global, {
      type: 'message',
      chatId: syntheticChat.id,
      messageId: 1,
    });
    const getRequestInputInvoiceRawEvents = getRawEventDelta(getRequestInputInvoiceStart);
    const getRequestInputInvoiceEvents = summarizeEventDelta(getRequestInputInvoiceRawEvents);
    const getRequestInputInvoiceRelay = await relayEventDelta(getRequestInputInvoiceRawEvents);

    const getCanPostInChatStart = getEventCount();
    const canPostInChat = helpersChats.getCanPostInChat(syntheticChat);
    const getCanPostInChatRawEvents = getRawEventDelta(getCanPostInChatStart);
    const getCanPostInChatEvents = summarizeEventDelta(getCanPostInChatRawEvents);
    const getCanPostInChatRelay = await relayEventDelta(getCanPostInChatRawEvents);

    const getHasAdminRightStart = getEventCount();
    const hasAdminRight = helpersChats.getHasAdminRight(syntheticChat, 'postMessages');
    const getHasAdminRightRawEvents = getRawEventDelta(getHasAdminRightStart);
    const getHasAdminRightEvents = summarizeEventDelta(getHasAdminRightRawEvents);
    const getHasAdminRightRelay = await relayEventDelta(getHasAdminRightRawEvents);

    const isUserRightBannedStart = getEventCount();
    const isSendMessagesBanned = helpersChats.isUserRightBanned(syntheticChat, 'sendMessages');
    const isUserRightBannedRawEvents = getRawEventDelta(isUserRightBannedStart);
    const isUserRightBannedEvents = summarizeEventDelta(isUserRightBannedRawEvents);
    const isUserRightBannedRelay = await relayEventDelta(isUserRightBannedRawEvents);

    await new Promise((resolve) => setTimeout(resolve, 500));

    return {
      firstChatId,
      chatListType,
      selectChatListTypeEvents,
      selectChatListTypeRelay,
      paymentInputInvoiceType: paymentInputInvoice?.type,
      selectPaymentInputInvoiceEvents,
      selectPaymentInputInvoiceRelay,
      starsPaymentType: starsPayment?.type,
      selectStarsPaymentEvents,
      selectStarsPaymentRelay,
      requestInputInvoiceType: requestInputInvoice?.type,
      getRequestInputInvoiceEvents,
      getRequestInputInvoiceRelay,
      canPostInChat,
      getCanPostInChatEvents,
      getCanPostInChatRelay,
      hasAdminRight,
      getHasAdminRightEvents,
      getHasAdminRightRelay,
      isSendMessagesBanned,
      isUserRightBannedEvents,
      isUserRightBannedRelay,
    };
  }, { innerRelayUrl: relayUrl });
}

const browser = await chromium.launch({ headless: isHeadless });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const relaySessionIds = new Set();
  const relayAnchorRows = [];
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
        if (relayAnchorRows.length < 50) {
          relayAnchorRows.push(...extractAnchorRows(rows));
        }
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
  const probeState = await driveProductOutcomes(page);
  await flushRuntimeReporter(page);
  await page.waitForTimeout(500);

  console.log(JSON.stringify({
    targetUrl,
    scenario,
    probeState,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayAnchorRows,
    relayStatuses,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
