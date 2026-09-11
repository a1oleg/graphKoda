import fs from 'node:fs';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import neo4j from 'neo4j-driver';
import { auraConnection } from '../graph/packages/orchestrator/src/orchestrator/helpersContext.js';
import { inputRoot, inputScope, loadInputContext } from '../graph/packages/orchestrator/src/orchestrator/inputContext.js';

// A selected source-reviewed slice. Cross-callback context edges are not direct calls.
const spec = [
  [inputRoot, 'onSubmit.input', 'Параметр', 'Получает текст обычной отправки из PromptInput. Другие источники параметра в эту ветку не включены.'],
  ['components/PromptInput/PromptInput.tsx:1100:23:1100:33', 'inputParam', 'Передаваемый аргумент', 'Подготовленная строка передаётся первым аргументом onSubmitProp. В выбранном сценарии это введённый текст после trimEnd(), без замены подсказкой.'],
  ['components/PromptInput/PromptInput.tsx:984:31:1105:3', 'PromptInput.onSubmit', 'Обработчик отправки', 'Принимает строку от текстового поля, удаляет пробельный хвост и в обычной ветке отправляет её лидеру через onSubmitProp.'],
  ['hooks/useTextInput.ts:247:2:267:3', 'handleEnter', 'Обычный Enter', 'Если Enter не означает вставку новой строки, вызывает onSubmit(originalValue). Передаётся накопленный текст поля, не символ Enter. Callback связан с PromptInput через TextInput и baseProps.'],
  ['screens/REPL.tsx:1331:9:1331:19', 'REPL.inputValue', 'Состояние текста', 'Хранит текущее содержимое поля. Через свойства компонентов оно приходит в useTextInput как value, локально названное originalValue. Здесь рассматриваются изменения от обычного набора, не остальные писатели состояния.'],
  ['hooks/useTextInput.ts:431:2:501:3', 'useTextInput.onInput', 'Обработка ввода', 'Применяет событие к текущей модели Cursor. Когда текст меняется, передаёт nextCursor.text в onChange. Через обработчики PromptInput и сеттер REPL новое значение становится состоянием поля. Уже набранный текст сохраняется в модели: событие не заменяет его целиком.'],
  ['ink/hooks/use-input.ts:69:38:81:3', 'Ink.handleData', 'Доставка события', 'Активный обработчик получает input и key из события Ink и передаёт их inputHandler. Через BaseTextInput событие доходит до обработчика текстового поля.'],
  ['ink/components/App.tsx:332:19:368:3', 'App.handleReadable', 'Чтение терминала', 'Читает доступные фрагменты stdin и передаёт их processInput. После разбора терминальных последовательностей Ink публикует события input. Это событийный путь, не прямой вызов handleData из handleReadable.'],
  ['ink/components/App.tsx:344:22:344:45', 'stdin.read()', 'Системная граница', 'Чтение внешнего потока терминала. Возвращает доступный фрагмент или null; смысл текста и редактирование определяются кодом выше.'],
];
const types = ['VALUE_FROM', 'ARGUMENT_CONTEXT', 'SUBMISSION_CONTEXT', 'STATE_VALUE_CONTEXT', 'STATE_UPDATE_CONTEXT', 'INPUT_EVENT_CONTEXT', 'EVENT_SOURCE_CONTEXT', 'HAS_OPERATION'];
const evidence = [
  ['components/PromptInput/PromptInput.tsx',1100,1104], ['components/PromptInput/PromptInput.tsx',984,1104],
  ['components/TextInput.tsx',92,96], ['hooks/useTextInput.ts',73,105],
  ['components/PromptInput/PromptInput.tsx',867,901], ['components/BaseTextInput.tsx',59,90],
  ['ink/components/App.tsx',505,507], ['ink/components/App.tsx',332,347],
];
const env = dotenv.parse(fs.readFileSync(new URL('../graph/.env',import.meta.url)));
const driver = neo4j.driver(env.NEO4J_URI,neo4j.auth.basic(env.NEO4J_USERNAME,env.NEO4J_PASSWORD));
const session = driver.session({database:env.NEO4J_DATABASE}); let aura;
try {
  const result = await session.run('MATCH (n) WHERE n.stableId IN $ids RETURN properties(n) AS props', {ids:spec.map(n=>n[0])});
  assert.equal(result.records.length,spec.length,'All selected code entities must exist');
  const originals = new Map(result.records.map(r=>[r.get('props').stableId,r.get('props')]));
  assert.equal(originals.size,spec.length);
  const binding = await session.run('MATCH (a {stableId:$arg})-[:BINDS_TO_PARAMETER]->(p {stableId:$root}) RETURN a', {arg:spec[1][0],root:inputRoot});
  assert.equal(binding.records.length,1);
  aura=auraConnection();
  await aura.session.executeWrite(async tx=>{
    for(const [index,[id,title,kind,text]] of spec.entries()) {
      const props=Object.fromEntries(Object.entries(originals.get(id)).filter(([k])=>['stableId','name','syntax','repoRelativePath','startLine','startColumn','endLine','endColumn','source_state_id'].includes(k)));
      Object.assign(props,{contextTitle:title,contextKind:kind,contextQuestion:'Откуда здесь появляется текст?',contextAnnotation:text,contextAnnotationSource:'prepared-from-source',contextSystemBoundary:index===spec.length-1});
      const check=await tx.run('MATCH (n {stableId:$id}) RETURN count(n) AS count',{id});assert.ok(check.records[0].get('count').toNumber()<=1);
      await tx.run('MERGE (n {stableId:$id}) SET n:CodeEntity, n += $props',{id,props});
    }
    for(const [i,type] of types.entries()) {
      await tx.run(`MATCH (a {stableId:$from}), (b {stableId:$to}) MERGE (a)-[r:${type} {contextScope:$scope}]->(b)
        SET r.contextOrder=$order, r.derivation=$derivation, r.sourceEvidence=$evidence`,
      {from:spec[i][0],to:spec[i+1][0],scope:inputScope,order:neo4j.int(i),derivation:i===0?'reversed-parameter-binding':'source-reviewed-context',evidence:JSON.stringify(evidence[i])});
    }
  });
  const model=await loadInputContext();assert.equal(model.nodes.length,9);
  console.log(JSON.stringify({nodes:model.nodes.length,edges:types.length,root:model.root}));
}finally{await session.close();await driver.close();if(aura){await aura.session.close();await aura.driver.close();}}
