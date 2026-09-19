import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { auraConnection } from './fisherYatesConfig.mjs';
import { composeExpandedFunctions } from './expandedFunctionDrawio.mjs';
import { expandedFunctionView } from './expandedFunctionView.mjs';

const root = 'services/api/claude.ts:1022:0:2911:1';
const branch = 'services/api/claude.ts:1033:6:1033:26';
const functions = new Map([[root, { name: 'queryModel' }],
  ['services/api/modelCallGuard.ts:31:7:33:1', { name: 'isModelStubEnabled' }],
  ['services/api/modelCallGuard.ts:35:7:45:1', { name: 'recordStubbedModelCall' }]]);
const scope = 'model-stub-diff-af272b9e';
const source = 'semantic/functionFlowGraph';
const dir = 'tmp/model-stub';
fs.mkdirSync(dir, { recursive: true });
const env = dotenv.parse(fs.readFileSync('graph/.env'));
const local = neo4j.driver((env.NEO4J_URI || 'bolt://127.0.0.1:7687').replace('neo4j://', 'bolt://'),
  neo4j.auth.basic(env.NEO4J_USERNAME || env.NEO4J_USER || 'neo4j', env.NEO4J_PASSWORD));
const nodes = new Map(), edges = [], calls = [];
const props = input => Object.fromEntries(Object.entries(input).filter(([,v]) => v != null)
  .map(([k,v]) => [k, typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v]));
const plain = value => neo4j.isInt(value) ? value.toNumber() : Array.isArray(value) ? value.map(plain)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,plain(v)])) : value;
async function loadOwned(id) {
  const session = local.session({ database: env.NEO4J_DATABASE || 'neo4j' });
  try {
    const result = await session.run(`MATCH (n) WHERE n.stableId=$id OR n.parentFnStableId=$id
      RETURN n.stableId AS key, labels(n) AS labels, properties(n) AS props`, { id });
    const owned = result.records.map(r => plain(r.toObject()));
    const refs = [...new Set(owned.flatMap(n => [n.props.parentStepStableId,n.props.parentFlowBlockStableId]).filter(Boolean))];
    const facts = await session.run('MATCH (n) WHERE n.stableId IN $ids RETURN n.stableId AS key,labels(n) AS labels,properties(n) AS props', { ids:refs });
    const all = [...new Map([...owned,...facts.records.map(r => plain(r.toObject()))].map(n => [n.key,n])).values()];
    const rels = await session.run(`MATCH (a)-[r]->(b) WHERE a.stableId IN $ids AND b.stableId IN $ids
      RETURN a.stableId AS start,b.stableId AS end,type(r) AS type,properties(r) AS props`, { ids:all.map(n=>n.key) });
    return { nodes:all,semanticEdges:rels.records.map(r=>plain(r.toObject())) };
  } finally { await session.close(); }
}
try {
  for (const [id] of functions) {
    const graph = await loadOwned(id);
    fs.writeFileSync(`${dir}/${functions.get(id).name}.loaded.json`, JSON.stringify(graph, null, 2));
    let selected = graph.nodes;
    if (id === root) {
      selected = selected.filter(n => {
        const line = Number(n.props.startLine || n.props.start_line || n.key.match(/claude\.ts:(\d+):/)?.[1]);
        return n.key === root || n.key === `${root}:flow-start`
          || (n.labels.includes('FunctionEnd') && n.key.endsWith(':end'))
          || (line >= 1033 && line <= 1045);
      });
    }
    const ids = new Set(selected.map(n => n.key));
    const selectedEdges = graph.semanticEdges.filter(e => ids.has(e.start) && ids.has(e.end));
    if (id === root) {
      const start = selected.find(n => n.labels.includes('FunctionStart')) || selected.find(n => n.key === root);
      const end = selected.find(n => n.labels.includes('FunctionEnd'));
      assert(start && end, `Expected function boundary nodes: ${selected.filter(n => n.labels.some(l => /Fn|End|Start/.test(l))).map(n => `${n.key} ${n.labels}`).join(';')}`);
      selectedEdges.push({ start: start.key, end: branch, type: 'NEXT', props: { source, projectionReason: 'diff-entry' } });
      const boundary = `${scope}:outside-diff`;
      selected.push({ key: boundary, labels: ['Return', 'ValueAccess'], props: {
        stableId: boundary, parentFnStableId: root, name: 'Outside diff', diaName: 'Outside diff',
        source, sourceBacked: false, projectionBoundary: true,
      } });
      selectedEdges.push({ start: branch, end: boundary, type: 'FALSE', props: { source, projectionReason: 'excluded-original-body' } });
      selectedEdges.push({ start: boundary, end: end.key, type: 'NEXT', props: { source } });
    }
    for (const n of selected) {
      n.props = props(n.props);
      if (n.key === root) {
        for (const key of ['code','text','syntax','body','bodyText','sourceText','functionText']) delete n.props[key];
        n.props.diffRange = 'services/api/claude.ts:1033-1045';
      }
      if (n.key === 'services/api/claude.ts:1043:4:1043:17') {
        n.props.render_parts_json = JSON.stringify([
          { stableId: `${n.key}:yield`, text: 'yield', kind: 'keyword', labels: ['System','Keyword'], order: 0 },
          { stableId: `${n.key}:value`, text: 'message', kind: 'value', labels: ['Value','ValueAccess'], order: 1 },
        ]);
        n.props.render_parts_layout = 'horizontal';
      }
      n.props.extractionScope = scope;
      n.props.diffCommit = 'af272b9e82955330836f9354229c0a8453c3a3da';
      nodes.set(n.key, n);
    }
    edges.push(...selectedEdges);
  }
  const session = local.session({ database: env.NEO4J_DATABASE || 'neo4j' });
  try {
    const result = await session.run(`MATCH (a)-[:CALLS]->(b:Fn) WHERE a.stableId IN $ids AND b.stableId IN $functions
      RETURN DISTINCT a.stableId AS id, a.parentFnStableId AS owner, b.stableId AS callee`,
    { ids: [...nodes.keys()], functions: [...functions.keys()] });
    for (const record of result.records) {
      const call = record.toObject(); calls.push(call);
      edges.push({ start: call.id, end: call.callee, type: 'CALLS', props: { source } });
    }
  } finally { await session.close(); }
} finally { await local.close(); }
assert.equal(calls.length, 2);
for (const n of nodes.values()) assert(!/modelCallGuard\.test|spawnUtils|api\/client\.ts/.test(n.key));
fs.writeFileSync(`${dir}/graph.json`, JSON.stringify({ nodes: [...nodes.values()], edges, calls }, null, 2));
console.log(JSON.stringify({ nodes: nodes.size, edges: edges.length, calls }));
if (process.argv.includes('--inspect')) process.exit(0);
const aura = auraConnection();
try {
  await aura.session.executeWrite(async tx => {
    await tx.run('MATCH ()-[r {extractionScope:$scope}]->() DELETE r', { scope });
    await tx.run('MATCH (n {extractionScope:$scope}) WHERE NOT n.stableId IN $ids AND NOT (n)--() DELETE n',
      { scope, ids: [...nodes.keys()] });
    for (const [labels, rows] of Map.groupBy([...nodes.values()], n => n.labels.join(':'))) {
      assert.match(labels, /^[A-Za-z0-9_:]+$/);
      await tx.run(`UNWIND $rows AS row MERGE (n {stableId:row.key}) SET n:${labels}, n += row.props`,
        { rows: rows.map(n => ({ key: n.key, props: n.props })) });
    }
    for (const [type, rows] of Map.groupBy(edges, e => e.type)) {
      assert.match(type, /^[A-Za-z0-9_]+$/);
      await tx.run(`UNWIND $rows AS row MATCH (a {stableId:row.start}),(b {stableId:row.end})
        MERGE (a)-[r:${type} {extractionScope:$scope}]->(b) SET r += row.props`,
      { scope, rows: rows.map(e => ({ start:e.start,end:e.end,props:props(e.props || {}) })) });
    }
  });
} finally { await aura.session.close(); await aura.driver.close(); }
const documents = new Map();
for (const [id, fn] of functions) {
  const file = `${dir}/${fn.name}.drawio`;
  try {
    execFileSync(process.execPath, ['dev/exportLocalIterativeCoordinateDrawio.mjs','--aura','--fn-stable-id',id,'--output',file,'--hide-entry-parameters'],
      { windowsHide: true, timeout: 120000, stdio: 'pipe' });
  } catch (error) { console.error(error.stderr?.toString()); throw error; }
  documents.set(id, fs.readFileSync(file,'utf8'));
}
const result = composeExpandedFunctions(root, functions, calls, documents, { ...expandedFunctionView, name:'Model stub' });
const output = 'graph/draw/generated/Model-Stub.drawio';
fs.writeFileSync(output,result.xml);
console.log(JSON.stringify({ output, blocks: result.boxes }));
