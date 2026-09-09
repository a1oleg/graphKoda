import fs from 'node:fs';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';

config({ path: 'graph/.env', quiet: true });
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(
  process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
const session = driver.session({ database: process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j' });
const snapshot = 'tmp/reimport-annotations-before.json';
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
try {
  const annotations = (await session.run('MATCH (a:Annotation) RETURN properties(a) AS props'))
    .records.map(r => stable(r.get('props'))).sort();
  if (process.argv.includes('--before')) {
    fs.writeFileSync(snapshot, JSON.stringify(annotations, null, 2));
    console.log(JSON.stringify({ snapshot, annotations: annotations.length }));
  } else {
    const before = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    const missing = before.filter(a => !annotations.includes(a));
    const checks = {};
    for (const [name, query] of Object.entries({
      conflicts: 'MATCH (n:System:DeveloperDefined) RETURN count(n) AS count',
      annotationLinks: 'MATCH ()-[r:HAS_ANNOTATION]->() RETURN count(r) AS count',
      detachedAnnotations: 'MATCH (a:Annotation) WHERE NOT ()-[:HAS_ANNOTATION]->(a) RETURN count(a) AS count',
      duplicateStableIds: 'MATCH (n) WHERE n.stableId IS NOT NULL WITH n.stableId AS id, count(*) AS c WHERE c > 1 RETURN count(*) AS count',
      nodes: 'MATCH (n) RETURN count(n) AS count',
      edges: 'MATCH ()-[r]->() RETURN count(r) AS count',
      importedNodes: 'MATCH (n) WHERE NOT n:Annotation AND NOT n:GraphImportRun RETURN count(n) AS count',
      importedEdges: 'MATCH (a)-[r]->(b) WHERE NOT a:Annotation AND NOT b:Annotation RETURN count(r) AS count',
    })) checks[name] = (await session.run(query)).records[0].get('count').toNumber();
    const report = { annotationsBefore: before.length, annotationsAfter: annotations.length,
      missingOrChangedAnnotations: missing.length, ...checks };
    const logIndex = process.argv.indexOf('--log');
    if (logIndex >= 0) {
      const summary = fs.readFileSync(process.argv[logIndex + 1], 'utf8').split(/\r?\n/)
        .filter(line => line.startsWith('{')).map(line => JSON.parse(line)).findLast(row => row.counts?.canonicalEntities);
      if (!summary?.ok) throw new Error('No successful full import summary');
      report.catalogNodes = summary.counts.canonicalEntities;
      report.catalogEdges = summary.counts.canonicalRelationships;
      report.catalogMatchesDatabase = report.importedNodes === report.catalogNodes && report.importedEdges === report.catalogEdges;
      report.elapsedSeconds = summary.elapsedSeconds;
    }
    fs.writeFileSync('tmp/reimport-verification.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (missing.length || checks.conflicts || checks.duplicateStableIds || report.catalogMatchesDatabase === false) process.exitCode = 1;
  }
} finally { await session.close(); await driver.close(); }
