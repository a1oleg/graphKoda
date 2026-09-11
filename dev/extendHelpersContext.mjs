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
const hookId = prefix + '27:7:132:1';
const componentId = 'components/PromptInput/PromptInput.tsx:194:0:2297:1';
const hookCallId = 'components/PromptInput/PromptInput.tsx:838:6:841:4';
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
      const definition = { props: await read(id), title, text, kind: 'Локальное определение', system: false };
      nodes.push(definition);
      edges.push({ from: fn, to: id, type: 'USES_BINDING', evidenceNodes: [fn, ref, id], evidenceRelations: ['LEXICAL_CONTAINMENT', 'RESOLVES_TO'] });
      if (relation === 'READS_FROM') {
        definition.inlineSystem = apiTitle;
        definition.inlineSystemId = api;
        definition.boundary = await boundary(api);
        definition.text = title === 'setBuffer'
          ? 'Сеттер buffer в экземпляре useInputBuffer компонента PromptInput. buffer хранит снимки для Undo: текст, курсор, вставленные материалы и время. clearBuffer удаляет снимки, но не текст поля и не историю запросов.'
          : 'Сеттер позиции в Undo-буфере useInputBuffer. При очистке получает -1: выбранного снимка нет. Назначение индекса подтверждается чтением в undo.';
        const state = await tx.run('MATCH (d {stableId:$id})-[:WRITES_TO]->(s) RETURN properties(s) AS props', { id });
        assert.equal(state.records.length, 1);
        const stateProps = state.records[0].get('props');
        const hook = await read(hookId);
        assert.equal(stateProps.repoRelativePath, hook.repoRelativePath);
        assert.ok(Number(stateProps.startLine) >= Number(hook.startLine) && Number(stateProps.endLine) <= Number(hook.endLine));
        edges.push({ from: id, to: hookId, type: 'STATE_OWNER_CONTEXT', evidenceNodes: [id, stateProps.stableId, hookId], evidenceRelations: ['WRITES_TO', 'LEXICAL_CONTAINMENT_REVERSE'] });
      } else {
        nodes.push({ props: await read(api), title: apiTitle, text: apiText, kind: 'Системный API', system: true, boundary: await boundary(api) });
        edges.push({ from: id, to: api, type: relation, evidenceNodes: [id, api], evidenceRelations: [relation] });
      }
    }
    const callOwner = await tx.run(`MATCH (call {stableId:$hookCallId})-[:CALLS]->(hook {stableId:$hookId}),
      (call)-[:ENCLOSED_BY]->(component {stableId:$componentId}) RETURN call.stableId AS id`, { hookCallId, hookId, componentId });
    assert.equal(callOwner.records.length, 1);
    nodes.push({ props: await read(hookId), title: 'useInputBuffer', kind: 'Владелец состояния', system: false, label: 'FunctionImplementation',
      text: 'Хук ведёт Undo-буфер поля ввода. pushToBuffer сохраняет снимки текста, курсора и вставленных материалов, ограничивая размер и частоту добавления. undo выбирает предыдущий снимок. clearBuffer очищает этот буфер. Состояние принадлежит экземпляру хука, вызванному из PromptInput.' });
    nodes.push({ props: await read(componentId), title: 'PromptInput', kind: 'Компонент поля ввода', system: false, label: 'FunctionImplementation',
      text: 'Компонент подключает useInputBuffer для отмены редактирования: до 50 снимков, интервал добавления 1000 мс. При Undo восстанавливает текст, положение курсора и вставленные материалы. clearBuffer передаётся в helpers при отправке сообщения.' });
    edges.push({ from: hookId, to: componentId, type: 'USED_IN_COMPONENT', evidenceNodes: [hookId, hookCallId, componentId], evidenceRelations: ['CALLS_REVERSE', 'ENCLOSED_BY'] });
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
    // Keep API facts, but remove their separate axes from this context route.
    await tx.run(`MATCH (d)-[r:READS_FROM]->(api) WHERE d.stableId IN $setters AND r.contextScope=$scope
      REMOVE r.contextScope, r.contextOrder SET r.contextInline=true`,
    { setters: definitions.filter(d => d[4] === 'READS_FROM').map(d => prefix + d[0]), scope: helpersScope });
    for (const node of nodes) {
      const props = Object.fromEntries(Object.entries(node.props).filter(([k]) => ['stableId','name','syntax','repoRelativePath','startLine','startColumn','endLine','endColumn','source_state_id'].includes(k)));
      Object.assign(props, { contextTitle: node.title, contextKind: node.kind, contextQuestion: node.system ? 'Где заканчивается разработческий код?' : 'Что определено и что меняет callback?',
        contextAnnotation: node.text, contextAnnotationSource: 'prepared-from-source', contextSystemBoundary: node.system,
        contextBoundaryDeclarationId: node.boundary || null,
        contextInlineSystem: node.inlineSystem || null, contextInlineSystemStableId: node.inlineSystemId || null });
      const id = node.props.stableId;
      const check = await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count', { id });
      assert.ok(check.records[0].get('count').toNumber() <= 1);
      const label = node.label || (node.system ? 'CallSite' : 'ValueDeclaration');
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
  assert.equal(model.nodes.filter(n => n.system).length, 3);
  assert.ok(!model.nodes.some(n => n.stableId === prefix + '31:30:31:57' || n.stableId === prefix + '32:42:32:54'));
  console.log(JSON.stringify({ nodes: model.nodes.length, edges: model.nodes.reduce((sum,n) => sum+n.deps.length,0), boundaries: model.nodes.filter(n=>n.system).map(n=>n.title) }));
} finally {
  await session.close(); await driver.close();
  if (aura) { await aura.session.close(); await aura.driver.close(); }
}
