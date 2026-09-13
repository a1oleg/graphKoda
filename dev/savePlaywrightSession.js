import { access, copyFile, mkdir } from 'node:fs/promises';

import { chromium } from '@playwright/test';

const isTestServer = process.env.TELEGRAM_TEST_SERVER === '1';
const storageStatePath = isTestServer ? 'tests/playwright/.auth/session.test.json' : 'tests/playwright/.auth/session.json';
const sourceStorageStatePath = process.env.PLAYWRIGHT_SESSION_SOURCE_PATH;
const baseUrl = process.env.PLAYWRIGHT_SESSION_URL || (isTestServer ? 'http://localhost:1235/' : 'http://localhost:1234/');
const userDataDir = process.env.PLAYWRIGHT_SESSION_USER_DATA_DIR
  || (isTestServer ? 'tests/playwright/.profile/mocked' : 'tests/playwright/.profile/ordinary-dev');
const timeoutMs = Number(process.env.PLAYWRIGHT_SESSION_TIMEOUT_MS || 60 * 60_000);

function createBrowserEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GOOGLE_|NEO4J_|TELEGRAM_)/.test(name)),
  );
}

async function ensureImportedSession() {
  if (!sourceStorageStatePath) {
    return false;
  }

  await access(sourceStorageStatePath);

  if (sourceStorageStatePath !== storageStatePath) {
    await copyFile(sourceStorageStatePath, storageStatePath);
    console.log(`[auth] Session imported from ${sourceStorageStatePath}`);
  }

  console.log(`[auth] Session saved to ${storageStatePath}`);
  return true;
}

async function getOrCreatePage(context) {
  const activePage = context.pages().find((candidate) => !candidate.isClosed());
  if (activePage) {
    return activePage;
  }

  return context.newPage();
}

async function ensureAppPage(context) {
  const page = await getOrCreatePage(context);

  if (!page.url() || page.url() === 'about:blank') {
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to open ${baseUrl}. Start the app there first or set PLAYWRIGHT_SESSION_URL to a reachable Telegram app URL. Original error: ${message}`,
      );
    }
  }

  return page;
}

async function waitForAuthorization(context) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const page = await ensureAppPage(context);

    let snapshot;

    try {
      snapshot = await page.evaluate(() => {
        const global = window.getGlobal?.();
        const bodyText = document.body?.innerText || '';
        const localStorageKeys = Object.keys(localStorage || {});
        const loginMarkers = [
          'Log in to Telegram by QR Code',
          'Your Phone Number',
          'NEXT',
          'Next',
          'Confirm phone number',
        ];
        const hasLoginMarker = loginMarkers.some((marker) => bodyText.includes(marker));
        const hasTelegramAuthStorage = localStorageKeys.includes('user_auth')
          || localStorageKeys.some((key) => /^account\d+$/i.test(key))
          || localStorageKeys.some((key) => /^dc\d+_auth_key$/i.test(key));
        const cookieCount = document.cookie
          ? document.cookie.split(';').map((entry) => entry.trim()).filter(Boolean).length
          : 0;

        return {
          href: window.location.href,
          hostname: window.location.hostname,
          hasGlobal: typeof window.getGlobal === 'function',
          authState: global?.auth?.state,
          connectionState: global?.connectionState,
          currentUserId: global?.currentUserId,
          chatCount: global?.chats?.byId ? Object.keys(global.chats.byId).length : 0,
          bodyTextLength: bodyText.length,
          localStorageKeyCount: localStorageKeys.length,
          localStorageKeysSample: localStorageKeys.slice(0, 10),
          hasTelegramAuthStorage,
          cookieCount,
          hasLoginMarker,
        };
      });
    } catch (error) {
      if (page.isClosed()) {
        console.log('[auth] Browser page was closed, reopening the app on the same profile...');
        continue;
      }

      throw error;
    }

    if (snapshot.authState === 'authorizationStateReady' && snapshot.currentUserId) {
      return snapshot;
    }

    const isHostedTelegramWeb = /(^|\.)web\.telegram\.org$/i.test(snapshot.hostname || '');
    const looksLikeHostedTelegramApp = isHostedTelegramWeb
      && !snapshot.hasLoginMarker
      && (snapshot.hasTelegramAuthStorage || snapshot.cookieCount >= 1);

    if (looksLikeHostedTelegramApp) {
      return snapshot;
    }

    if (snapshot.authState === 'authorizationStateWaitQrCode') {
      console.log('[auth] Waiting for QR login in the opened browser window...');
    } else {
      console.log(`[auth] Waiting for authorization, current state: ${JSON.stringify(snapshot)}`);
    }

    await page.waitForTimeout(5_000);
  }

  throw new Error(`Timed out waiting for authorization at ${baseUrl}`);
}

async function saveSessionFromBrowser() {
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'msedge',
    env: createBrowserEnv(),
  });

  try {
    await ensureAppPage(context);

    console.log(`[auth] Browser opened at ${baseUrl}`);
    console.log(`[auth] Persistent profile: ${userDataDir}`);
    console.log('[auth] Complete Telegram login in that browser window if needed.');

    const finalSnapshot = await waitForAuthorization(context);
    await context.storageState({ path: storageStatePath });

    console.log(`[auth] Session saved to ${storageStatePath}`);
    console.log(`[auth] Final state: ${JSON.stringify(finalSnapshot)}`);
  } finally {
    await context.close();
  }
}

try {
  await mkdir('tests/playwright/.auth', { recursive: true });

  const didImport = await ensureImportedSession();
  if (!didImport) {
    await saveSessionFromBrowser();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth] Failed to save session: ${message}`);
  console.error('[auth] Either set PLAYWRIGHT_SESSION_SOURCE_PATH to an existing storageState file, or complete login in the opened browser window so the script can persist storageState automatically.');
  process.exitCode = 1;
}
