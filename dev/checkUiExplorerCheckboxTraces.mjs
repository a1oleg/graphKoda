import { chromium } from 'playwright';

const baseUrl = process.env.UI_EXPLORER_URL || 'http://127.0.0.1:8791/ui-explorer';
const requestedObjectKeys = (process.env.UI_EXPLORER_OBJECTS || process.argv.slice(2).join(',') || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const forbiddenBadges = [
  {
    objectKey: 'ApiMessage',
    surfaceNames: ['CustomEmojiPicker', 'StickerPicker'],
    forbiddenText: 'ApiMessage: sendMessage',
    reason: 'sendMessage belongs to StickerSetModal, not to picker surfaces that only open/reach it',
  },
];

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function waitForApp(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#objectFilter input[type="checkbox"]', { timeout: 15_000 });
}

async function discoverObjectKeys(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('#objectFilter label.familyFilterOption')]
      .map((option) => ({
        objectKey: option.querySelector('span')?.textContent?.trim() || '',
        disabled: Boolean(option.querySelector('input[type="checkbox"]')?.disabled),
      }))
      .filter((item) => item.objectKey);
  });
}

async function selectObject(page, objectKey) {
  const result = await page.evaluate((key) => {
    const options = [...document.querySelectorAll('#objectFilter label.familyFilterOption')];
    const matches = options.filter((option) => (option.querySelector('span')?.textContent || '').trim() === key);
    if (matches.length !== 1) {
      return { ok: false, reason: `Expected one checkbox for ${key}, found ${matches.length}.` };
    }
    const checkbox = matches[0].querySelector('input[type="checkbox"]');
    if (!checkbox) {
      return { ok: false, reason: `${key} checkbox is missing.` };
    }
    if (checkbox.disabled) {
      return { ok: false, reason: `${key} checkbox is disabled.` };
    }
    if (!checkbox.checked) {
      checkbox.click();
    }
    return { ok: true };
  }, objectKey);
  if (!result.ok) {
    fail(result.reason);
  }
  await page.waitForFunction((key) => {
    return [...document.querySelectorAll('.domainActionBadge')]
      .some((badge) => (badge.textContent || '').includes(key));
  }, objectKey, { timeout: 15_000 });
}

async function expandVisibleRowsWithBadge(page, objectKey, maxPasses = 16) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const rowsBefore = await page.locator('.treeNode').evaluateAll((rows) => rows.length);
    const clickedRows = await page.evaluate((key) => {
      const rows = [...document.querySelectorAll('.treeNode')];
      let clicked = 0;
      for (const row of rows) {
        const badges = [...row.querySelectorAll('.domainActionBadge')].map((badge) => badge.textContent || '');
        if (!badges.some((text) => text.includes(key))) {
          continue;
        }
        const toggle = row.querySelector('.treeToggle');
        if (!toggle || toggle.disabled || toggle.textContent !== '+') {
          continue;
        }
        toggle.click();
        clicked += 1;
      }
      return clicked;
    }, objectKey);
    if (!clickedRows) {
      return;
    }
    await page.waitForTimeout(700);
    const rowsAfter = await page.locator('.treeNode').evaluateAll((rows) => rows.length);
    if (rowsAfter <= rowsBefore && clickedRows === 0) {
      return;
    }
  }
}

async function collectRows(page) {
  return page.evaluate(() => {
    const treeRows = [...document.querySelectorAll('.treeNode')].map((row) => ({
      viewKind: 'tree',
      label: row.querySelector('.treeLabel')?.textContent || '',
      badges: [...row.querySelectorAll('.domainActionBadge')].map((badge) => badge.textContent || ''),
      meta: row.querySelector('.treeMeta')?.textContent || '',
      expanded: row.querySelector('.treeToggle')?.textContent === '-',
      canExpand: Boolean(row.querySelector('.treeToggle:not(:disabled)')),
    }));
    const pathRows = [...document.querySelectorAll('.pathNodeLine')].map((row) => ({
      viewKind: 'path',
      label: [...row.querySelectorAll('.pathCrumb')].at(-1)?.textContent || '',
      badges: [...row.querySelectorAll('.domainActionBadge')].map((badge) => badge.textContent || ''),
      meta: row.querySelector('.pathMeta')?.textContent || '',
      expanded: false,
      canExpand: false,
      isTerminal: [...row.querySelectorAll('.domainActionBadge')].length > 0,
    }));
    return [...treeRows, ...pathRows];
  });
}

function assertForbiddenBadges(rows, objectKey) {
  const relevantRules = forbiddenBadges.filter((rule) => rule.objectKey === objectKey);
  const failures = [];
  for (const rule of relevantRules) {
    for (const surfaceName of rule.surfaceNames) {
      const matchingRows = rows.filter((row) => row.label === surfaceName);
      for (const row of matchingRows) {
        if (row.badges.includes(rule.forbiddenText)) {
          failures.push({
            surfaceName,
            forbiddenText: rule.forbiddenText,
            badges: row.badges,
            reason: rule.reason,
          });
        }
      }
    }
  }
  if (failures.length) {
    fail(`Forbidden UI badges found for ${objectKey}.`, failures);
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const results = [];
  let discoveredObjects = [];

  try {
    await waitForApp(page);
    discoveredObjects = await discoverObjectKeys(page);
    const objectKeys = requestedObjectKeys.length && !requestedObjectKeys.includes('all')
      ? requestedObjectKeys
      : discoveredObjects.filter((item) => !item.disabled).map((item) => item.objectKey);
    if (!objectKeys.length) {
      fail('No enabled object checkboxes found.');
    }

    for (const objectKey of objectKeys) {
      await waitForApp(page);
      await selectObject(page, objectKey);
      await expandVisibleRowsWithBadge(page, objectKey);
      await page.waitForSelector('.pathForest', { timeout: 15_000 });
      const rows = await collectRows(page);
      const hasVisibleBadge = rows.some((row) => row.badges.some((badge) => badge.includes(objectKey)));
      if (!hasVisibleBadge) {
        fail(`No visible badges appeared after checking ${objectKey}.`);
      }
      const hasTerminalBadge = rows.some((row) => row.isTerminal && row.badges.some((badge) => badge.includes(objectKey)));
      if (!hasTerminalBadge) {
        fail(`No terminal path badges appeared after checking ${objectKey}.`);
      }
      assertForbiddenBadges(rows, objectKey);
      results.push({
        objectKey,
        watchedRows: rows
          .filter((row) => forbiddenBadges
            .some((rule) => rule.objectKey === objectKey && rule.surfaceNames.includes(row.label)))
          .map((row) => ({
            label: row.label,
            badges: row.badges,
            meta: row.meta,
          })),
        sampleRows: rows
          .filter((row) => row.badges.some((badge) => badge.includes(objectKey)))
          .slice(0, 12),
      });
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    baseUrl,
    objectKeys: results.map((result) => result.objectKey),
    discoveredObjects,
    results,
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
});

