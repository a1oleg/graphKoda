import fs from 'node:fs';
import path from 'node:path';

import neo4j from 'neo4j-driver';

import { insertDrawioAnnotation } from '../graph/packages/orchestrator/src/orchestrator.js';

function parseArgs(argv) {
  const result = {
    sourcePath: '',
    targetPath: '',
    dryRun: false,
    databaseOnly: false,
    orphanStableIds: new Map(),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') result.sourcePath = argv[++index] || '';
    else if (arg === '--target') result.targetPath = argv[++index] || '';
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--database-only') result.databaseOnly = true;
    else if (arg === '--orphan') {
      const mapping = String(argv[++index] || '');
      const separator = mapping.indexOf('=');
      if (separator <= 0 || separator === mapping.length - 1) {
        throw new Error('--orphan expects <annotation-cell-id>=<stableId>.');
      }
      result.orphanStableIds.set(mapping.slice(0, separator), mapping.slice(separator + 1));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!result.sourcePath || (!result.targetPath && !result.databaseOnly)) {
    throw new Error('Pass --source and --target draw.io paths, or use --database-only with --source.');
  }
  return result;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!/^\s*[^#][^=]*=/.test(line)) continue;
    const separator = line.indexOf('=');
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function localNeo4jConfig() {
  const env = { ...readEnvFile(path.resolve('graph', '.env')), ...process.env };
  const password = env.NEO4J_PASSWORD;
  if (!password) throw new Error('NEO4J_PASSWORD is missing from graph/.env.');
  return {
    uri: env.NEO4J_URI || env.GRAPH_NEO4J_URI || 'neo4j://127.0.0.1:7687',
    user: env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j',
    password,
    database: env.NEO4J_DATABASE || env.NEO4J_DB || 'neo4j',
  };
}

function decodeXmlAttribute(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/gu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/gu)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

function readCells(xml) {
  return [...xml.matchAll(/<mxCell\b([^>]*)>/gu)].map((match) => parseAttributes(match[1]));
}

function coordinateStableId(stableId) {
  return String(stableId || '').match(/^(.*?:\d+:\d+:\d+:\d+)/u)?.[1] || String(stableId || '');
}

function cellScore(cell) {
  let score = 0;
  if (/^n\d+$/u.test(cell.id || '')) score += 100;
  if (cell.vertex === '1') score += 20;
  if (!cell.visualProxyStableId) score += 5;
  if (!/-part-|^fold-row-/u.test(cell.id || '')) score += 5;
  return score;
}

function typeFromLabels(labels = []) {
  const labelSet = new Set(labels);
  return [
    ['Function', 'function'],
    ['Loop', 'loop'],
    ['Branch', 'branch'],
    ['LocalValue', 'variable-path'],
    ['Variable', 'variable-path'],
    ['ValueAccess', 'variable-path'],
    ['Expression', 'expression'],
    ['Operand', 'expression'],
    ['Setting', 'external'],
    ['UiSurface', 'external'],
    ['ExternalTarget', 'external'],
  ].find(([label]) => labelSet.has(label))?.[1] || 'node';
}

function resolveImports(sourceXml, targetXml, orphanStableIds) {
  const sourceCells = readCells(sourceXml);
  const sourceById = new Map(sourceCells.map((cell) => [cell.id, cell]));
  const targetCells = readCells(targetXml);
  const targetByStableId = new Map();
  for (const cell of targetCells) {
    if (!cell.stableId) continue;
    const variants = [cell.stableId, coordinateStableId(cell.stableId)];
    for (const stableId of variants) {
      const candidates = targetByStableId.get(stableId) || [];
      candidates.push(cell);
      targetByStableId.set(stableId, candidates);
    }
  }

  const annotations = sourceCells.filter((cell) => (
    cell.graphKind === 'Annotation' || cell.annotationEmbedded === '1'
  ));
  const imports = annotations.map((annotation) => {
    const embedded = annotation.annotationEmbedded === '1';
    const sourceTarget = embedded ? annotation : sourceById.get(annotation.annotationTargetId);
    const requestedStableId = sourceTarget?.stableId || orphanStableIds.get(annotation.id) || '';
    if (!requestedStableId) {
      throw new Error(`Annotation ${annotation.id} has no resolvable target stableId.`);
    }
    const stableId = coordinateStableId(requestedStableId);
    const candidates = [
      ...(targetByStableId.get(requestedStableId) || []),
      ...(targetByStableId.get(stableId) || []),
    ];
    const uniqueCandidates = [...new Map(candidates.map((cell) => [cell.id, cell])).values()]
      .sort((left, right) => cellScore(right) - cellScore(left));
    const target = uniqueCandidates[0];
    if (!target) throw new Error(`Target ${requestedStableId} for ${annotation.id} is absent from the working diagram.`);
    const text = String(annotation.annotationSavedText || annotation.value || '').trim();
    if (!text) throw new Error(`Annotation ${annotation.id} has empty text.`);
    const labels = String(target.graphLabels || '').split(',').filter(Boolean);
    return {
      sourceAnnotationId: annotation.id,
      sourceTargetCellId: embedded ? annotation.id : annotation.annotationTargetId,
      targetCellId: target.id,
      stableId: coordinateStableId(target.stableId || stableId),
      text,
      type: typeFromLabels(labels),
      toolGitCommitShortHash: annotation.annotationToolGitCommitShortHash || null,
      maxDepth: annotation.annotationMaxDepth ? Number(annotation.annotationMaxDepth) : null,
    };
  });
  const stableIds = new Set();
  for (const item of imports) {
    if (stableIds.has(item.stableId)) throw new Error(`Multiple source annotations resolve to ${item.stableId}.`);
    stableIds.add(item.stableId);
  }
  return imports;
}

async function validateDatabaseTargets(session, stableIds) {
  const result = await session.run(`
    UNWIND $stableIds AS stableId
    OPTIONAL MATCH (head {stableId: stableId})
    RETURN stableId, count(head) AS matches
    ORDER BY stableId
  `, { stableIds });
  const invalid = result.records
    .map((record) => ({ stableId: record.get('stableId'), matches: record.get('matches').toNumber() }))
    .filter((row) => row.matches !== 1);
  if (invalid.length) {
    throw new Error(`Database targets must resolve exactly once: ${JSON.stringify(invalid)}`);
  }
}

async function persistAnnotations(session, imports) {
  const updatedAt = new Date().toISOString();
  const result = await session.executeWrite((transaction) => transaction.run(`
    UNWIND $rows AS row
    MATCH (head {stableId: row.stableId})
    MERGE (head)-[:HAS_ANNOTATION]->(annotation:Annotation {headID: row.stableId})
    SET annotation.text = row.text,
        annotation.type = row.type,
        annotation.source = 'drawio-copy-import',
        annotation.toolGitCommitShortHash = row.toolGitCommitShortHash,
        annotation.maxDepth = row.maxDepth,
        annotation.updatedAt = $updatedAt
    REMOVE head.graph_annotation_text,
           head.graph_annotation_updated_at,
           head.graph_annotation_source
    RETURN count(annotation) AS updated
  `, { rows: imports, updatedAt }));
  return result.records[0]?.get('updated')?.toNumber?.() || 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const sourcePath = path.resolve(args.sourcePath);
  const targetPath = args.targetPath ? path.resolve(args.targetPath) : '';
  const sourceXml = fs.readFileSync(sourcePath, 'utf8');
  const targetXml = targetPath ? fs.readFileSync(targetPath, 'utf8') : sourceXml;
  const imports = resolveImports(sourceXml, targetXml, args.orphanStableIds);
  const config = localNeo4jConfig();
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  try {
    const session = driver.session({ database: config.database });
    try {
      await validateDatabaseTargets(session, imports.map((item) => item.stableId));
      if (args.dryRun) {
        console.log(JSON.stringify({ ok: true, dryRun: true, databaseOnly: args.databaseOnly, count: imports.length, imports }, null, 2));
        return;
      }

      if (args.databaseOnly) {
        const updated = await persistAnnotations(session, imports);
        if (updated !== imports.length) {
          throw new Error(`Expected ${imports.length} persisted annotations, got ${updated}.`);
        }
        console.log(JSON.stringify({ ok: true, count: imports.length, persisted: updated, inserted: 0, databaseOnly: true }, null, 2));
        return;
      }

      const temporaryPath = `${targetPath}.annotations-import.tmp.drawio`;
      fs.copyFileSync(targetPath, temporaryPath);
      try {
        for (const item of imports) {
          insertDrawioAnnotation({
            diagramPath: temporaryPath,
            element: { cellId: item.targetCellId },
            annotationText: item.text,
            annotationMetadata: {
              toolGitCommitShortHash: item.toolGitCommitShortHash,
              maxDepth: item.maxDepth,
            },
            replaceExistingForTarget: true,
          });
        }
        const updated = await persistAnnotations(session, imports);
        if (updated !== imports.length) {
          throw new Error(`Expected ${imports.length} persisted annotations, got ${updated}.`);
        }
        fs.copyFileSync(temporaryPath, targetPath);
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
      console.log(JSON.stringify({ ok: true, count: imports.length, persisted: imports.length, inserted: imports.length }, null, 2));
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

await main();
