import { access, cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const baseUrl = process.env.UI_VIEW_STRUCTURE_URL || 'http://localhost:1234/';
const storageStatePath = process.env.UI_VIEW_STRUCTURE_STORAGE_STATE || 'tests/playwright/.auth/session.json';
const userDataDir = process.env.UI_VIEW_STRUCTURE_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev';
const runtimeUserDataDir = process.env.UI_VIEW_STRUCTURE_RUNTIME_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev.runtime';
const timeoutMs = Number(process.env.UI_VIEW_STRUCTURE_TIMEOUT_MS || 60_000);
const settleMs = Number(process.env.UI_VIEW_STRUCTURE_SETTLE_MS || 1_500);
const closeTimeoutMs = Number(process.env.UI_VIEW_STRUCTURE_CLOSE_TIMEOUT_MS || 5_000);
const optionalTimeoutMs = Number(process.env.UI_VIEW_STRUCTURE_OPTIONAL_TIMEOUT_MS || 15_000);
const isHeadless = process.env.UI_VIEW_STRUCTURE_HEADLESS !== '0';
const isPersistentProfileHeadless = process.env.UI_VIEW_STRUCTURE_PERSISTENT_HEADLESS === '1';
const isVerboseLogging = process.env.UI_VIEW_STRUCTURE_VERBOSE === '1';

const LEFT_COLUMN_CHAT_LIST = 0;
const LEFT_COLUMN_SETTINGS = 2;
const SETTINGS_SCREEN_MAIN = 0;
const SETTINGS_SCREEN_NOTIFICATIONS = 2;
const SETTINGS_SCREEN_PRIVACY = 9;
const SETTINGS_MAIN_MENU_INDEX = 1;
const SETTINGS_PREMIUM_MENU_INDEX = 2;
const SETTINGS_ITEM_NOTIFICATIONS_INDEX = 2;
const SETTINGS_ITEM_PRIVACY_INDEX = 4;
const SETTINGS_ITEM_PREMIUM_INDEX = 0;
let forcedExitTimer;
let currentStep = 'bootstrap';
let usePersistentProfile = false;

function createBrowserEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GOOGLE_|NEO4J_|TELEGRAM_)/.test(name)),
  );
}

const browserEnv = createBrowserEnv();

function logVerbose(message) {
  if (!isVerboseLogging) {
    return;
  }

  console.error(`[ui-view-structure] ${message}`);
}

function traceStep(stepName) {
  currentStep = stepName;
  logVerbose(stepName);
}

async function ensureStorageState() {
  traceStep('ensure-storage-state');
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
    console.error(`[ui-view-structure] Missing storage state: ${storageStatePath}`);
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
  traceStep('prepare-runtime-user-data-dir');

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
  traceStep('wait-for-app');
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
        tabCount: global?.byTabId ? Object.keys(global.byTabId).length : 0,
        hasLegacyUserAuth: Boolean(legacyUserAuth),
        hasAccount1: Boolean(account1),
        hasDc: Boolean(dc),
        hasAuthKeys: Boolean(dc1 || dc2),
      };
    });

    if (lastSnapshot.authState === 'authorizationStateReady' && lastSnapshot.currentUserId) {
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
        'Refresh tests/playwright/.auth/session.json in the IDE browser, then run `npm run auth:save-session`.',
      ].join(' '));
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`authorized session not ready: ${JSON.stringify(lastSnapshot)}`);
}

async function clickLocator(locator, stepName, options = {}) {
  traceStep(stepName);
  await locator.waitFor({ state: 'visible', timeout: options.timeout ?? timeoutMs });

  if (options.programmatic) {
    await locator.evaluate((element) => {
      element.click();
    });
    return;
  }

  await locator.click({ timeout: options.timeout ?? timeoutMs, force: options.force });
}

async function invokeAction(page, actionName, payload, stepName) {
  traceStep(stepName);
  await page.evaluate(({ innerActionName, innerPayload }) => {
    const action = window.getActions?.()?.[innerActionName];

    if (typeof action !== 'function') {
      throw new Error(`Unknown action: ${innerActionName}`);
    }

    setTimeout(() => {
      action(innerPayload);
    }, 0);

    return true;
  }, { innerActionName: actionName, innerPayload: payload });
}

async function openSettingsFromMainMenu(page) {
  await clickLocator(page.locator('#LeftMainHeader .Button:visible').first(), 'open-main-menu');
  await clickLocator(
    page.locator('.DropdownMenu.main-menu .MenuItem:visible', {
      has: page.locator('.icon-settings'),
    }).first(),
    'open-settings-from-main-menu',
    { programmatic: true },
  );
}

async function listCandidates(page) {
  traceStep('list-candidates');
  return page.evaluate(() => {
    const global = window.getGlobal();

    const chats = Object.values(global.chats.byId || {});
    const visibleChats = chats.filter((chat) => !chat.isForbidden && !chat.isRestricted);
    const channelCandidate = visibleChats
      .filter((chat) => chat.type === 'chatTypeChannel' || chat.type === 'chatTypeSuperGroup')
      .sort((left, right) => (right.membersCount || 0) - (left.membersCount || 0))[0];
    const chatCandidate = visibleChats
      .filter((chat) => !chat.isSaved)
      .sort((left, right) => (right.lastMessage?.date || 0) - (left.lastMessage?.date || 0))[0];

    return {
      chatCandidate: chatCandidate ? {
        id: chatCandidate.id,
        title: chatCandidate.title,
        type: chatCandidate.type,
      } : undefined,
      channelCandidate: channelCandidate ? {
        id: channelCandidate.id,
        title: channelCandidate.title,
        type: channelCandidate.type,
      } : undefined,
    };
  });
}

async function readUiState(page) {
  traceStep('read-ui-state');
  let timer;

  try {
    return await Promise.race([
      page.evaluate(({ settingsContentKey }) => {
        const global = window.getGlobal();
        const tabIds = Object.keys(global.byTabId || {});
        const tabEntries = tabIds.map((tabId) => [tabId, global.byTabId[tabId]]);
        const activeEntry = tabEntries.find(([, tab]) => tab?.premiumModal?.isOpen)
          || tabEntries.find(([, tab]) => tab?.chatInfo?.isOpen)
          || tabEntries.find(([, tab]) => tab?.messageLists?.[0]?.chatId)
          || tabEntries.find(([, tab]) => tab?.leftColumn?.contentKey === settingsContentKey)
          || tabEntries[0];
        const [tabId, tab] = activeEntry || [];
        const currentMessageList = tab?.messageLists?.[0];

        return {
          tabId,
          leftColumnContentKey: tab?.leftColumn?.contentKey,
          settingsScreen: tab?.leftColumn?.settingsScreen,
          currentMessageListChatId: currentMessageList?.chatId,
          currentMessageListThreadId: currentMessageList?.threadId,
          currentMessageListType: currentMessageList?.type,
          chatInfo: {
            isOpen: Boolean(tab?.chatInfo?.isOpen),
            profileTab: tab?.chatInfo?.profileTab,
          },
          premiumModal: {
            isOpen: Boolean(tab?.premiumModal?.isOpen),
          },
          authState: global?.auth?.state,
          connectionState: global?.connectionState,
          currentUserId: global?.currentUserId,
          chatCount: global?.chats?.byId ? Object.keys(global.chats.byId).length : 0,
        };
      }, { settingsContentKey: LEFT_COLUMN_SETTINGS }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Timed out while reading UI state'));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForState(page, predicate, arg, errorMessage, customTimeoutMs = timeoutMs) {
  traceStep(`wait-for-state:${errorMessage}`);
  await page.waitForFunction(predicate, arg, { timeout: customTimeoutMs });
  await page.waitForTimeout(settleMs);
}

async function openSettingsMainSurface(page) {
  traceStep('open-settings-main-surface');
  await invokeAction(
    page,
    'openSettingsScreen',
    { screen: SETTINGS_SCREEN_MAIN },
    'open-settings-main-surface:action',
  );

  return waitForState(page, ({ expectedScreen, expectedLeftColumnContentKey }) => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => {
      return tab?.leftColumn?.contentKey === expectedLeftColumnContentKey
        && tab?.leftColumn?.settingsScreen === expectedScreen;
    });
  }, {
    expectedScreen: SETTINGS_SCREEN_MAIN,
    expectedLeftColumnContentKey: LEFT_COLUMN_SETTINGS,
  }, 'Failed to open settings main screen');
}

async function clickSettingsBack(page, expectedScreen, errorMessage) {
  await invokeAction(
    page,
    'openSettingsScreen',
    { screen: expectedScreen },
    `click-settings-back:${expectedScreen}`,
  );

  return waitForState(page, ({ innerExpectedScreen, expectedLeftColumnContentKey }) => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => {
      return tab?.leftColumn?.contentKey === expectedLeftColumnContentKey
        && tab?.leftColumn?.settingsScreen === innerExpectedScreen;
    });
  }, {
    innerExpectedScreen: expectedScreen,
    expectedLeftColumnContentKey: LEFT_COLUMN_SETTINGS,
  }, errorMessage);
}

async function openSettingsSurface(page, screen) {
  traceStep(`open-settings-surface:${screen === undefined ? 'main' : screen}`);
  const targetScreen = screen === undefined ? SETTINGS_SCREEN_MAIN : screen;

  if (targetScreen === SETTINGS_SCREEN_MAIN) {
    await openSettingsMainSurface(page);
  } else if (targetScreen === SETTINGS_SCREEN_NOTIFICATIONS) {
    await invokeAction(
      page,
      'openSettingsScreen',
      { screen: SETTINGS_SCREEN_NOTIFICATIONS },
      'open-settings-notifications-surface',
    );
  } else if (targetScreen === SETTINGS_SCREEN_PRIVACY) {
    await invokeAction(
      page,
      'openSettingsScreen',
      { screen: SETTINGS_SCREEN_PRIVACY },
      'open-settings-privacy-surface',
    );
  } else {
    throw new Error(`Unsupported settings screen for DOM navigation: ${String(targetScreen)}`);
  }

  return waitForState(page, ({ expectedScreen, expectedLeftColumnContentKey }) => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => {
      return tab?.leftColumn?.contentKey === expectedLeftColumnContentKey
        && tab?.leftColumn?.settingsScreen === expectedScreen;
    });
  }, {
    expectedScreen: targetScreen,
    expectedLeftColumnContentKey: LEFT_COLUMN_SETTINGS,
  }, `Failed to open settings screen ${String(targetScreen)}`);
}

async function openFirstChatSurface(page, targetChatId) {
  if (targetChatId) {
    await invokeAction(
      page,
      'openChat',
      { id: targetChatId, shouldReplaceHistory: true },
      'open-first-chat-surface:action',
    );
  } else {
    await clickLocator(
      page.locator('#LeftColumn .chat-list .ListItem-button:visible').first(),
      'open-first-chat-surface',
      { timeout: optionalTimeoutMs },
    );
  }

  await waitForState(page, (expectedChatId) => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => {
      const currentMessageList = tab?.messageLists?.[0];
      return expectedChatId
        ? currentMessageList?.chatId === expectedChatId
        : Boolean(currentMessageList?.chatId);
    });
  }, targetChatId, 'Failed to open first chat', optionalTimeoutMs);

  return readUiState(page);
}

async function openChatInfoSurface(page) {
  await clickLocator(page.locator('.MiddleHeader .ChatInfo:visible').first(), 'open-chat-info-surface', {
    timeout: optionalTimeoutMs,
  });

  return waitForState(page, () => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => Boolean(tab?.chatInfo?.isOpen));
  }, undefined, 'Failed to open chat info', optionalTimeoutMs);
}

async function changeProfileTab(page, stepName, tabIndex) {
  await clickLocator(
    page.locator('#RightColumn .SquareTabList .Tab--interactive:visible').nth(tabIndex),
    `change-profile-tab:${stepName}`,
    { timeout: optionalTimeoutMs },
  );

  return page.waitForFunction((expectedTabIndex) => {
    const tabs = document.querySelectorAll('#RightColumn .SquareTabList .Tab--interactive');
    const tab = tabs[expectedTabIndex];
    return Boolean(tab?.classList.contains('Tab--active'));
  }, tabIndex, { timeout: optionalTimeoutMs });
}

async function getVisibleProfileTabs(page) {
  traceStep('get-visible-profile-tabs');
  return page.locator('#RightColumn .SquareTabList .Tab--interactive:visible').evaluateAll((elements) => {
    return elements.map((element, index) => ({
      index,
      text: element.textContent?.trim() || '',
    }));
  });
}

async function canOpenPremiumSurface(page) {
  traceStep('can-open-premium-surface');
  return withTimeout(
    page.evaluate(() => Boolean(window.getGlobal?.()?.appConfig?.canBuyPremium)),
    10_000,
    'canOpenPremiumSurface()',
  );
}

async function openPremiumSurface(page) {
  await invokeAction(page, 'openPremiumModal', undefined, 'open-premium-surface');

  return waitForState(page, () => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => Boolean(tab?.premiumModal?.isOpen));
  }, undefined, 'Failed to open premium modal');
}

async function closePremiumSurface(page) {
  traceStep('close-premium-surface');
  await page.keyboard.press('Escape');

  return waitForState(page, () => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).every((tab) => !tab?.premiumModal?.isOpen);
  }, undefined, 'Failed to close premium modal');
}

async function returnToChatList(page) {
  const currentState = await readUiState(page);

  if (currentState.premiumModal.isOpen) {
    await closePremiumSurface(page);
  }

  if (currentState.leftColumnContentKey === LEFT_COLUMN_SETTINGS) {
    if (currentState.settingsScreen !== SETTINGS_SCREEN_MAIN) {
      await clickSettingsBack(page, SETTINGS_SCREEN_MAIN, 'Failed to return to settings main');
    }

    await invokeAction(
      page,
      'openLeftColumnContent',
      { contentKey: LEFT_COLUMN_CHAT_LIST },
      'close-settings-to-chat-list',
    );
  }

  return waitForState(page, (expectedLeftColumnContentKey) => {
    const global = window.getGlobal();
    return Object.values(global.byTabId || {}).some((tab) => {
      return tab?.leftColumn?.contentKey === expectedLeftColumnContentKey;
    });
  }, LEFT_COLUMN_CHAT_LIST, 'Failed to return to chat list');
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

function createTimeoutError(stepName, timeout) {
  return new Error(`[ui-view-structure] ${stepName} timed out after ${timeout}ms`);
}

async function withTimeout(promise, timeout, stepName) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(createTimeoutError(stepName, timeout));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function attemptSurface(visitedSurfaces, successLabel, task, failureLabel = `${successLabel}-unavailable`) {
  try {
    const result = await task();
    visitedSurfaces.push(successLabel);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVerbose(`soft-fail ${successLabel}: ${message}`);
    visitedSurfaces.push(failureLabel);
    return undefined;
  }
}

function scheduleForcedExit() {
  forcedExitTimer = setTimeout(() => {
    process.exit(process.exitCode || 0);
  }, 0);
}

let browser;
let context;

try {
  await ensureStorageState();

  if (usePersistentProfile) {
    try {
      const preparedUserDataDir = await prepareRuntimeUserDataDir();
      context = await chromium.launchPersistentContext(preparedUserDataDir, {
        headless: isPersistentProfileHeadless,
        channel: 'msedge',
        env: browserEnv,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ui-view-structure] persistent-profile launch failed, falling back to storage state: ${message}`);
      usePersistentProfile = false;
      browser = await chromium.launch({ headless: isHeadless, env: browserEnv });
      context = await browser.newContext({ storageState: storageStatePath });
    }
  } else {
    browser = await chromium.launch({ headless: isHeadless, env: browserEnv });
    context = await browser.newContext({ storageState: storageStatePath });
  }

  const page = await context.newPage();
  const relaySessionIds = new Set();
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

  await waitForApp(page);

  const candidates = await listCandidates(page);
  const visitedSurfaces = [];

  await attemptSurface(visitedSurfaces, 'settings-main', () => openSettingsSurface(page, undefined));
  await attemptSurface(visitedSurfaces, 'settings-notifications', () => openSettingsSurface(page, SETTINGS_SCREEN_NOTIFICATIONS));
  await attemptSurface(visitedSurfaces, 'settings-privacy', () => openSettingsSurface(page, SETTINGS_SCREEN_PRIVACY));
  await attemptSurface(visitedSurfaces, 'chat-list', () => returnToChatList(page));

  const preferredChatId = candidates.channelCandidate?.id || candidates.chatCandidate?.id;
  const openedChatState = await attemptSurface(
    visitedSurfaces,
    'chat-opened',
    () => openFirstChatSurface(page, preferredChatId),
  );

  const didOpenChatInfo = Boolean(await attemptSurface(
    visitedSurfaces,
    'chat-info-open',
    () => openChatInfoSurface(page),
  ));

  const visibleProfileTabs = didOpenChatInfo
    ? await attemptSurface(visitedSurfaces, 'chat-info-tabs-read', () => getVisibleProfileTabs(page), 'chat-info-tabs-unavailable')
    : undefined;

  if (visibleProfileTabs?.length) {
    await attemptSurface(
      visitedSurfaces,
      `chat-info-tab:${visibleProfileTabs[0].text || visibleProfileTabs[0].index}`,
      () => changeProfileTab(page, 'profile-tab-0', visibleProfileTabs[0].index),
    );
  }

  if (visibleProfileTabs && visibleProfileTabs.length > 1) {
    const lastVisibleProfileTab = visibleProfileTabs[visibleProfileTabs.length - 1];
    await attemptSurface(
      visitedSurfaces,
      `chat-info-tab:${lastVisibleProfileTab.text || lastVisibleProfileTab.index}`,
      () => changeProfileTab(page, `profile-tab-${lastVisibleProfileTab.index}`, lastVisibleProfileTab.index),
    );
  } else {
    visitedSurfaces.push('chat-info-secondary-tab-unavailable');
  }

  const canOpenPremium = await attemptSurface(
    visitedSurfaces,
    'premium-check',
    () => canOpenPremiumSurface(page),
    'premium-check-unavailable',
  );

  if (canOpenPremium) {
    const didOpenPremium = Boolean(await attemptSurface(
      visitedSurfaces,
      'premium-modal',
      () => openPremiumSurface(page),
    ));

    if (didOpenPremium) {
      await attemptSurface(visitedSurfaces, 'premium-modal-closed', () => closePremiumSurface(page));
    }
  } else {
    visitedSurfaces.push('premium-modal-unavailable');
  }

  await attemptSurface(visitedSurfaces, 'chat-list-final', () => returnToChatList(page), 'chat-list-final-unavailable');

  const finalState = await attemptSurface(
    visitedSurfaces,
    'final-state-read',
    () => readUiState(page),
    'final-state-unavailable',
  );

  console.log(JSON.stringify({
    baseUrl,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    candidates,
    openedChatId: openedChatState?.currentMessageListChatId,
    visitedSurfaces,
    finalState,
    constants: {
      leftColumnSettings: LEFT_COLUMN_SETTINGS,
      settingsMain: SETTINGS_SCREEN_MAIN,
      settingsNotifications: SETTINGS_SCREEN_NOTIFICATIONS,
      settingsPrivacy: SETTINGS_SCREEN_PRIVACY,
    },
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ui-view-structure] FAIL at ${currentStep}: ${message}`);
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

  scheduleForcedExit();
}
