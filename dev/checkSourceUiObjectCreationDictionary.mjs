import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const workspaceRoot = process.cwd();
const dictionaryPath = path.join(workspaceRoot, 'graph', 'draw', 'ui-object-usage', 'source-ui-object-creations.json');
const reportJsonPath = path.join(workspaceRoot, 'graph', 'draw', 'ui-object-usage', 'source-ui-object-check-report.json');
const reportMarkdownPath = path.join(workspaceRoot, 'graph', 'draw', 'ui-object-usage', 'source-ui-object-check-report.md');
const baseUrl = process.env.UI_EXPLORER_URL || 'http://127.0.0.1:8791/ui-explorer';

function fail(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function readDictionary() {
  return JSON.parse(fs.readFileSync(dictionaryPath, 'utf8'));
}

function getEntries(dictionary) {
  return dictionary.objects.flatMap((object) => (
    object.entries.map((entry) => ({
      ...entry,
      objectKey: object.objectKey,
    }))
  ));
}

function buildKey({ objectKey, uiSurface, elementName, line, eventName, handlerName, actionName }) {
  return [
    objectKey,
    uiSurface,
    elementName || '',
    line || '',
    eventName || '',
    handlerName || '',
    actionName,
  ].join('::');
}

function uniqueEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = buildKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function validateSourceLines(entries) {
  const failures = [];
  for (const entry of entries) {
    const absolutePath = path.join(workspaceRoot, entry.repoRelativePath);
    if (!fs.existsSync(absolutePath)) {
      failures.push({ ...entry, reason: 'source file missing' });
      continue;
    }

    const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/u);
    const lineText = lines[entry.line - 1] || '';
    const nearbyText = lines.slice(Math.max(0, entry.line - 1), Math.min(lines.length, entry.line + 24)).join('\n');
    const hasElement = !entry.elementName || lineText.includes(entry.elementName);
    const hasEvent = !entry.eventName || nearbyText.includes(entry.eventName);
    const hasHandler = !entry.handlerName || nearbyText.includes(entry.handlerName);
    if (!hasElement || !hasEvent || !hasHandler) {
      failures.push({
        ...entry,
        reason: 'source affordance signature no longer matches nearby JSX',
        lineText,
      });
    }
  }
  return failures;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    fail(`Request failed: ${url}`, payload);
  }
  return payload;
}

async function loadExtractorEntries(objectKeys) {
  const entries = [];
  for (const objectKey of objectKeys) {
    const url = new URL(baseUrl.replace('/ui-explorer', '/api/ui-explorer/object-paths'));
    url.searchParams.set('objectKey', objectKey);
    const payload = await fetchJson(url);
    for (const item of payload.paths || []) {
      const terminalSurface = item.surfaces?.at(-1);
      entries.push({
        objectKey,
        uiSurface: terminalSurface?.ownerName || item.terminal?.ownerName || '',
        elementName: item.terminal?.elementName || '',
        line: item.terminal?.line || undefined,
        eventName: item.terminal?.eventName || '',
        handlerName: item.terminal?.handlerName || '',
        actionName: item.uiActionName || item.terminal?.uiActionName || item.functionName || item.terminal?.functionName || '',
        terminalName: item.terminal?.ownerName || '',
        blockTitle: item.blockTitle || '',
        repoRelativePath: terminalSurface?.ownerRepoRelativePath || '',
        resolutionKind: item.terminal?.resolutionKind || '',
      });
    }
  }
  return entries;
}

function compareDictionaryToObserved(dictionaryEntries, observedEntries) {
  const expected = uniqueEntries(dictionaryEntries);
  const observed = uniqueEntries(observedEntries);
  const observedKeys = new Set(observed.map(buildKey));
  const expectedKeys = new Set(expected.map(buildKey));

  return {
    missing: expected.filter((entry) => !observedKeys.has(buildKey(entry))),
    extra: observed.filter((entry) => !expectedKeys.has(buildKey(entry))),
  };
}

function formatEntry(entry) {
  return [
    entry.objectKey,
    entry.uiSurface,
    entry.elementName,
    entry.actionName,
    entry.eventName,
    entry.handlerName,
    entry.repoRelativePath ? `${entry.repoRelativePath}:${entry.line || ''}`.replace(/:$/u, '') : '',
    entry.reason || '',
  ].filter(Boolean).join(' | ');
}

function renderMarkdownReport(report) {
  const lines = [
    '# Source UI Object Check Report',
    '',
    `Checked: ${report.checkedAt}`,
    `Status: ${report.ok ? 'ok' : 'failed'}`,
    '',
    '## Source Line Failures',
    '',
  ];

  if (report.sourceLineFailures.length) {
    report.sourceLineFailures.forEach((entry) => lines.push(`- ${formatEntry(entry)}`));
  } else {
    lines.push('- none');
  }

  lines.push('', '## Missing From Extractor', '');
  if (report.extractorComparison.missing.length) {
    report.extractorComparison.missing.forEach((entry) => lines.push(`- ${formatEntry(entry)}`));
  } else {
    lines.push('- none');
  }

  lines.push('', '## Extra In Extractor', '');
  if (report.extractorComparison.extra.length) {
    report.extractorComparison.extra.forEach((entry) => lines.push(`- ${formatEntry(entry)}`));
  } else {
    lines.push('- none');
  }

  lines.push('', '## Missing From Frontend', '');
  if (report.frontendComparison.missing.length) {
    report.frontendComparison.missing.forEach((entry) => lines.push(`- ${formatEntry(entry)}`));
  } else {
    lines.push('- none');
  }

  lines.push('', '## Extra In Frontend', '');
  if (report.frontendComparison.extra.length) {
    report.frontendComparison.extra.forEach((entry) => lines.push(`- ${formatEntry(entry)}`));
  } else {
    lines.push('- none');
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function loadFrontendEntries(objectKeys) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const entries = [];
  try {
    for (const objectKey of objectKeys) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#objectFilter input[type="checkbox"]', { timeout: 15_000 });
      const checkbox = page.getByRole('checkbox', { name: objectKey, exact: true });
      if (await checkbox.count() !== 1) {
        fail(`Expected one frontend checkbox for ${objectKey}.`);
      }

      await checkbox.check({ timeout: 5_000 });
      await page.waitForSelector('.pathForest', { timeout: 15_000 });
      await page.waitForFunction((key) => (
        [...document.querySelectorAll('.domainActionBadge')]
          .some((badge) => (badge.textContent || '').includes(key))
      ), objectKey, { timeout: 15_000 });

      const objectEntries = await page.evaluate((key) => {
        function readTitleField(title, fieldName) {
          const prefix = `${fieldName}: `;
          return (title || '').split('\n')
            .find((line) => line.startsWith(prefix))
            ?.slice(prefix.length)
            .trim() || '';
        }

        return [...document.querySelectorAll('.pathNodeLine')]
          .map((row) => {
            const label = [...row.querySelectorAll('.pathCrumb')].at(-1)?.textContent || '';
            return [...row.querySelectorAll('.domainActionBadge')]
              .filter((badge) => (badge.textContent || '').includes(`${key}:`))
              .map((badge) => {
                const badgeText = badge.textContent || '';
                const title = badge.getAttribute('title') || '';
                return {
                  objectKey: key,
                  uiSurface: label,
                  elementName: readTitleField(title, 'Element'),
                  line: Number(readTitleField(title, 'Line')) || undefined,
                  eventName: readTitleField(title, 'Event'),
                  handlerName: readTitleField(title, 'Handler'),
                  actionName: badgeText.slice(badgeText.indexOf(':') + 1).trim(),
                };
              });
          })
          .flat();
      }, objectKey);
      entries.push(...objectEntries);
    }
  } finally {
    await browser.close();
  }
  return entries;
}

async function run() {
  const dictionary = readDictionary();
  const dictionaryEntries = getEntries(dictionary);
  const sourceLineFailures = validateSourceLines(dictionaryEntries);
  const objectKeys = dictionary.objects.map((object) => object.objectKey);
  const extractorEntries = await loadExtractorEntries(objectKeys);
  const frontendEntries = await loadFrontendEntries(objectKeys);
  const extractorComparison = compareDictionaryToObserved(dictionaryEntries, extractorEntries);
  const frontendComparison = compareDictionaryToObserved(dictionaryEntries, frontendEntries);

  const report = {
    ok: !sourceLineFailures.length
      && !extractorComparison.missing.length
      && !extractorComparison.extra.length
      && !frontendComparison.missing.length
      && !frontendComparison.extra.length,
    checkedAt: new Date().toISOString(),
    dictionaryPath,
    baseUrl,
    objectKeys,
    sourceLineFailures,
    extractorComparison,
    frontendComparison,
  };

  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(reportMarkdownPath, renderMarkdownReport(report));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details || null,
  }, null, 2));
  process.exit(1);
});

