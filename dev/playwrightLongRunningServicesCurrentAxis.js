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
const channelCandidateLimit = Number(process.env.LONG_RUNNING_CHANNEL_CANDIDATE_LIMIT || 6);
const closeTimeoutMs = Number(process.env.LONG_RUNNING_CLOSE_TIMEOUT_MS || 5_000);
const isHeadless = process.env.LONG_RUNNING_HEADLESS !== '0';
const preferredChannelId = process.env.LONG_RUNNING_CHANNEL_ID;
const shouldEnableDebugFlags = process.env.LONG_RUNNING_ENABLE_DEBUG_FLAGS === '1';
let usePersistentProfile = false;

let forcedExitTimer;

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
  await page.waitForFunction(() => {
    const global = window.getGlobal?.();
    return Boolean(
      global?.auth?.state
      && global?.connectionState
      && global?.currentUserId
      && global?.chats?.byId
      && Object.keys(global.chats.byId).length,
    );
  }, { timeout: timeoutMs });
  await page.waitForTimeout(settleMs);
}

async function listChannelCandidates(page, limit = 12) {
  return page.evaluate((innerLimit) => {
    const global = window.getGlobal();

    return Object.values(global.chats.byId)
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

async function triggerReconnect(page, context) {
  await requestWorkerHealthCheck(page);
  await context.setOffline(true);
  await page.waitForTimeout(offlineMs);
  await context.setOffline(false);
  await page.waitForTimeout(settleMs);
}

function createTimeoutError(stepName, timeoutMs) {
  return new Error(`[long-running-services-current-axis] ${stepName} timed out after ${timeoutMs}ms`);
}

async function withTimeout(promise, timeoutMs, stepName) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(createTimeoutError(stepName, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function scheduleForcedExit() {
  forcedExitTimer = setTimeout(() => {
    process.exit(process.exitCode || 0);
  }, 0);
}

function clearForcedExit() {
  if (forcedExitTimer) {
    clearTimeout(forcedExitTimer);
    forcedExitTimer = undefined;
  }
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
  const page = await context.newPage();

  await waitForApp(page);

  const candidates = await listChannelCandidates(page, channelCandidateLimit);
  const selectedCandidate = pickCandidate(candidates);
  const chosenCandidates = selectedCandidate
    ? [selectedCandidate, ...candidates.filter((candidate) => candidate.id !== selectedCandidate.id)]
    : candidates;

  await enableDebugFlags(page);
  await triggerReconnect(page, context);

  for (const candidate of chosenCandidates) {
    for (let attempt = 0; attempt < channelDifferenceRepeats; attempt += 1) {
      await requestChannelDifference(page, candidate.id);
      await page.waitForTimeout(settleMs);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[long-running-services-current-axis] FAIL ${message}`);
  process.exitCode = 1;
} finally {
  try {
    if (context) {
      await withTimeout(context.close(), closeTimeoutMs, 'context.close()');
    }
  } catch {
    // Ignore close timeout here and continue with browser shutdown.
  }

  try {
    if (browser) {
      await withTimeout(browser.close(), closeTimeoutMs, 'browser.close()');
    }
  } catch {
    // Ignore close timeout here and force process exit below.
  }

  if (runtimeProfilePath) {
    await rm(runtimeProfilePath, { recursive: true, force: true });
  }

  scheduleForcedExit();
}
