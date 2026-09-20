import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const source = 'graph/draw/model-stub-sequence.drawio';
const output = 'graph/draw/model-stub-sequence-without-stub.drawio';
const original = fs.readFileSync(source, 'utf8');
const doc = new DOMParser().parseFromString(original, 'text/xml');
const cells = Array.from(doc.getElementsByTagName('mxCell'));
const byId = new Map(cells.map(cell => [cell.getAttribute('id'), cell]));
const remove = [4, 6, 11, 12, ...Array.from({ length: 9 }, (_, i) => i + 17),
  ...Array.from({ length: 6 }, (_, i) => i + 34)];
for (const id of remove) {
  const cell = byId.get(`c${id}`);
  assert(cell, `Missing source cell c${id}`);
  cell.parentNode.removeChild(cell);
}
const labels = {
  c2: 'Вызов модели: без заглушки',
  c3: 'Потоковый вызов · промежуточные обёртки свёрнуты · исходный масштаб и положение сценария сохранены',
  c8: 'queryModelWithStreaming()',
  c10: 'queryModel()',
  c14: 'anthropic.beta.messages\n.create()',
  c16: 'globalThis.fetch()',
  c27: 'queryModel(...) через withStreamingVCR',
  c29: 'create({ ...params, stream: true })',
  c30: 'fetch(...) через транспорт SDK',
  c31: 'Response / поток HTTP',
  c32: 'Поток событий API',
};
for (const [id, label] of Object.entries(labels)) byId.get(id).setAttribute('value', label);
byId.get('c8').setAttribute('style', `${byId.get('c8').getAttribute('style')}fontSize=13;`);
const annotations = [
  ['c8', 'Передаёт историю диалога, системный промпт, инструменты и настройки в queryModel. Возвращает его события по мере поступления, через обёртку withStreamingVCR.', 'services/api/claude.ts:757'],
  ['c10', 'Готовит запрос модели и запускает его с повторными попытками. Собирает из потока текст и вызовы инструментов, учитывает расход токенов и выдаёт сообщения, события и ошибки вызывающему коду.', 'services/api/claude.ts:1022'],
  ['c14', 'Метод Anthropic SDK. Передаёт сообщения и параметры в POST /v1/messages. Здесь включён stream: true, поэтому результат поступает как поток событий API, а не готовый ответ целиком.', '@anthropic-ai/sdk/resources/beta/messages/messages.mjs:44'],
  ['c16', 'HTTP-транспорт среды выполнения. Отправляет запрос серверу и возвращает Response с заголовками и потоком тела. Не собирает сообщения Claude: это делают SDK и queryModel. Используется, если fetchOverride не задан.', 'services/api/client.ts:359'],
];
const topInset = 220;
for (const cell of cells) {
  if (!cell.parentNode || ['c2', 'c3'].includes(cell.getAttribute('id'))) continue;
  const geometry = cell.getElementsByTagName('mxGeometry')[0];
  if (!geometry) continue;
  if (cell.getAttribute('vertex') === '1') geometry.setAttribute('y', String(Number(geometry.getAttribute('y')) + topInset));
  for (const point of Array.from(geometry.getElementsByTagName('mxPoint'))) {
    point.setAttribute('y', String(Number(point.getAttribute('y')) + topInset));
  }
}
const root = doc.getElementsByTagName('root')[0];
for (const [id, text, evidence] of annotations) {
  const header = byId.get(id);
  header.setAttribute('style', 'rounded=1;arcSize=50;whiteSpace=wrap;html=0;fillColor=#BBDDFF;strokeColor=#0088FF;strokeWidth=2;fontFamily=Arial;fontSize=13;fontColor=#000000;spacing=8;');
  const cell = doc.createElement('mxCell');
  for (const [key, value] of Object.entries({ id: `annotation-${id}`, parent: '1', vertex: '1', value: text, annotationFor: id, evidence,
    style: 'rounded=0;whiteSpace=wrap;html=0;fillColor=#F2F2F2;strokeColor=#CCCCCC;fontFamily=Arial;fontSize=13;align=left;verticalAlign=top;spacing=12;' })) cell.setAttribute(key, value);
  const geometry = doc.createElement('mxGeometry');
  const headerGeometry = header.getElementsByTagName('mxGeometry')[0];
  for (const [key, value] of Object.entries({ x: headerGeometry.getAttribute('x'), y: '100', width: '210', height: '200', as: 'geometry' })) geometry.setAttribute(key, value);
  cell.appendChild(geometry);
  root.appendChild(cell);
}
const model = doc.getElementsByTagName('mxGraphModel')[0];
model.setAttribute('pageHeight', String(Number(model.getAttribute('pageHeight')) + topInset));
const diagram = doc.getElementsByTagName('diagram')[0];
diagram.setAttribute('id', 'model-without-stub');
diagram.setAttribute('name', 'Без заглушки');
const result = new XMLSerializer().serializeToString(doc);
const parsed = new DOMParser().parseFromString(result, 'text/xml');
assert.equal(parsed.getElementsByTagName('parsererror').length, 0);
const originalDoc = new DOMParser().parseFromString(original, 'text/xml');
const originalCells = new Map(Array.from(originalDoc.getElementsByTagName('mxCell')).map(c => [c.getAttribute('id'), c]));
for (let i = 26; i <= 33; i++) {
  const expected = originalCells.get(`c${i}`).getElementsByTagName('mxGeometry')[0];
  if (originalCells.get(`c${i}`).getAttribute('vertex') === '1') expected.setAttribute('y', String(Number(expected.getAttribute('y')) + topInset));
  for (const point of Array.from(expected.getElementsByTagName('mxPoint'))) point.setAttribute('y', String(Number(point.getAttribute('y')) + topInset));
  assert.equal(
    byId.get(`c${i}`).getElementsByTagName('mxGeometry')[0].toString(),
    originalCells.get(`c${i}`).getElementsByTagName('mxGeometry')[0].toString(),
  );
}
for (const attr of Array.from(originalDoc.getElementsByTagName('mxGraphModel')[0].attributes)) {
  assert.equal(model.getAttribute(attr.name), attr.name === 'pageHeight' ? String(Number(attr.value) + topInset) : attr.value);
}
assert.equal(fs.readFileSync(source, 'utf8'), original);
fs.writeFileSync(output, result, 'utf8');
console.log(output);
