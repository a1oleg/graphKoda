import fs from 'node:fs';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { auraConnection, helpersScope, loadHelpersContext } from '../graph/packages/orchestrator/src/orchestrator/helpersContext.js';

const fn = 'hooks/useInputBuffer.ts:114:34:122:3';
const prefix = 'hooks/useInputBuffer.ts:';
const definitions = [
  ['31:17:31:26', 'setBuffer', '115:4:115:13', '31:30:31:57', 'READS_FROM', 'useState<BufferEntry[]>([])',
    'Сеттер локального buffer. В clearBuffer получает пустой массив, удаляя записи буфера редактирования.',
    'React создаёт состояние buffer с пустым массивом и возвращает сеттер. Это граница API React, не его внутренняя реализация.'],
  ['32:23:32:38', 'setCurrentIndex', '116:4:116:19', '32:42:32:54', 'READS_FROM', 'useState(-1)',
    'Сеттер позиции в буфере. При очистке получает -1: текущая запись отсутствует.',
    'React создаёт состояние индекса со значением -1 и возвращает сеттер. Это граница API React.'],
  ['33:8:33:40', 'lastPushTime', '117:4:117:16', '33:23:33:40', 'VALUE_FROM', 'useRef<number>(0)',
    'Ссылка хранит время последнего добавления в буфер. Callback обнуляет current.',
    'React создаёт сохраняемый между рендерами объект ref с начальным current=0. Запись current выполняется обычным присваиванием JavaScript.'],
  ['34:8:34:72', 'pendingPush', '120:6:120:17', '34:22:34:72', 'VALUE_FROM', 'useRef(null)',
    'Ссылка хранит ожидающий таймер добавления в буфер. Callback проверяет её, отменяет таймер и присваивает current=null.',
    'React создаёт ref, изначально без таймера. Тип допускает дескриптор setTimeout или null; изменение current является присваиванием JavaScript.'],
];
const timeout = prefix + '119:6:119:39';
const c = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
const driver = neo4j.driver(c.NEO4J_URI, neo4j.auth.basic(c.NEO4J_USERNAME, c.NEO4J_PASSWORD));
const session = driver.session({ database: c.NEO4J_DATABASE });
let aura;
try {
  const { nodes, edges } = await session.executeRead(async tx => {
    const nodes = [], edges = [];
    async function read(id) {
      const r = await tx.run('MATCH (n {stableId:$id}) RETURN properties(n) AS props', { id });
      assert.equal(r.records.length, 1, `Expected unique node ${id}`);
      return r.records[0].get('props');
    }
    const owner = await read(fn);
    function inside(node) {
      assert.equal(node.repoRelativePath, owner.repoRelativePath);
      assert.ok(Number(node.startLine) >= Number(owner.startLine) && Number(node.endLine) <= Number(owner.endLine));
    }
    async function boundary(id) {
      const r = await tx.run(`MATCH (n {stableId:$id})-[:CALLS]->(api:ExternalBoundary:System)
        RETURN api.stableId AS id`, { id });
      assert.equal(r.records.length, 1, `No unique external API for ${id}`);
      return r.records[0].get('id');
    }
    for (const [decl, title, reference, call, relation, apiTitle, text, apiText] of definitions) {
      const id = prefix + decl, ref = prefix + reference, api = prefix + call;
      inside(await read(ref));
      const proof = await tx.run(`MATCH (r {stableId:$ref})-[:RESOLVES_TO]->(d {stableId:$id})
        -[e:${relation}]->(a {stableId:$api}) RETURN d.stableId AS id`, { ref, id, api });
      assert.equal(proof.records.length, 1);
      nodes.push({ props: await read(id), title, text, kind: 'Локальное определение', system: false });
      nodes.push({ props: await read(api), title: apiTitle, text: apiText, kind: 'Системный API', system: true, boundary: await boundary(api) });
      edges.push({ from: fn, to: id, type: 'USES_BINDING', evidenceNodes: [fn, ref, id], evidenceRelations: ['LEXICAL_CONTAINMENT', 'RESOLVES_TO'] });
      edges.push({ from: id, to: api, type: relation, evidenceNodes: [id, api], evidenceRelations: [relation] });
    }
    const call = await read(timeout); inside(call);
    nodes.push({ props: call, title: 'clearTimeout(pendingPush.current)', kind: 'Системный API', system: true,
      boundary: await boundary(timeout), text: 'При наличии pendingPush.current отменяет ожидающий таймер. Выполняется только в ветке if. Граница внешнего API: в графе доступна его декларация, не реализация таймеров.' });
    edges.push({ from: fn, to: timeout, type: 'HAS_OPERATION', evidenceNodes: [fn, timeout], evidenceRelations: ['LEXICAL_CONTAINMENT'] });
    return { nodes, edges };
  });
  aura = auraConnection();
  await aura.session.executeWrite(async tx => {
    const parent = await tx.run('MATCH (n {stableId:$fn}) RETURN n', { fn });
    assert.equal(parent.records.length, 1, 'Materialize helpers first');
    for (const node of nodes) {
      const props = Object.fromEntries(Object.entries(node.props).filter(([k]) => ['stableId','name','syntax','repoRelativePath','startLine','startColumn','endLine','endColumn','source_state_id'].includes(k)));
      Object.assign(props, { contextTitle: node.title, contextKind: node.kind, contextQuestion: node.system ? 'Где заканчивается разработческий код?' : 'Что определено и что меняет callback?',
        contextAnnotation: node.text, contextAnnotationSource: 'prepared-from-source', contextSystemBoundary: node.system,
        contextBoundaryDeclarationId: node.boundary || null });
      const id = node.props.stableId;
      const check = await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count', { id });
      assert.ok(check.records[0].get('count').toNumber() <= 1);
      const label = node.system ? 'CallSite' : 'ValueDeclaration';
      await tx.run(`MERGE (n {stableId:$id}) SET n:CodeEntity:${label}, n += $props`, { id, props });
    }
    for (const [order, edge] of edges.entries()) {
      await tx.run(`MATCH (a {stableId:$from}), (b {stableId:$to}) MERGE (a)-[r:${edge.type}]->(b)
        SET r.contextScope=$scope, r.contextOrder=$order, r.evidenceNodes=$evidenceNodes,
        r.evidenceRelations=$evidenceRelations, r.derivation='verified-source-path'`,
      { ...edge, scope: helpersScope, order: neo4j.int(order + 3) });
    }
  });
  const model = await loadHelpersContext();
  assert.equal(model.nodes.length, 13);
  assert.equal(model.nodes.filter(n => n.system).length, 5);
  console.log(JSON.stringify({ nodes: model.nodes.length, edges: model.nodes.reduce((sum,n) => sum+n.deps.length,0), boundaries: model.nodes.filter(n=>n.system).map(n=>n.title) }));
} finally {
  await session.close(); await driver.close();
  if (aura) { await aura.session.close(); await aura.driver.close(); }
}
