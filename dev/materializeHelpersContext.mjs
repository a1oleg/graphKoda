import fs from 'node:fs';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { auraConnection, helpersRoot, helpersScope, loadHelpersContext } from '../graph/packages/orchestrator/src/orchestrator/helpersContext.js';

const object = 'components/PromptInput/PromptInput.tsx:1100:35:1104:5';
const field = 'components/PromptInput/PromptInput.tsx:1102:6:1102:17';
const fn = 'hooks/useInputBuffer.ts:114:34:122:3';
const spec = [
  [helpersRoot, 'onSubmit.helpers', 'Параметр', 'Какие действия предоставляет helpers?', 'В выбранной отправке helpers содержит функции управления полем ввода. clearBuffer очищает буфер редактирования; другие поля здесь не исследуются.'],
  [object, 'helpers из PromptInput', 'Объект-аргумент', 'Что передаёт PromptInput?', 'Вторым аргументом передаётся объект с setCursorOffset, clearBuffer и resetHistory. Поле clearBuffer ссылается на функцию из useInputBuffer этого экземпляра PromptInput.'],
  [field, 'clearBuffer', 'Поле объекта', 'Где реализация clearBuffer?', 'Это ссылка на callback, возвращённый useInputBuffer. В этом поле новая функция не создаётся.'],
  [fn, 'useInputBuffer.clearBuffer', 'Callback', 'Что именно очищается?', 'Очищает буфер редактирования и сбрасывает текущий индекс. Обнуляет время последнего добавления, отменяет ожидающий таймер и снимает ссылку на него. Сохранённую историю запросов не удаляет.'],
];
const c = dotenv.parse(fs.readFileSync(new URL('../graph/.env', import.meta.url)));
const driver = neo4j.driver(c.NEO4J_URI, neo4j.auth.basic(c.NEO4J_USERNAME, c.NEO4J_PASSWORD));
const session = driver.session({ database: c.NEO4J_DATABASE });
let aura;
try {
  const result = await session.executeRead(async tx => {
    const binding = await tx.run('MATCH (a {stableId:$object})-[:BINDS_TO_PARAMETER]->(b {stableId:$root}) RETURN a', { object, root: helpersRoot });
    assert.equal(binding.records.length, 1);
    const path = await tx.run(`MATCH p=(f {stableId:$field})-[:RESOLVES_TO]->()-[:SELECTS_RETURN_PROPERTY]->()
      -[:RESOLVES_TO]->()-[:VALUE_FROM]->()-[:HAS_ARGUMENT]->(fn {stableId:$fn})
      RETURN [n IN nodes(p) | n.stableId] AS nodes, [r IN relationships(p) | type(r)] AS relations`, { field, fn });
    assert.equal(path.records.length, 1, 'Implementation must have a unique proven path');
    const property = await tx.run('MATCH (o {stableId:$object})-[:HAS_PROPERTY]->(f {stableId:$field}) RETURN f', { object, field });
    assert.equal(property.records.length, 1);
    const nodes = await tx.run('MATCH (n) WHERE n.stableId IN $ids RETURN properties(n) AS props', { ids: spec.map(n => n[0]) });
    assert.equal(nodes.records.length, 4);
    return { nodes: nodes.records.map(r => r.get('props')), evidence: path.records[0].toObject() };
  });
  aura = auraConnection();
  await aura.session.executeWrite(async tx => {
    for (const [i, item] of spec.entries()) {
      const [id, title, kind, question, annotation] = item;
      const original = result.nodes.find(n => n.stableId === id);
      const props = Object.fromEntries(Object.entries(original).filter(([k]) => ['stableId','name','syntax','repoRelativePath','startLine','startColumn','endLine','endColumn','source_state_id'].includes(k)));
      Object.assign(props, { contextTitle: title, contextKind: kind, contextQuestion: question, contextAnnotation: annotation, contextAnnotationSource: 'prepared-from-source' });
      const check = await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count', { id });
      assert.ok(check.records[0].get('count').toNumber() <= 1);
      const label = ['Parameter','ObjectConstruction','PropertyValue','FunctionImplementation'][i];
      await tx.run(`MERGE (n {stableId:$id}) SET n:CodeEntity:${label}, n += $props`, { id, props });
    }
    const edges = [[helpersRoot, object, 'VALUE_FROM', [object, helpersRoot], ['BINDS_TO_PARAMETER']],
      [object, field, 'HAS_PROPERTY', [object, field], ['HAS_PROPERTY']],
      [field, fn, 'RESOLVES_TO_IMPLEMENTATION', result.evidence.nodes, result.evidence.relations]];
    for (const [i, [from, to, type, evidenceNodes, evidenceRelations]] of edges.entries()) {
      await tx.run(`MATCH (a {stableId:$from}), (b {stableId:$to}) MERGE (a)-[r:${type}]->(b)
        SET r.contextScope=$scope, r.contextOrder=$order, r.evidenceNodes=$evidenceNodes,
        r.evidenceRelations=$evidenceRelations, r.derivation='verified-source-path'`,
      { from, to, scope: helpersScope, order: neo4j.int(i), evidenceNodes, evidenceRelations });
    }
  });
  const model = await loadHelpersContext();
  console.log(JSON.stringify({ root: model.root, nodes: model.nodes.map(n => ({ stableId: n.stableId, title: n.title })) }, null, 2));
} finally {
  await session.close(); await driver.close();
  if (aura) { await aura.session.close(); await aura.driver.close(); }
}
