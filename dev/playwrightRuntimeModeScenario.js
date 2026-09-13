import { chromium } from '@playwright/test';

const baseUrl = process.env.RUNTIME_MODE_SCENARIO_BASE_URL || 'http://localhost:1235/';
const scenario = process.env.RUNTIME_MODE_SCENARIO || 'issue503';
const timeoutMs = Number(process.env.RUNTIME_MODE_SCENARIO_TIMEOUT_MS || 30_000);
const settleMs = Number(process.env.RUNTIME_MODE_SCENARIO_SETTLE_MS || 3_000);
const isHeadless = process.env.RUNTIME_MODE_SCENARIO_HEADLESS !== '0';
const shouldIncludeTestParam = process.env.RUNTIME_MODE_SCENARIO_INCLUDE_TEST !== '0';

function buildTargetUrl() {
  const url = new URL(baseUrl);
  const params = new URLSearchParams();
  params.set('mockScenario', scenario);
  if (shouldIncludeTestParam) {
    params.set('tgWebAuthTest', '1');
  }
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

  const targetUrl = buildTargetUrl();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForSelector('#root, body > *', { timeout: timeoutMs });
  await page.waitForFunction(
    () => typeof window.getGlobal === 'function' && typeof window.getActions === 'function',
    { timeout: timeoutMs },
  );

  await page.waitForTimeout(settleMs);

  const readyState = await page.evaluate(() => {
    const global = window.getGlobal?.();
    const authStates = Object.values(global?.byTabId || {}).map((tab) => tab?.authState);

    return {
      hash: window.location.hash,
      authStates,
      hasPageTitle: Boolean(document.title),
    };
  });

  console.log(JSON.stringify({
    targetUrl,
    scenario,
    includedTestParam: shouldIncludeTestParam,
    relayPostCount,
    relaySessionIds: [...relaySessionIds],
    relayStatuses,
    readyState,
  }, null, 2));

  await context.close();
} finally {
  await browser.close();
}
