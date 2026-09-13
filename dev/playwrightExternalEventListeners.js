import { chromium } from '@playwright/test';

const baseUrl = process.env.EXTERNAL_EVENT_LISTENERS_BASE_URL || 'http://localhost:1234/';
const timeoutMs = Number(process.env.EXTERNAL_EVENT_LISTENERS_TIMEOUT_MS || 45_000);
const settleMs = Number(process.env.EXTERNAL_EVENT_LISTENERS_SETTLE_MS || 4_000);
const offlineMs = Number(process.env.EXTERNAL_EVENT_LISTENERS_OFFLINE_MS || 1_500);
const isHeadless = process.env.EXTERNAL_EVENT_LISTENERS_HEADLESS !== '0';

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
        // Ignore malformed relay payload capture and continue.
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

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(
    () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(settleMs);

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(settleMs);

  await context.setOffline(true);
  await page.waitForTimeout(offlineMs);
  await context.setOffline(false);
  await page.waitForTimeout(settleMs);

  const readyState = await page.evaluate(() => ({
    hash: window.location.hash,
    title: document.title,
    authState: window.getGlobal?.()?.auth?.state,
  }));

  await page.close();

  console.log(JSON.stringify({
    baseUrl,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayStatuses,
    readyState,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
