import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import assert from 'node:assert/strict';

const output = 'graph/draw/model-stub-sequence.drawio';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cells = ['<mxCell id="0"/><mxCell id="1" parent="0"/>'];
let nextId = 2;
function box(text, x, y, width, height, style = '') {
  const id = `c${nextId++}`;
  cells.push(`<mxCell id="${id}" value="${escape(text)}" style="html=0;whiteSpace=wrap;fontFamily=Arial;fontSize=15;spacing=8;${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`);
  return id;
}
function line(text, x1, y1, x2, y2, color, dashed = false, arrow = true) {
  cells.push(`<mxCell id="c${nextId++}" value="${escape(text)}" style="html=0;fontFamily=Arial;fontSize=14;fontColor=${color};strokeColor=${color};strokeWidth=2;endArrow=${arrow ? 'block' : 'none'};endFill=1;dashed=${dashed ? 1 : 0};labelBackgroundColor=#ffffff;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${x1}" y="${y1}" as="sourcePoint"/><mxPoint x="${x2}" y="${y2}" as="targetPoint"/></mxGeometry></mxCell>`);
}
const textStyle = 'strokeColor=none;fillColor=none;align=left;';
const green = '#187344', blue = '#1963a6', red = '#b33232';
box('Вызов модели: исходный путь и заглушка', 30, 15, 1260, 42, `${textStyle}fontSize=24;fontStyle=1;`);
box('Коммит af272b9e · STUB · время идёт сверху вниз внутри каждого сценария', 30, 58, 1260, 28, `${textStyle}fontSize=13;fontColor=#555555;`);
box('', 30, 165, 1370, 330, 'fillColor=#f0f8f3;strokeColor=#b5d9c2;');
box('', 30, 520, 1370, 320, 'fillColor=#f0f6fc;strokeColor=#b6cee5;');
box('', 30, 865, 1370, 205, 'fillColor=#fff5f4;strokeColor=#e4c0bd;');
const axes = [150, 440, 735, 1015, 1290];
const names = ['Вызывающий код\nREPL / агент', 'queryModel()\nclaude.ts', 'modelCallGuard\nучёт и блокировка', 'API-клиент / SDK\nfetch', 'API модели\nвнешний сервис'];
axes.forEach((x, i) => {
  line('', x, 155, x, 1055, '#b8bec5', true, false);
  box(names[i], x - 105, 100, 210, 55, 'fillColor=#ffffff;strokeColor=#737b84;');
});
box('С ЗАГЛУШКОЙ · CLAUDE_CODE_MODEL_STUB=1', 45, 172, 900, 30, `${textStyle}fontColor=${green};fontStyle=1;`);
line('Запрос к модели', 150, 230, 440, 230, green);
line('isModelStubEnabled()', 440, 267, 735, 267, green);
line('true', 735, 300, 440, 300, green, true);
line('recordStubbedModelCall(source, model)', 440, 341, 735, 341, green);
box('Счётчик +1; источник, модель, время', 754, 350, 375, 34, `${textStyle}fontColor=${green};fontSize=13;`);
box('Создать AssistantMessage\nisVirtual=true; stop_reason=end_turn\nТекст: MODEL_STUB_RESPONSE или стандартный', 305, 384, 340, 70, `fillColor=#ffffff;strokeColor=${green};fontSize=13;`);
line('yield сообщение; return', 440, 474, 150, 474, green, true);
box('SDK и API модели не вызываются', 915, 405, 440, 40, `${textStyle}fontColor=${green};fontStyle=1;`);

box('БЕЗ ЗАГЛУШКИ · исходный путь до коммита', 45, 527, 900, 30, `${textStyle}fontColor=${blue};fontStyle=1;`);
line('Запрос к модели', 150, 587, 440, 587, blue);
box('Подготовка запроса и обычные проверки', 295, 610, 290, 40, `fillColor=#ffffff;strokeColor=${blue};fontSize=13;`);
line('Запрос через клиент', 440, 685, 1015, 685, blue);
line('HTTP-запрос', 1015, 730, 1290, 730, blue);
line('Ответ / поток событий', 1290, 775, 1015, 775, blue, true);
line('Данные ответа', 1015, 799, 440, 799, blue, true);
line('yield события и сообщения', 440, 824, 150, 824, blue, true);

box('СТРАХОВКА В РЕЖИМЕ ЗАГЛУШКИ · если другой путь дошёл до транспорта', 45, 872, 1220, 30, `${textStyle}fontColor=${red};fontStyle=1;`);
line('guardModelApiFetch: проверка перед inner fetch', 1015, 938, 735, 938, red);
box('Записать blocked-transport\nsource, URL, время; увеличить счётчики', 575, 954, 320, 45, `fillColor=#ffffff;strokeColor=${red};fontSize=13;`);
line('Promise.reject(ModelApiTripwireError)', 735, 1032, 1015, 1032, red, true);
box('inner fetch НЕ вызывается\nHTTP-запрос не отправлен', 1135, 958, 230, 65, `${textStyle}fontColor=${red};fontStyle=1;`);
box('При выключенной заглушке guard пропускает вызов в исходный fetch. Переменные режима и ответа наследуются дочерними агентами.', 30, 1085, 1370, 48, `${textStyle}fontSize=14;`);
const xml = `<mxfile host="app.diagrams.net"><diagram id="model-stub" name="Model call — STUB"><mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="1430" pageHeight="1160"><root>${cells.join('\n')}</root></mxGraphModel></diagram></mxfile>`;
const doc = new DOMParser().parseFromString(xml, 'text/xml');
assert.equal(doc.getElementsByTagName('mxCell').length, nextId);
assert.equal(doc.getElementsByTagName('parsererror').length, 0);
assert(!fs.existsSync(output), 'Do not overwrite an edited diagram');
fs.writeFileSync(output, xml);
console.log(output);
