import { access, cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const baseUrl = process.env.LONG_RUNNING_URL || 'http://localhost:1234/';
const storageStatePath = process.env.LONG_RUNNING_STORAGE_STATE || 'tests/playwright/.auth/session.json';
const userDataDir = process.env.LONG_RUNNING_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev';
const runtimeUserDataDir = process.env.LONG_RUNNING_RUNTIME_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev.runtime';
const timeoutMs = Number(process.env.LONG_RUNNING_TIMEOUT_MS || 60_000);
const settleMs = Number(process.env.LONG_RUNNING_SETTLE_MS || 4_000);
const offlineMs = Number(process.env.LONG_RUNNING_OFFLINE_MS || 3_000);
const channelDifferenceRepeats = Number(process.env.LONG_RUNNING_CHANNEL_DIFFERENCE_REPEATS || 3);
const channelCandidateLimit = Number(process.env.LONG_RUNNING_CHANNEL_CANDIDATE_LIMIT || 12);
const isHeadless = process.env.LONG_RUNNING_HEADLESS !== '0';
const preferredChannelId = process.env.LONG_RUNNING_CHANNEL_ID;
const shouldEnableDebugFlags = process.env.LONG_RUNNING_ENABLE_DEBUG_FLAGS === '1';
let usePersistentProfile = false;

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

async function ensureStorageState() {
  try {
    await access(userDataDir);
    usePersistentProfile = true;
    return;
  } catch {
    usePersistentProfile = false;
  }

  try {
    await access(storageStatePath);
  } catch {
    console.error(`[long-running-services] Missing storage state: ${storageStatePath}`);
    process.exit(1);
  }
}

function shouldCopyProfilePath(sourceRoot, candidatePath) {
  const relativePath = candidatePath.slice(sourceRoot.length).replace(/^\\+|^\/+/, '');
  const entryName = basename(candidatePath);

  if (!relativePath) {
    return true;
  }

  if (/^Singleton/i.test(entryName) || /^lockfile$/i.test(entryName) || /\.lock$/i.test(entryName)) {
    return false;
  }

  if (/^(Crashpad|BrowserMetrics)$/i.test(entryName)) {
    return false;
  }

  return true;
}

async function prepareRuntimeUserDataDir() {
  const sourceRoot = resolve(userDataDir);
  const targetRoot = resolve(`${runtimeUserDataDir}-${Date.now()}-${process.pid}`);

  await mkdir(dirname(targetRoot), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => shouldCopyProfilePath(sourceRoot, sourcePath),
  });

  return targetRoot;
}

async function waitForApp(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
  await page.waitForFunction(
    () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
    { timeout: timeoutMs },
  );

  const startedAt = Date.now();
  let lastSnapshot;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = await page.evaluate(() => {
      const global = window.getGlobal?.();
      const legacyUserAuth = localStorage.getItem('user_auth');
      const account1 = localStorage.getItem('account1');
      const dc = localStorage.getItem('dc');
      const dc1 = localStorage.getItem('dc1_auth_key');
      const dc2 = localStorage.getItem('dc2_auth_key');

      return {
        authState: global?.auth?.state,
        connectionState: global?.connectionState,
        currentUserId: global?.currentUserId,
        chatCount: global?.chats?.byId ? Object.keys(global.chats.byId).length : 0,
        hasLegacyUserAuth: Boolean(legacyUserAuth),
        hasAccount1: Boolean(account1),
        hasDc: Boolean(dc),
        hasAuthKeys: Boolean(dc1 || dc2),
      };
    });

    if (lastSnapshot.authState === 'authorizationStateReady' && lastSnapshot.currentUserId && lastSnapshot.chatCount) {
      await page.waitForTimeout(settleMs);
      return;
    }

    if (lastSnapshot.hasLegacyUserAuth && lastSnapshot.hasDc && lastSnapshot.hasAuthKeys) {
      await page.waitForTimeout(settleMs);
      return;
    }

    if (lastSnapshot.authState === 'authorizationStateWaitQrCode') {
      throw new Error([
        'Playwright storage state is not authorized for ordinary dev.',
        `Current file: ${storageStatePath}`,
        'Refresh tests/playwright/.auth/session.json in the IDE browser, then run npm run auth:save-session.',
      ].join(' '));
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`authorized session not ready: ${JSON.stringify(lastSnapshot)}`);
}

async function listChannelCandidates(page, limit = 12) {
  return page.evaluate((innerLimit) => {
    const global = window.getGlobal();

    return Object.values(global?.chats?.byId || {})
      .filter((chat) => (
        (chat.type === 'chatTypeChannel' || chat.type === 'chatTypeSuperGroup')
        && !chat.isForbidden
        && !chat.isRestricted
      ))
      .sort((left, right) => (right.membersCount || 0) - (left.membersCount || 0))
      .slice(0, innerLimit)
      .map((chat) => ({
        id: chat.id,
        title: chat.title,
        type: chat.type,
        membersCount: chat.membersCount,
        hasUsername: chat.hasUsername,
        isForum: chat.isForum,
      }));
  }, limit);
}

function pickCandidate(candidates) {
  if (preferredChannelId) {
    return candidates.find((candidate) => candidate.id === preferredChannelId);
  }

  return candidates.find((candidate) => candidate.hasUsername) || candidates[0];
}

async function enableDebugFlags(page) {
  if (!shouldEnableDebugFlags) {
    return;
  }

  await page.evaluate(() => {
    const actions = window.getActions();
    actions.setSharedSettingOption({ shouldCollectDebugLogs: true });
    actions.setSharedSettingOption({ shouldDebugExportedSenders: true });
    actions.updateShouldEnableDebugLog();
    actions.updateShouldDebugExportedSenders();
  });
}

async function readRuntimeState(page) {
  return page.evaluate(() => {
    const global = window.getGlobal?.();
    return {
      authState: global?.auth?.state,
      connectionState: global?.connectionState,
      currentUserId: global?.currentUserId,
      chatCount: global?.chats?.byId ? Object.keys(global.chats.byId).length : 0,
    };
  });
}

async function requestWorkerHealthCheck(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function requestChannelDifference(page, chatId) {
  await page.evaluate((innerChatId) => {
    window.getActions().requestChannelDifference({ chatId: innerChatId });
  }, chatId);
}

async function triggerUpdateManagerDifference(page, chatId) {
  await page.evaluate(async (innerChatId) => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      throw new Error('webpack runtime is unavailable');
    }

    chunkGlobal.push([[Symbol('long-running-services')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const clientMethodsId = Object.keys(requireFn.m).find((key) => key.endsWith('/src/api/gramjs/methods/client.ts'));
    if (!clientMethodsId) {
      return;
    }

    const clientMethods = requireFn(clientMethodsId);
    await clientMethods.getDifference();

    if (innerChatId) {
      clientMethods.requestChannelDifference(innerChatId);
    }
  }, chatId);
}

async function flushRuntimeReporter(page) {
  await page.evaluate(async () => {
    const chunkGlobal = window.webpackChunktelegram_t;
    let requireFn;

    if (!chunkGlobal?.push) {
      return;
    }

    chunkGlobal.push([[Symbol('long-running-services-flush')], {}, (innerRequireFn) => {
      requireFn = innerRequireFn;
    }]);

    const runtimeCoreId = Object.keys(requireFn.m).find((key) => key.endsWith('graph/packages/runtime-core/src/index.js'));
    if (!runtimeCoreId) {
      return;
    }

    await requireFn(runtimeCoreId).RuntimeReporter.flush();
  });
}

let browser;
let context;
let runtimeProfilePath;

try {
  await ensureStorageState();

  if (usePersistentProfile) {
    runtimeProfilePath = await prepareRuntimeUserDataDir();
    context = await chromium.launchPersistentContext(runtimeProfilePath, { headless: isHeadless });
  } else {
    browser = await chromium.launch({ headless: isHeadless });
    context = await browser.newContext({ storageState: storageStatePath });
  }

  const page = context.pages()[0] || await context.newPage();
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

  await waitForApp(page);

  const initialState = await readRuntimeState(page);
  const candidates = await listChannelCandidates(page, channelCandidateLimit);
  const selectedCandidate = pickCandidate(candidates);
  const chosenCandidates = selectedCandidate
    ? [selectedCandidate, ...candidates.filter((candidate) => candidate.id !== selectedCandidate.id)]
    : candidates;

  await enableDebugFlags(page);
  await requestWorkerHealthCheck(page);

  await context.setOffline(true);
  await page.waitForTimeout(offlineMs);
  await context.setOffline(false);
  await page.waitForTimeout(settleMs);

  await triggerUpdateManagerDifference(page, selectedCandidate?.id);
  await page.waitForTimeout(settleMs);

  for (const candidate of chosenCandidates) {
    for (let attempt = 0; attempt < channelDifferenceRepeats; attempt += 1) {
      await requestChannelDifference(page, candidate.id);
      await page.waitForTimeout(settleMs);
    }
  }

  await flushRuntimeReporter(page);
  await page.waitForTimeout(500);

  const finalState = await readRuntimeState(page);

  console.log(JSON.stringify({
    baseUrl,
    selectedCandidate,
    candidateCount: candidates.length,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayStatuses,
    initialState,
    finalState,
  }, null, 2));

} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[long-running-services] FAIL ${message}`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();

  if (runtimeProfilePath) {
    await rm(runtimeProfilePath, { recursive: true, force: true });
  }
}
