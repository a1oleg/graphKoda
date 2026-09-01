import fs from 'node:fs';
import path from 'node:path';

import { config } from 'dotenv';
import neo4j from 'neo4j-driver';

import { resolveFunctionActualCoordinates } from '../graph/packages/orchestrator/src/orchestrator/gatewayForALL.js';

config({ path: 'graph/.env' });

const GRAPH_ROOT = path.resolve(process.cwd(), 'graph');
const DEFAULT_DATABASE = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
const DEFAULT_USER = process.env.NEO4J_USER || process.env.NEO4J_USERNAME;

function walkJsonFiles(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      return walkJsonFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

function normalizePositiveInteger(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : undefined;
}

function hasSelectorPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && (payload.head || payload.bridgeExitFn || Array.isArray(payload.tails)));
}

async function refreshSelector(driver, database, selector, filePath) {
  if (!selector || typeof selector !== 'object' || !selector.name || !selector.repoRelativePath) {
    return { selector, changed: false, skipped: true };
  }

  const resolution = await resolveFunctionActualCoordinates(driver, database, {
    stableId: selector.stableId,
    name: selector.name,
    repoRelativePath: selector.repoRelativePath,
    line: normalizePositiveInteger(selector.line),
    startLine: normalizePositiveInteger(selector.startLine),
    startColumn: normalizePositiveInteger(selector.startColumn),
    endLine: normalizePositiveInteger(selector.endLine),
    endColumn: normalizePositiveInteger(selector.endColumn),
    repairGraph: false,
    ensureFlow: false,
  });

  if (!resolution?.found || !resolution?.stableId || !resolution?.repoRelativePath || !resolution?.startLine) {
    throw new Error(`Could not resolve selector ${selector.name} in ${filePath}`);
  }

  const updatedSelector = {
    ...selector,
    stableId: resolution.stableId,
    name: resolution.name || selector.name,
    repoRelativePath: resolution.repoRelativePath,
    line: resolution.startLine,
    startLine: resolution.startLine,
    startColumn: resolution.startColumn,
    endLine: resolution.endLine,
    endColumn: resolution.endColumn,
  };

  const changed = JSON.stringify(selector) !== JSON.stringify(updatedSelector);

  return {
    selector: updatedSelector,
    changed,
    skipped: false,
  };
}

async function refreshJsonFile(driver, database, filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!hasSelectorPayload(payload)) {
    return { filePath, changed: false, skipped: true };
  }

  const refreshedHead = payload.head
    ? await refreshSelector(driver, database, payload.head, filePath)
    : { selector: undefined, changed: false, skipped: true };
  const refreshedBridgeExit = payload.bridgeExitFn
    ? await refreshSelector(driver, database, payload.bridgeExitFn, filePath)
    : { selector: undefined, changed: false, skipped: true };
  const refreshedTails = await Promise.all((Array.isArray(payload.tails) ? payload.tails : []).map((tail) => (
    refreshSelector(driver, database, tail, filePath)
  )));

  const nextPayload = {
    ...payload,
    head: refreshedHead.selector,
    bridgeExitFn: refreshedBridgeExit.selector,
    tails: Array.isArray(payload.tails) ? refreshedTails.map(({ selector }) => selector) : payload.tails,
  };

  if (nextPayload.feature && nextPayload.head) {
    nextPayload.feature = {
      ...nextPayload.feature,
      label: nextPayload.head.name,
      repoRelativePath: nextPayload.head.repoRelativePath,
    };
  }

  const changed = JSON.stringify(payload) !== JSON.stringify(nextPayload);
  if (changed) {
    fs.writeFileSync(filePath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
  }

  return {
    filePath,
    changed,
    skipped: false,
  };
}

async function main() {
  if (!process.env.NEO4J_URI || !DEFAULT_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error('NEO4J_URI, NEO4J_USER/NEO4J_USERNAME, and NEO4J_PASSWORD must be set.');
  }

  const jsonFiles = walkJsonFiles(GRAPH_ROOT);
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(DEFAULT_USER, process.env.NEO4J_PASSWORD));

  try {
    const results = [];
    for (const filePath of jsonFiles) {
      results.push(await refreshJsonFile(driver, DEFAULT_DATABASE, filePath));
    }

    const touchedFiles = results.filter((result) => !result.skipped);
    const changedFiles = touchedFiles.filter((result) => result.changed);

    console.log(JSON.stringify({
      scanned: jsonFiles.length,
      selectorJsonFiles: touchedFiles.length,
      changedFiles: changedFiles.map(({ filePath }) => path.relative(process.cwd(), filePath).replace(/\\/g, '/')),
    }, null, 2));
  } finally {
    await driver.close();
  }
}

await main();
