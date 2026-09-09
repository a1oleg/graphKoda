import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { inferAnnotationKind, annotationProfileContract } from '../graph/packages/orchestrator/src/orchestrator/annotationProfiles.js';

export function summarizeGroups(rows, registeredLabels = []) {
  const groups = new Map();
  for (const row of rows) {
    const labels = [...row.labels].sort();
    const key = JSON.stringify([labels, row.explicitKind]);
    const group = groups.get(key) || { labels, explicitKind: row.explicitKind, count: 0, examples: [] };
    group.count += row.count;
    if (row.example && group.examples.length < 3) group.examples.push(row.example);
    groups.set(key, group);
  }
  const counts = new Map(registeredLabels.map(label => [label, 0]));
  const pairs = new Map();
  const combinations = [...groups.values()].map(group => {
    for (const label of group.labels) counts.set(label, (counts.get(label) || 0) + group.count);
    for (let i = 0; i < group.labels.length; i++) for (let j = i + 1; j < group.labels.length; j++) {
      const key = JSON.stringify([group.labels[i], group.labels[j]]);
      pairs.set(key, (pairs.get(key) || 0) + group.count);
    }
    const inferredKind = inferAnnotationKind(group.labels, group.explicitKind);
    return { ...group, inferredKind, profile: annotationProfileContract[inferredKind] || null,
      withoutExplicitKind: inferAnnotationKind(group.labels),
      decisiveLabels: group.labels.filter(label => inferAnnotationKind(group.labels.filter(x => x !== label), group.explicitKind) !== inferredKind),
    };
  }).sort((a, b) => b.count - a.count);
  const intersections = [...pairs].map(([key, count]) => {
    const [left, right] = JSON.parse(key);
    return { left, right, count, leftCoverage: count / counts.get(left), rightCoverage: count / counts.get(right),
      identical: count === counts.get(left) && count === counts.get(right) };
  }).sort((a, b) => b.count - a.count);
  return { totalNodes: combinations.reduce((sum, x) => sum + x.count, 0),
    labels: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    combinations, intersections };
}

function sourceReferences(labels) {
  const files = execFileSync('rg', ['--files', 'graph', 'dev'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split(/\r?\n/).filter(file => /\.(?:[cm]?[jt]sx?|py)$/.test(file)
      && !/node_modules|[\\/]generated[\\/]|auditGraphLabels/.test(file));
  const refs = new Map(labels.map(({ label }) => [label, { mentions: 0, files: new Set(), examples: [] }]));
  for (const file of files) {
    const area = /[\\/]static-extract[\\/]/.test(file) ? 'extractor' : /test\./.test(file) ? 'test' : 'consumer-or-importer';
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const token of new Set(line.match(/[A-Za-z_][A-Za-z_0-9]*/g) || [])) {
        const entry = refs.get(token);
        if (!entry) continue;
        entry.mentions++;
        entry.files.add(file);
        if (entry.examples.filter(x => x.area === area).length < 4) entry.examples.push({ file, line: index + 1, area, text: line.trim().slice(0, 240) });
      }
    });
  }
  return Object.fromEntries([...refs].map(([label, row]) => [label, { ...row, files: [...row.files] }]));
}

function markdown(report) {
  const table = rows => rows.map(row => `| ${row.join(' | ')} |`).join('\n');
  const duplicate = report.intersections.filter(x => x.identical);
  const shadowed = report.combinations.filter(x => x.explicitKind && x.inferredKind !== x.explicitKind);
  const missing = report.combinations.filter(x => x.inferredKind && !x.profile);
  const boundaries = report.combinations.filter(x => x.labels.includes('System') && x.labels.includes('DeveloperDefined'));
  return `# Graph Label Audit\n\nGenerated: ${report.generatedAt}; tool: ${report.toolCommit}. Read-only Neo4j queries.\n\n`
    + `Nodes: ${report.totalNodes}. Registered labels: ${report.labels.length}. Live labels: ${report.labels.filter(x => x.count).length}. Label/explicit-kind groups: ${report.combinations.length}.\n\n`
    + `## Interpretation\n\nExact co-occurrence is a candidate, not proof of redundancy. Source references are lexical evidence, not proven writers/readers. Profile selection below calls the current inferAnnotationKind; canonical/proxy resolution can change the final subject and is not reproduced here. Groups include annotationKind because labels alone do not determine the profile.\n\n`
    + `## Label Inventory\n\n| Label | Nodes | Source mentions | Files |\n|---|---:|---:|---:|\n`
    + table(report.labels.map(x => [x.label, x.count, report.sourceReferences[x.label].mentions, report.sourceReferences[x.label].files.length]))
    + `\n\n## Identical Populations\n\n| Left | Right | Common nodes |\n|---|---|---:|\n`
    + table(duplicate.map(x => [x.left, x.right, x.count]))
    + `\n\n## Missing Profile Registrations\n\n| Selected kind | Nodes | Example |\n|---|---:|---|\n`
    + table(missing.map(x => [x.inferredKind, x.count, x.examples[0] || '']))
    + `\n\n## Mixed System / Developer Boundary\n\n| Labels | Nodes | Selected kind | Example |\n|---|---:|---|---|\n`
    + table(boundaries.map(x => [x.labels.join(', '), x.count, x.inferredKind, x.examples[0] || '']))
    + `\n\n## Explicit Kind Overridden (Top 40)\n\n| Labels | Stored kind | Selected kind | Nodes | Example |\n|---|---|---|---:|---|\n`
    + table(shadowed.slice(0, 40).map(x => [x.labels.join(', '), x.explicitKind, x.inferredKind || 'reference', x.count, x.examples[0] || '']))
    + `\n\n## Largest Combinations (Top 60)\n\n| Labels | Stored kind | Selected kind | Nodes | Decisive labels |\n|---|---|---|---:|---|\n`
    + table(report.combinations.slice(0, 60).map(x => [x.labels.join(', '), x.explicitKind || '-', x.inferredKind || 'reference', x.count, x.decisiveLabels.join(', ')]))
    + '\n\nFull combinations, directional overlap ratios, examples, and source references are in labels.json.\n';
}

async function main() {
  config({ path: 'graph/.env', quiet: true });
  const outputIndex = process.argv.indexOf('--output');
  const output = path.resolve(outputIndex < 0 ? 'tmp/graph-label-audit' : process.argv[outputIndex + 1]);
  const database = process.env.NEO4J_DATABASE || process.env.NEO4J_DB || 'neo4j';
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER || process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
  const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
  try {
    const registered = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label');
    const result = await session.run(`
      MATCH (n)
      RETURN labels(n) AS labels, n.annotationKind AS explicitKind,
             count(*) AS count, min(n.stableId) AS example
    `);
    if (result.summary.counters.containsUpdates()) throw new Error('Audit must not mutate the graph');
    const report = summarizeGroups(result.records.map(r => ({ labels: r.get('labels'), explicitKind: r.get('explicitKind'),
      count: r.get('count').toNumber(), example: r.get('example') })), registered.records.map(r => r.get('label')));
    report.generatedAt = new Date().toISOString();
    report.database = database;
    report.toolCommit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    report.sourceReferences = sourceReferences(report.labels);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'labels.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'labels.md'), markdown(report));
    console.log(JSON.stringify({ output, totalNodes: report.totalNodes, registeredLabels: report.labels.length,
      liveLabels: report.labels.filter(x => x.count).length, groups: report.combinations.length,
      identicalPopulations: report.intersections.filter(x => x.identical) }, null, 2));
  } finally { await session.close(); await driver.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
