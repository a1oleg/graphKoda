import { access } from 'node:fs/promises';

import { chromium } from '@playwright/test';

const scenario = process.env.SMOKE_SCENARIO || 'default';
const baseUrl = process.env.SMOKE_URL || `http://localhost:1235/#?mockScenario=${scenario}`;
const storageStatePath = process.env.SMOKE_STORAGE_STATE;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45_000);
const isHeadless = process.env.SMOKE_HEADLESS !== '0';

if (storageStatePath) {
  try {
    await access(storageStatePath);
  } catch {
    console.error(`[smoke:playwright] Missing storage state: ${storageStatePath}`);
    process.exit(1);
  }
}

const browser = await chromium.launch({ headless: isHeadless });

try {
  const context = await browser.newContext(storageStatePath ? { storageState: storageStatePath } : undefined);
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
  await page.waitForSelector('.chat-list, [class*="chatList"], #LeftColumn', { timeout: timeoutMs });

  const currentUrl = page.url();
  const title = await page.title();
  console.log(`[smoke:playwright] OK ${currentUrl} title=${title || '<empty>'}`);

  await context.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[smoke:playwright] FAIL ${message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
