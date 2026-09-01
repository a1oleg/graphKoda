import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import neo4j from 'neo4j-driver';

import { loadProjectEnv } from './load-env.mjs';
import { loadFunctionalityTreeFromGraph } from '../graph/packages/runtime-relay/src/functionalityTree.js';
import { runReadQuery } from '../graph/packages/runtime-relay/src/runtimeEvents.js';

const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'graph', 'draw', 'Р¤РёС‡Рё.txt');
const DEFAULT_ROOT_LABEL = 'Р’РµСЃСЊ СЂР°РЅС‚Р°Р№Рј РїСЂРёР»РѕР¶РµРЅРёСЏ';
const DEFAULT_MODE = 'ui-availability';
const UI_CAPABILITY_SOURCE = 'semantic/uiCapabilityGraph';
const UI_TOKEN_STOP_WORDS = new Set([
  'active',
  'action',
  'actions',
  'add',
  'already',
  'api',
  'async',
  'auth',
  'badge',
  'base',
  'block',
  'button',
  'buttons',
  'caption',
  'common',
  'component',
  'components',
  'composer',
  'confirm',
  'content',
  'current',
  'data',
  'default',
  'delete',
  'dialog',
  'dropdown',
  'element',
  'embedded',
  'extra',
  'field',
  'floating',
  'folder',
  'folders',
  'full',
  'fullscreen',
  'gif',
  'global',
  'gramjs',
  'header',
  'helper',
  'helpers',
  'hook',
  'hooks',
  'icon',
  'icons',
  'info',
  'input',
  'item',
  'items',
  'left',
  'list',
  'main',
  'manage',
  'management',
  'menu',
  'meta',
  'method',
  'methods',
  'middle',
  'modal',
  'modals',
  'option',
  'options',
  'outgoing',
  'pane',
  'panes',
  'panel',
  'payment',
  'picker',
  'prepared',
  'preview',
  'price',
  'profile',
  'render',
  'result',
  'results',
  'right',
  'screen',
  'sections',
  'selector',
  'setting',
  'settings',
  'share',
  'shared',
  'status',
  'summary',
  'surface',
  'tag',
  'tags',
  'text',
  'toggle',
  'tooltip',
  'type',
  'types',
  'ui',
  'update',
  'updates',
  'util',
  'utils',
  'user',
  'users',
  'value',
  'video',
  'view',
  'with',
]);

function parseArgs(argv) {
  const args = {
    outputPath: DEFAULT_OUTPUT_PATH,
    minStepCount: 6,
    specificityPercentile: 0.88,
    rootLabel: DEFAULT_ROOT_LABEL,
    mode: DEFAULT_MODE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--output-path') {
      args.outputPath = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === '--min-step-count') {
      args.minStepCount = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === '--specificity-percentile') {
      args.specificityPercentile = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === '--root-label') {
      args.rootLabel = String(argv[index + 1] || '').trim() || DEFAULT_ROOT_LABEL;
      index += 1;
      continue;
    }

    if (current === '--mode') {
      args.mode = String(argv[index + 1] || '').trim() || DEFAULT_MODE;
      index += 1;
    }
  }

  if (!Number.isFinite(args.minStepCount) || args.minStepCount < 0) {
    throw new Error('Pass a non-negative number to --min-step-count.');
  }

  if (!Number.isFinite(args.specificityPercentile) || args.specificityPercentile < 0 || args.specificityPercentile > 1) {
    throw new Error('Pass a number in [0, 1] to --specificity-percentile.');
  }

  if (!['raw', 'ui-availability'].includes(args.mode)) {
    throw new Error('Pass --mode raw or --mode ui-availability.');
  }

  return args;
}

function createTreeNode(label, children = []) {
  return { label, children };
}

function renderTreeText(node) {
  const lines = [node.label];

  function walk(childNode, prefix, isLast) {
    const branch = isLast ? 'в””в”Ђ ' : 'в”њв”Ђ ';
    lines.push(`${prefix}${branch}${childNode.label}`);
    const nextPrefix = `${prefix}${isLast ? '   ' : 'в”‚  '}`;
    childNode.children.forEach((nestedChild, index) => {
      walk(nestedChild, nextPrefix, index === childNode.children.length - 1);
    });
  }

  node.children.forEach((child, index) => {
    walk(child, '', index === node.children.length - 1);
  });

  return lines.join('\n');
}

function normalizeCount(value) {
  return typeof value === 'number' ? value : Number(value || 0);
}

function toTitleLabel(token) {
  return `${token[0].toUpperCase()}${token.slice(1)}`;
}

function normalizeUiConceptToken(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized.endsWith('ies') && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (normalized.endsWith('s') && !normalized.endsWith('ss') && normalized.length > 4) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

function tokenizeUiConceptText(...values) {
  return [...new Set(values
    .flatMap((value) => String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/))
    .map((token) => normalizeUiConceptToken(token))
    .filter((token) => token.length >= 4)
    .filter((token) => !UI_TOKEN_STOP_WORDS.has(token)))];
}

async function collectUiAvailabilityRows(driver, database) {
  const [surfaceRows, fnRows] = await Promise.all([
    runReadQuery(
      driver,
      database,
      `
        MATCH (surface:ViewSurface)
        WHERE coalesce(surface.owner_repo_relative_path, '') STARTS WITH 'src/'
        RETURN 'surface' AS kind,
               surface.key AS key,
               surface.owner_name AS name,
               surface.owner_repo_relative_path AS path
      `,
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (fn:Fn)
        WHERE coalesce(fn.repo_relative_path, '') STARTS WITH 'src/'
        RETURN 'fn' AS kind,
               fn.stableId AS key,
               fn.name AS name,
               fn.repo_relative_path AS path
      `,
    ),
  ]);

  return [...surfaceRows, ...fnRows]
    .map((row) => ({
      kind: row.kind,
      key: String(row.key || ''),
      name: String(row.name || '').trim(),
      path: String(row.path || '').trim(),
      tokens: tokenizeUiConceptText(row.name, row.path),
    }))
    .filter((row) => row.key && row.tokens.length);
}

async function collectUiCapabilityGraph(driver, database) {
  const [capabilityRows, surfaceRows, edgeRows] = await Promise.all([
    runReadQuery(
      driver,
      database,
      `
        MATCH (cap:UiCapability)
        WHERE cap.source = $source
        RETURN cap.key AS key,
               cap.token AS token,
               cap.label AS label,
               coalesce(cap.surface_support, 0) AS surfaceSupport,
               coalesce(cap.intent_support, 0) AS intentSupport,
               coalesce(cap.total_support, 0) AS totalSupport,
               coalesce(cap.samples, []) AS samples
      `,
      { source: UI_CAPABILITY_SOURCE },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (surface:ViewSurface)-[rel:IMPLEMENTS_UI_CAPABILITY]->(cap:UiCapability)
        WHERE rel.source = $source
        RETURN surface.key AS surfaceKey,
               surface.owner_name AS ownerName,
               cap.key AS capabilityKey,
               cap.token AS token
      `,
      { source: UI_CAPABILITY_SOURCE },
    ),
    runReadQuery(
      driver,
      database,
      `
        MATCH (sourceCap:UiCapability)-[rel:MAKES_AVAILABLE]->(targetCap:UiCapability)
        WHERE rel.source = $source
        RETURN sourceCap.key AS fromCapabilityKey,
               sourceCap.token AS fromToken,
               targetCap.key AS toCapabilityKey,
               targetCap.token AS toToken,
               coalesce(rel.count, 0) AS count,
               coalesce(rel.surface_count, 0) AS surfaceCount,
               coalesce(rel.sample_owner_names, []) AS sampleOwnerNames,
               coalesce(rel.sample_handler_names, []) AS sampleHandlerNames
      `,
      { source: UI_CAPABILITY_SOURCE },
    ),
  ]);

  return {
    capabilities: capabilityRows.map((row) => ({
      key: String(row.key || ''),
      token: String(row.token || ''),
      label: String(row.label || '').trim() || toTitleLabel(String(row.token || '')),
      surfaceSupport: normalizeCount(row.surfaceSupport),
      intentSupport: normalizeCount(row.intentSupport),
      totalSupport: normalizeCount(row.totalSupport),
      samples: Array.isArray(row.samples) ? row.samples.map((value) => String(value || '').trim()).filter(Boolean) : [],
    })).filter((row) => row.key && row.token),
    surfaceLinks: surfaceRows.map((row) => ({
      surfaceKey: String(row.surfaceKey || ''),
      ownerName: String(row.ownerName || '').trim(),
      capabilityKey: String(row.capabilityKey || ''),
      token: String(row.token || ''),
    })).filter((row) => row.surfaceKey && row.capabilityKey),
    availabilityEdges: edgeRows.map((row) => ({
      fromCapabilityKey: String(row.fromCapabilityKey || ''),
      fromToken: String(row.fromToken || ''),
      toCapabilityKey: String(row.toCapabilityKey || ''),
      toToken: String(row.toToken || ''),
      count: normalizeCount(row.count),
      surfaceCount: normalizeCount(row.surfaceCount),
      sampleOwnerNames: Array.isArray(row.sampleOwnerNames) ? row.sampleOwnerNames.map((value) => String(value || '').trim()).filter(Boolean) : [],
      sampleHandlerNames: Array.isArray(row.sampleHandlerNames) ? row.sampleHandlerNames.map((value) => String(value || '').trim()).filter(Boolean) : [],
    })).filter((row) => row.fromCapabilityKey && row.toCapabilityKey),
  };
}

function buildUiConceptCandidates(rows) {
  const candidatesByToken = new Map();

  rows.forEach((row) => {
    row.tokens.forEach((token) => {
      const current = candidatesByToken.get(token) || {
        token,
        rowKeys: new Set(),
        surfaceKeys: new Set(),
        fnKeys: new Set(),
        sampleNames: new Set(),
      };

      current.rowKeys.add(row.key);
      if (row.kind === 'surface') {
        current.surfaceKeys.add(row.key);
      } else {
        current.fnKeys.add(row.key);
      }
      if (row.name) {
        current.sampleNames.add(row.name);
      }
      candidatesByToken.set(token, current);
    });
  });

  const totalRows = Math.max(rows.length, 1);
  return [...candidatesByToken.values()]
    .map((candidate) => ({
      token: candidate.token,
      label: toTitleLabel(candidate.token),
      surfaceSupport: candidate.surfaceKeys.size,
      fnSupport: candidate.fnKeys.size,
      totalSupport: candidate.rowKeys.size,
      coverageRatio: candidate.rowKeys.size / totalRows,
      rowKeys: candidate.rowKeys,
      samples: [...candidate.sampleNames].sort().slice(0, 12),
    }))
    .filter((candidate) => candidate.totalSupport >= 2)
    .filter((candidate) => candidate.coverageRatio <= 0.35)
    .sort((left, right) => right.surfaceSupport - left.surfaceSupport || right.fnSupport - left.fnSupport || right.totalSupport - left.totalSupport || left.token.localeCompare(right.token));
}

function buildTokenBridgeCountMap(rows) {
  const bridgeCounts = new Map();

  rows.forEach((row) => {
    const uniqueTokens = [...new Set(row.tokens)].sort();
    for (let leftIndex = 0; leftIndex < uniqueTokens.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < uniqueTokens.length; rightIndex += 1) {
        const key = `${uniqueTokens[leftIndex]}\u0000${uniqueTokens[rightIndex]}`;
        bridgeCounts.set(key, (bridgeCounts.get(key) || 0) + 1);
      }
    }
  });

  return bridgeCounts;
}

function countConceptBridgeRows(leftCandidate, rightCandidate, bridgeCounts) {
  const [leftToken, rightToken] = [leftCandidate.token, rightCandidate.token].sort();
  return bridgeCounts.get(`${leftToken}\u0000${rightToken}`) || 0;
}

function buildUiAvailabilityTree(rootLabel, rows) {
  const candidates = buildUiConceptCandidates(rows);
  const bridgeCounts = buildTokenBridgeCountMap(rows);
  const screenCandidatePool = candidates
    .filter((candidate) => candidate.surfaceSupport >= 2)
    .filter((candidate) => candidate.surfaceSupport >= Math.max(2, Math.floor(candidate.fnSupport * 0.02)));
  const actionCandidatePool = candidates
    .filter((candidate) => candidate.fnSupport >= 2)
    .filter((candidate) => candidate.surfaceSupport < candidate.fnSupport);

  const screenConcepts = screenCandidatePool
    .map((candidate) => {
      const bridgeSupport = screenCandidatePool.reduce((sum, otherCandidate) => {
        if (otherCandidate.token === candidate.token) {
          return sum;
        }

        return sum + Math.min(3, countConceptBridgeRows(candidate, otherCandidate, bridgeCounts));
      }, 0);

      return {
        ...candidate,
        selectionScore: (candidate.surfaceSupport * 4) + bridgeSupport,
      };
    })
    .sort((left, right) => right.selectionScore - left.selectionScore || right.surfaceSupport - left.surfaceSupport || left.token.localeCompare(right.token))
    .slice(0, 12);

  const actionConcepts = actionCandidatePool
    .map((candidate) => {
      const bridgeSupport = screenConcepts.reduce((sum, screenCandidate) => sum + Math.min(4, countConceptBridgeRows(screenCandidate, candidate, bridgeCounts)), 0);
      return {
        ...candidate,
        selectionScore: (bridgeSupport * 8) + Math.min(candidate.fnSupport, 40),
      };
    })
    .filter((candidate) => candidate.selectionScore >= 12)
    .sort((left, right) => right.selectionScore - left.selectionScore || right.fnSupport - left.fnSupport || left.token.localeCompare(right.token))
    .slice(0, 18);

  const screenByToken = new Map(screenConcepts.map((candidate) => [candidate.token, candidate]));
  const childrenByToken = new Map();
  const assignedScreenParent = new Map();
  const assignedActionParent = new Map();

  screenConcepts.forEach((childCandidate) => {
    let bestParent;
    let bestScore = 0;

    screenConcepts.forEach((parentCandidate) => {
      if (parentCandidate.token === childCandidate.token) {
        return;
      }
      if (parentCandidate.surfaceSupport <= childCandidate.surfaceSupport) {
        return;
      }

      const bridgeCount = countConceptBridgeRows(parentCandidate, childCandidate, bridgeCounts);
      if (!bridgeCount) {
        return;
      }

      const score = (bridgeCount * 10) + Math.min(parentCandidate.surfaceSupport, 20);
      if (score > bestScore) {
        bestScore = score;
        bestParent = parentCandidate;
      }
    });

    if (bestParent) {
      assignedScreenParent.set(childCandidate.token, bestParent.token);
      const currentChildren = childrenByToken.get(bestParent.token) || [];
      currentChildren.push(childCandidate.token);
      childrenByToken.set(bestParent.token, currentChildren);
    }
  });

  actionConcepts.forEach((actionCandidate) => {
    if (screenByToken.has(actionCandidate.token)) {
      return;
    }

    let bestParent;
    let bestScore = 0;

    screenConcepts.forEach((screenCandidate) => {
      const bridgeCount = countConceptBridgeRows(screenCandidate, actionCandidate, bridgeCounts);
      if (!bridgeCount) {
        return;
      }

      const score = (bridgeCount * 10) + Math.min(screenCandidate.surfaceSupport, 20) - Math.floor(actionCandidate.fnSupport / 200);
      if (score > bestScore) {
        bestScore = score;
        bestParent = screenCandidate;
      }
    });

    if (bestParent && bestScore >= 10) {
      assignedActionParent.set(actionCandidate.token, bestParent.token);
      const currentChildren = childrenByToken.get(bestParent.token) || [];
      currentChildren.push(actionCandidate.token);
      childrenByToken.set(bestParent.token, currentChildren);
    }
  });

  const conceptByToken = new Map([...screenConcepts, ...actionConcepts].map((candidate) => [candidate.token, candidate]));
  const rendered = new Set();

  function buildConceptNode(token, depth = 0) {
    if (rendered.has(`${token}:${depth}`)) {
      return createTreeNode(conceptByToken.get(token)?.label || token);
    }

    rendered.add(`${token}:${depth}`);
    const childTokens = [...new Set(childrenByToken.get(token) || [])]
      .filter((childToken) => childToken !== token)
      .sort((left, right) => {
        const leftCandidate = conceptByToken.get(left);
        const rightCandidate = conceptByToken.get(right);
        return (rightCandidate?.totalSupport || 0) - (leftCandidate?.totalSupport || 0)
          || String(leftCandidate?.label || '').localeCompare(String(rightCandidate?.label || ''));
      });

    return createTreeNode(
      conceptByToken.get(token)?.label || token,
      childTokens.map((childToken) => buildConceptNode(childToken, depth + 1)),
    );
  }

  const rootScreenTokens = screenConcepts
    .map((candidate) => candidate.token)
    .filter((token) => !assignedScreenParent.has(token));

  const screenNodes = rootScreenTokens.map((token) => buildConceptNode(token));
  return {
    tree: createTreeNode(rootLabel, screenNodes.length ? [createTreeNode('Р­РєСЂР°РЅС‹', screenNodes)] : []),
    evidence: {
      rowCount: rows.length,
      screenConcepts: screenConcepts.map((candidate) => ({
        token: candidate.token,
        label: candidate.label,
        surfaceSupport: candidate.surfaceSupport,
        totalSupport: candidate.totalSupport,
      })),
      actionConcepts: actionConcepts
        .filter((candidate) => assignedActionParent.has(candidate.token))
        .map((candidate) => ({
          token: candidate.token,
          label: candidate.label,
          fnSupport: candidate.fnSupport,
          totalSupport: candidate.totalSupport,
          parent: assignedActionParent.get(candidate.token),
        })),
    },
  };
}

function buildUiAvailabilityTreeFromCapabilityGraph(rootLabel, capabilityGraph) {
  const capabilityByKey = new Map(capabilityGraph.capabilities.map((row) => [row.key, row]));
  const outgoingByKey = new Map();
  const incomingCountByKey = new Map();
  const rootSupportByKey = new Map();

  capabilityGraph.surfaceLinks.forEach((row) => {
    rootSupportByKey.set(row.capabilityKey, (rootSupportByKey.get(row.capabilityKey) || 0) + 1);
  });

  capabilityGraph.availabilityEdges.forEach((row) => {
    const current = outgoingByKey.get(row.fromCapabilityKey) || [];
    current.push(row);
    outgoingByKey.set(row.fromCapabilityKey, current);
    incomingCountByKey.set(row.toCapabilityKey, (incomingCountByKey.get(row.toCapabilityKey) || 0) + 1);
  });

  const rootCapabilities = capabilityGraph.capabilities
    .filter((row) => (rootSupportByKey.get(row.key) || 0) > 0)
    .sort((left, right) => (rootSupportByKey.get(right.key) || 0) - (rootSupportByKey.get(left.key) || 0)
      || right.surfaceSupport - left.surfaceSupport
      || right.totalSupport - left.totalSupport
      || left.label.localeCompare(right.label));

  const renderedPathKeys = new Set();

  function buildCapabilityNode(capabilityKey, depth = 0) {
    const capability = capabilityByKey.get(capabilityKey);
    if (!capability) {
      return undefined;
    }

    const pathKey = `${capabilityKey}:${depth}`;
    if (renderedPathKeys.has(pathKey)) {
      return createTreeNode(capability.label);
    }

    renderedPathKeys.add(pathKey);
    const childNodes = (outgoingByKey.get(capabilityKey) || [])
      .filter((edge) => edge.toCapabilityKey !== capabilityKey)
      .sort((left, right) => right.count - left.count || right.surfaceCount - left.surfaceCount || String(left.toToken).localeCompare(String(right.toToken)))
      .slice(0, 6)
      .map((edge) => (depth >= 2 ? undefined : buildCapabilityNode(edge.toCapabilityKey, depth + 1)))
      .filter(Boolean);

    return createTreeNode(capability.label, childNodes);
  }

  const screenNodes = rootCapabilities
    .filter((row) => (incomingCountByKey.get(row.key) || 0) === 0 || (rootSupportByKey.get(row.key) || 0) >= 2)
    .slice(0, 18)
    .map((row) => buildCapabilityNode(row.key))
    .filter(Boolean);

  return {
    tree: createTreeNode(rootLabel, screenNodes.length ? [createTreeNode('Р­РєСЂР°РЅС‹', screenNodes)] : []),
    evidence: {
      capabilityCount: capabilityGraph.capabilities.length,
      surfaceLinkCount: capabilityGraph.surfaceLinks.length,
      availabilityEdgeCount: capabilityGraph.availabilityEdges.length,
      rootCapabilities: rootCapabilities.slice(0, 18).map((row) => ({
        token: row.token,
        label: row.label,
        surfaceSupport: row.surfaceSupport,
        intentSupport: row.intentSupport,
        rootSupport: rootSupportByKey.get(row.key) || 0,
      })),
      availabilityEdges: capabilityGraph.availabilityEdges.slice(0, 24).map((row) => ({
        from: row.fromToken,
        to: row.toToken,
        count: row.count,
        sampleOwnerNames: row.sampleOwnerNames,
        sampleHandlerNames: row.sampleHandlerNames,
      })),
    },
  };
}

function rewriteRootLabel(treeText, rootLabel) {
  const normalizedText = String(treeText || '').trim();
  if (!normalizedText) {
    return rootLabel;
  }

  const lines = normalizedText.split(/\r?\n/);
  lines[0] = rootLabel;
  return lines.join('\n');
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

async function main() {
  loadProjectEnv();
  const args = parseArgs(process.argv.slice(2));
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
  );

  try {
    if (args.mode === 'ui-availability') {
      const capabilityGraph = await collectUiCapabilityGraph(driver, database);
      if (!capabilityGraph.capabilities.length) {
        throw new Error('UiCapability layer is unavailable in Neo4j. Materialize the new UI capability graph first; no heuristic fallback is allowed.');
      }

      const { tree, evidence } = buildUiAvailabilityTreeFromCapabilityGraph(args.rootLabel, capabilityGraph);
      const fileContent = renderTreeText(tree);
      writeTextFile(args.outputPath, fileContent);

      console.log(JSON.stringify({
        saved: true,
        mode: args.mode,
        outputPath: args.outputPath,
        usedCapabilityLayer: true,
        evidence,
      }, null, 2));
      return;
    }

    const result = await loadFunctionalityTreeFromGraph(driver, database, {
      minStepCount: args.minStepCount,
      specificityPercentile: args.specificityPercentile,
    });

    if (!result.available || !result.text) {
      throw new Error(result.error || 'Functionality tree is unavailable.');
    }

    const fileContent = rewriteRootLabel(result.text, args.rootLabel);
    writeTextFile(args.outputPath, fileContent);

    console.log(JSON.stringify({
      saved: true,
      mode: args.mode,
      outputPath: args.outputPath,
      routeCount: result.routeCount,
      featureLayerRootCount: JSON.parse(result.payload || '{}')?.featureLayerRootLabels?.length || 0,
    }, null, 2));
  } finally {
    await driver.close();
  }
}

await main();
