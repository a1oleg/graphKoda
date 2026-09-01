import { access, cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const baseUrl = process.env.PLAYWRIGHT_SESSION_URL || 'http://localhost:1234/';
const storageStatePath = process.env.PLAYWRIGHT_STORAGE_STATE || 'tests/playwright/.auth/session.json';
const userDataDir = process.env.PLAYWRIGHT_SESSION_USER_DATA_DIR || 'tests/playwright/.profile/ordinary-dev';
const saveIntervalMs = Number(process.env.PLAYWRIGHT_SESSION_SAVE_INTERVAL_MS || 5_000);

function createBrowserEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GOOGLE_|NEO4J_|TELEGRAM_)/.test(name)),
  );
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function pathExists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
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

async function copyProfile(sourceRoot, targetRoot) {
  await mkdir(dirname(targetRoot), { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => shouldCopyProfilePath(sourceRoot, sourcePath),
  });
}

async function syncProfileBack(runtimeRoot, sourceRoot) {
  await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
  await copyProfile(runtimeRoot, sourceRoot);
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
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  }

  return page;
}

async function readAuthSnapshot(page) {
  return page.evaluate(() => {
    const global = window.getGlobal?.();
    return {
      authState: global?.auth?.state,
      currentUserId: global?.currentUserId,
      href: window.location.href,
    };
  });
}

async function persistStorageState(context) {
  await mkdir(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
}

const browserEnv = createBrowserEnv();
const hasSavedProfile = await pathExists(userDataDir);
const hasStorageState = await pathExists(storageStatePath);

let browser;
let context;
let runtimeRoot;
let sourceRoot;
let mode = 'fresh-login';

try {
  if (hasSavedProfile) {
    sourceRoot = resolve(userDataDir);
    runtimeRoot = resolve(`${userDataDir}.runtime-${Date.now()}-${process.pid}`);
    await copyProfile(sourceRoot, runtimeRoot);
    context = await chromium.launchPersistentContext(runtimeRoot, {
      headless: false,
      channel: 'msedge',
      env: browserEnv,
    });
    mode = 'persistent-profile';
  } else {
    browser = await chromium.launch({
      headless: false,
      channel: 'msedge',
      env: browserEnv,
    });
    context = await browser.newContext(hasStorageState ? { storageState: storageStatePath } : undefined);
    mode = hasStorageState ? 'storage-state' : 'fresh-login';
  }

  const page = await ensureAppPage(context);

  console.log(`[graph-session] Browser opened at ${baseUrl}`);
  console.log(`[graph-session] Mode: ${mode}`);
  console.log(`[graph-session] Storage state: ${storageStatePath}`);
  console.log('[graph-session] The session will be auto-saved after login/auth.');

  let stopRequested = false;

  const saveLoop = (async () => {
    let didReportSave = false;

    while (!stopRequested) {
      try {
        const currentPage = await ensureAppPage(context);
        const snapshot = await readAuthSnapshot(currentPage);
        if (snapshot.authState === 'authorizationStateReady' && snapshot.currentUserId) {
          await persistStorageState(context);

          if (!didReportSave) {
            console.log(`[graph-session] Session saved to ${storageStatePath}`);
            didReportSave = true;
          }
        }
      } catch {
        // Ignore transient shutdown errors while the user closes the browser.
      }

      await delay(saveIntervalMs);
    }
  })();

  await new Promise((resolvePromise) => {
    context.on('close', resolvePromise);
    page.on('close', async () => {
      const remainingOpenPages = context.pages().filter((candidate) => !candidate.isClosed());
      if (!remainingOpenPages.length) {
        try {
          await context.close();
        } catch {
          resolvePromise();
        }
      }
    });
  });

  stopRequested = true;
  await saveLoop.catch(() => undefined);
} finally {
  if (context) {
    await persistStorageState(context).catch(() => {});
    await context.close().catch(() => {});
  }

  if (browser) {
    await browser.close().catch(() => {});
  }

  if (runtimeRoot && sourceRoot) {
    await syncProfileBack(runtimeRoot, sourceRoot).catch(() => {});
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
  }
}
