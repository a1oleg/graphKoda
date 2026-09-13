import { copyFile, mkdir } from 'node:fs/promises';

import { chromium } from '@playwright/test';

const baseUrl = process.env.PLAYWRIGHT_SESSION_URL || 'http://localhost:1234/';
const storageStatePath = 'tests/playwright/.auth/session.json';
const userDataDir = process.env.PLAYWRIGHT_SESSION_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev';
const timeoutMs = Number(process.env.PLAYWRIGHT_SESSION_TIMEOUT_MS || 60 * 60_000);

function createBrowserEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GOOGLE_|NEO4J_|TELEGRAM_)/.test(name)),
  );
}

const browserEnv = createBrowserEnv();

async function ensureAppPage(context) {
  const page = await getOrCreatePage(context);

  if (!page.url() || page.url() === 'about:blank') {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
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
        const legacyUserAuth = localStorage.getItem('user_auth');
        const account1 = localStorage.getItem('account1');
        const dc = localStorage.getItem('dc');
        const dc1 = localStorage.getItem('dc1_auth_key');
        const dc2 = localStorage.getItem('dc2_auth_key');

        return {
          href: window.location.href,
          hasGlobal: typeof window.getGlobal === 'function',
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
    } catch (error) {
      if (page.isClosed()) {
        console.log('[auth-refresh] Browser page was closed, reopening the app on the same profile...');
        continue;
      }

      throw error;
    }

    if (snapshot.authState === 'authorizationStateReady' && snapshot.currentUserId) {
      return snapshot;
    }

    if (snapshot.authState === 'authorizationStateWaitQrCode') {
      console.log('[auth-refresh] Waiting for QR login in the opened browser window...');
    } else {
      console.log(`[auth-refresh] Waiting for authorization, current state: ${JSON.stringify(snapshot)}`);

      if (snapshot.hasLegacyUserAuth && snapshot.hasDc && snapshot.hasAuthKeys) {
        console.log('[auth-refresh] Local auth footprint exists, but the app is not authorized yet. Waiting for full authorization...');
      }
    }

    await page.waitForTimeout(5_000);
  }

  throw new Error(`Timed out waiting for authorization at ${baseUrl}`);
}

async function getOrCreatePage(context) {
  const activePage = context.pages().find((candidate) => !candidate.isClosed());
  if (activePage) {
    return activePage;
  }

  return context.newPage();
}

let context;

try {
  await mkdir('tests/playwright/.auth', { recursive: true });
  await mkdir(userDataDir, { recursive: true });

  context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  channel: 'msedge',
  env: browserEnv,
  });

  await ensureAppPage(context);

  console.log(`[auth-refresh] Browser opened at ${baseUrl}`);
  console.log(`[auth-refresh] Persistent profile: ${userDataDir}`);
  console.log('[auth-refresh] Complete Telegram login in that browser window.');

  const finalSnapshot = await waitForAuthorization(context);

  await context.storageState({ path: storageStatePath });

  console.log(`[auth-refresh] Session saved to ${storageStatePath}`);
  console.log(`[auth-refresh] Final state: ${JSON.stringify(finalSnapshot)}`);
} finally {
  if (context) {
    await context.close();
  }
}
