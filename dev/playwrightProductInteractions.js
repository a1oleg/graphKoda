import { chromium } from '@playwright/test';

const baseUrl = process.env.PRODUCT_INTERACTIONS_BASE_URL || 'http://localhost:1235/';
const scenario = process.env.PRODUCT_INTERACTIONS_SCENARIO || 'default';
const timeoutMs = Number(process.env.PRODUCT_INTERACTIONS_TIMEOUT_MS || 45_000);
const settleMs = Number(process.env.PRODUCT_INTERACTIONS_SETTLE_MS || 3_000);
const isHeadless = process.env.PRODUCT_INTERACTION_HEADLESS !== '0' && process.env.PRODUCT_INTERACTIONS_HEADLESS !== '0';
const relayUrl = process.env.RUNTIME_RELAY_URL || 'http://127.0.0.1:8787/graph-relay';
const debugTraceLimit = Number(process.env.PRODUCT_INTERACTIONS_DEBUG_TRACE_LIMIT || 40);
const interactionTarget = process.env.PRODUCT_INTERACTION_TARGET || 'all';

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
    'canSendReaction',
    'sendPollVote',
    'sendStoryReaction',
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

function summarizeRelayPayload(rows) {
  const labelCounts = {};
  const kindCounts = {};
  const samples = [];

  if (!Array.isArray(rows)) {
    return { labelCounts, kindCounts, samples };
  }

  rows.forEach((row) => {
    const labels = Array.isArray(row?.labels)
      ? row.labels
      : (Array.isArray(row?.entities?.[0]?.labels) ? row.entities[0].labels : []);
    const kind = row?.nodeProps?.kind || row?.meta?.kind || row?.entities?.[0]?.props?.kind;
    const labelKey = labels.join('|') || '(none)';

    labelCounts[labelKey] = (labelCounts[labelKey] || 0) + 1;
    if (kind) {
      kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    }

    if (samples.length < 8) {
      const props = row?.nodeProps || row?.entities?.[0]?.props || {};
      samples.push({
        labels,
        kind,
        fnName: props.fnName,
        filePath: props.filePath,
        fnStartLine: props.fnStartLine,
        staticFnStartLine: props.staticFnStartLine,
        decisionId: props.decisionId,
        predicateId: props.predicateId,
        branchId: props.branchId,
      });
    }
  });

  return { labelCounts, kindCounts, samples };
}

async function withStageTimeout(stage, promise, timeout = timeoutMs) {
  let timeoutId;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${stage} timed out after ${timeout}ms`));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
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
      && (
        global.auth?.state === 'authorizationStateReady'
        || global.auth?.state === 'authorizationStateWaitQrCode'
      )
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

    chunkGlobal.push([[Symbol('product-interactions-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

async function driveProductInteractions(page) {
  return page.evaluate(async ({ innerRelayUrl, currentInteractionTarget }) => {
    const interactionTimeoutMs = 5_000;
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      throw new Error('webpack runtime is unavailable');
    }

    chunkGlobal.push([[Symbol('product-interactions-targeted')], {}, (innerRequireFn) => {
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
    const getModuleByExport = (exportName, fragment) => {
      const candidateIds = fragment
        ? moduleIds.filter((key) => key.toLowerCase().includes(fragment))
        : moduleIds;

      for (const moduleId of candidateIds) {
        try {
          const resolvedModule = requireFn(moduleId);
          if (typeof resolvedModule?.[exportName] === 'function') {
            return resolvedModule;
          }
        } catch {
          // Ignore and continue.
        }
      }

      for (const moduleId of moduleIds) {
        if (candidateIds.includes(moduleId)) {
          continue;
        }

        try {
          const resolvedModule = requireFn(moduleId);
          if (typeof resolvedModule?.[exportName] === 'function') {
            return resolvedModule;
          }
        } catch {
          // Ignore and continue.
        }
      }

      return undefined;
    };

    const global = window.getGlobal();
    const actions = window.getActions();
    const capturedDialogs = [];
    const originalShowDialog = actions.showDialog;

    if (typeof originalShowDialog === 'function') {
      actions.showDialog = (payload) => {
        capturedDialogs.push(payload);
        return originalShowDialog(payload);
      };
    }

    const chatsById = global?.chats?.byId || {};
    const firstChat = Object.values(chatsById).find(Boolean);
    const firstPeer = firstChat || Object.values(global?.users?.byId || {}).find(Boolean);
    const syntheticChat = firstChat || {
      id: '-1009000000002',
      accessHash: '1',
      title: 'Graph Poll Probe Chat',
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
    const syntheticPeer = firstPeer || {
      id: '9000000002',
      accessHash: '1',
      type: 'chatTypePrivate',
      firstName: 'Graph',
      lastName: 'Probe',
    };
    const syntheticStoryId = 1;

    if (!firstPeer) {
      global.users.byId[syntheticPeer.id] = syntheticPeer;
    }

    global.stories.byPeerId[syntheticPeer.id] = global.stories.byPeerId[syntheticPeer.id] || {
      byId: {},
      orderedIds: [],
      profileIds: [],
      archiveIds: [],
    };

    const peerStories = global.stories.byPeerId[syntheticPeer.id];
    peerStories.byId[syntheticStoryId] = peerStories.byId[syntheticStoryId] || {
      id: syntheticStoryId,
      content: {},
      views: {
        reactions: [],
        reactionsCount: 0,
      },
    };
    peerStories.orderedIds = peerStories.orderedIds?.includes(syntheticStoryId)
      ? peerStories.orderedIds
      : [...(peerStories.orderedIds || []), syntheticStoryId];

    const helpersReactions = getModule([
      './src/global/helpers/reactions.ts',
      './src/global/helpers/reactions.js',
    ], '/src/global/helpers/reactions.');
    const gramJs = getModule([
      './src/api/gramjs/index.ts',
      './src/api/gramjs/index.js',
    ], '/src/api/gramjs/index.');
    const gramJsMessages = getModuleByExport('sendPollVote', '/src/api/gramjs/methods/messages.');
    const gramJsStories = getModuleByExport('sendStoryReaction', '/src/api/gramjs/methods/stories.');
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

      try {
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
      } catch (error) {
        return {
          posted: envelopes.length,
          sampleEnvelope: envelopes[0],
          error: String(error?.message || error),
        };
      }
    };
    const invokeGramJsMethod = (fnName, args) => {
      if (typeof gramJs?.callApi === 'function') {
        return gramJs.callApi(fnName, args);
      }

      return gramJs.callApiLocal(fnName, args);
    };
    const withInteractionTimeout = async (label, callback) => {
      return Promise.race([
        callback(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${label} timed out after ${interactionTimeoutMs}ms`));
          }, interactionTimeoutMs);
        }),
      ]);
    };

    let reactionAllowed;
    let canSendReactionEvents = [];
    let canSendReactionRelay;

    if (currentInteractionTarget === 'all' || currentInteractionTarget === 'reaction') {
      const canSendReactionStart = getEventCount();
      reactionAllowed = helpersReactions.canSendReaction(
        { type: 'emoji', emoticon: 'рџ‘Ќ' },
        { type: 'all' },
      );
      const canSendReactionRawEvents = getRawEventDelta(canSendReactionStart);
      canSendReactionEvents = summarizeEventDelta(canSendReactionRawEvents);
      canSendReactionRelay = await relayEventDelta(canSendReactionRawEvents);
    }

    let storyReactionError;
    let sendStoryReactionRelay;
    let sendStoryReactionEvents = [];

    if (currentInteractionTarget === 'all' || currentInteractionTarget === 'story') {
      const sendStoryReactionStart = getEventCount();

      try {
        await withInteractionTimeout('sendStoryReaction', () => {
          if (typeof gramJsStories?.sendStoryReaction === 'function') {
            return gramJsStories.sendStoryReaction({
              peer: syntheticPeer,
              storyId: syntheticStoryId,
              reaction: { type: 'emoji', emoticon: 'рџ”Ґ' },
              shouldAddToRecent: true,
            });
          }

          return invokeGramJsMethod('sendStoryReaction', {
            peer: syntheticPeer,
            storyId: syntheticStoryId,
            reaction: { type: 'emoji', emoticon: 'рџ”Ґ' },
            shouldAddToRecent: true,
          });
        });
      } catch (error) {
        storyReactionError = String(error?.message || error);
      }

      const sendStoryReactionRawEvents = getRawEventDelta(sendStoryReactionStart);
      sendStoryReactionEvents = summarizeEventDelta(sendStoryReactionRawEvents);
      sendStoryReactionRelay = await relayEventDelta(sendStoryReactionRawEvents);
    }

    let pollVoteError;
    let sendPollVoteRelay;
    let sendPollVoteEvents = [];

    if (currentInteractionTarget === 'all' || currentInteractionTarget === 'poll') {
      const sendPollVoteStart = getEventCount();

      try {
        await withInteractionTimeout('sendPollVote', () => {
          if (typeof gramJsMessages?.sendPollVote === 'function') {
            return gramJsMessages.sendPollVote({ chat: syntheticChat, messageId: 1, options: [] });
          }

          return invokeGramJsMethod('sendPollVote', { chat: syntheticChat, messageId: 1, options: [] });
        });
      } catch (error) {
        pollVoteError = String(error?.message || error);
      }

      const sendPollVoteRawEvents = getRawEventDelta(sendPollVoteStart);
      sendPollVoteEvents = summarizeEventDelta(sendPollVoteRawEvents);
      sendPollVoteRelay = await relayEventDelta(sendPollVoteRawEvents);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const recentEvents = runtimeCore.RuntimeReporter.instance?.events?.slice(-40).map((event) => ({
      kind: event.kind,
      fnName: event.context?.fnName || event.fnName,
      filePath: event.options?.filePath,
      fnStartLine: event.options?.fnStartLine,
      staticFnStartLine: event.options?.staticFnStartLine,
    })) || [];

    return {
      interactionTarget: currentInteractionTarget,
      firstChatId: syntheticChat?.id,
      firstPeerId: syntheticPeer?.id,
      reactionAllowed,
      canSendReactionEvents,
      canSendReactionRelay,
      pollVoteError,
      sendPollVoteEvents,
      sendPollVoteRelay,
      storyReactionError,
      sendStoryReactionEvents,
      sendStoryReactionRelay,
      capturedDialogs,
      recentEvents,
    };
  }, {
    innerRelayUrl: relayUrl,
    currentInteractionTarget: interactionTarget,
  });
}

const browser = await chromium.launch({ headless: isHeadless });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const relaySessionIds = new Set();
  const relayAnchorRows = [];
  const relayStatuses = [];
  const relayPayloadSummaries = [];
  const debugTrace = [];
  let relayPostCount = 0;

  const pushTrace = (event) => {
    if (debugTrace.length >= debugTraceLimit) {
      debugTrace.shift();
    }

    debugTrace.push({
      ts: new Date().toISOString(),
      ...event,
    });
  };

  page.on('domcontentloaded', () => {
    pushTrace({ type: 'page.domcontentloaded', url: page.url() });
  });

  page.on('load', () => {
    pushTrace({ type: 'page.load', url: page.url() });
  });

  page.on('framenavigated', (frame) => {
    if (!frame.parentFrame()) {
      pushTrace({ type: 'page.framenavigated', url: frame.url() });
    }
  });

  page.on('pageerror', (error) => {
    pushTrace({ type: 'page.error', message: error.message });
  });

  await page.route('**/graph-relay', async (route) => {
    const request = route.request();
    const postData = request.postData();

    relayPostCount += 1;

    if (postData) {
      try {
        const rows = JSON.parse(postData);
        extractSessionIdsFromPayload(rows).forEach((sessionId) => relaySessionIds.add(sessionId));
        if (relayAnchorRows.length < 200) {
          relayAnchorRows.push(...extractAnchorRows(rows));
        }
        if (relayPayloadSummaries.length < 5) {
          relayPayloadSummaries.push(summarizeRelayPayload(rows));
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

  let targetUrl;
  let probeState;
  let flushError;
  let failure;

  try {
    pushTrace({ type: 'stage.start', stage: 'waitForApp' });
    targetUrl = await withStageTimeout('waitForApp', waitForApp(page));
    pushTrace({ type: 'stage.done', stage: 'waitForApp', url: page.url() });

    pushTrace({ type: 'stage.start', stage: 'driveProductInteractions', url: page.url() });
    probeState = await withStageTimeout('driveProductInteractions', driveProductInteractions(page));
    pushTrace({ type: 'stage.done', stage: 'driveProductInteractions', url: page.url() });

    pushTrace({ type: 'stage.start', stage: 'flushRuntimeReporter', url: page.url() });
    await withStageTimeout('flushRuntimeReporter', flushRuntimeReporter(page));
    pushTrace({ type: 'stage.done', stage: 'flushRuntimeReporter', url: page.url() });
  } catch (error) {
    failure = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      url: page.url(),
    };
    pushTrace({ type: 'stage.error', stage: 'run', ...failure });
  }

  try {
    await page.waitForTimeout(3000);
  } catch (error) {
    flushError = error instanceof Error ? error.message : String(error);
    pushTrace({ type: 'stage.error', stage: 'postWait', message: flushError, url: page.url() });
  }

  console.log(JSON.stringify({
    targetUrl,
    scenario,
    probeState,
    failure,
    flushError,
    finalPageUrl: page.url(),
    debugTrace,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayAnchorRows,
    relayPayloadSummaries,
    relayStatuses,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}

