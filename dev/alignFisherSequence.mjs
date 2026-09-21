import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { boundaryCaptionWidth } from './functionBoundaryCaption.mjs';
import { methodMosaicImage } from './localCoordinateDrawio.mjs';

const target = new URL('../graph/draw/FY.drawio', import.meta.url);
const reference = new URL('../graph/draw/generated/Fisher-Yates.drawio', import.meta.url);
const parse = file => new DOMParser().parseFromString(fs.readFileSync(file, 'utf8'), 'text/xml');
const doc = parse(target), ref = parse(reference);
const cells = d => new Map([...d.getElementsByTagName('mxCell')].map(c => [c.getAttribute('id'), c]));
const source = cells(ref), destination = cells(doc);
const geometry = c => [...c.childNodes].find(n => n.nodeName === 'mxGeometry');
const number = (g, key) => Number(g?.getAttribute(key) || 0);
function box(id) {
  const c = source.get(id);
  assert(c, `Missing reference cell ${id}`);
  const g = geometry(c);
  const result = { x: number(g, 'x'), y: number(g, 'y'), width: number(g, 'width'), height: number(g, 'height') };
  for (let p = source.get(c.getAttribute('parent')); p; p = source.get(p.getAttribute('parent'))) {
    result.x += number(geometry(p), 'x');
    result.y += number(geometry(p), 'y');
  }
  return result;
}
const center = id => { const b = box(id); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const axes = [
  { prefix: 'f0', head: 'c8', axis: 'c7', name: 'shuffle()' },
  { prefix: 'f1', head: 'c10', axis: 'c9', name: 'getRandom()' },
  { prefix: 'f2', head: 'c14', axis: 'c13', name: 'swap()' },
];
const bottom = Math.max(...axes.map(a => { const b = box(`${a.prefix}-block`); return b.y + b.height; }));
for (const a of axes) {
  a.position = center(`${a.prefix}-n1`);
  const head = destination.get(a.head), g = geometry(head);
  const width = boundaryCaptionWidth(a.name), height = 34;
  head.setAttribute('value', a.name);
  head.setAttribute('style', `shape=image;imageAspect=0;image=${methodMosaicImage('single', '#DAE8FC', '#007FFF', { width })};html=1;whiteSpace=nowrap;align=center;verticalAlign=middle;spacingLeft=12;spacingRight=10;fontSize=12;fontColor=#000000;`);
  for (const [key, value] of Object.entries({ x: a.position.x - width / 2, y: a.position.y - height / 2, width, height })) g.setAttribute(key, value);
  const axis = destination.get(a.axis);
  axis.setAttribute('source', a.head);
  axis.setAttribute('style', 'strokeColor=#b8bec5;strokeWidth=2;dashed=1;endArrow=none;exitX=0.5;exitY=1;exitDx=0;exitDy=0;');
  for (const point of geometry(axis).getElementsByTagName('mxPoint')) {
    point.setAttribute('x', a.position.x);
    point.setAttribute('y', point.getAttribute('as') === 'sourcePoint' ? a.position.y + height / 2 : bottom);
  }
}
for (const [id, from, to, event] of [
  ['c27', 0, 1, 'f0-n11-part-1'],
  ['c29', 0, 2, 'f0-n10'],
  ['2', 1, 0, 'f1-n3'],
]) {
  const edge = destination.get(id);
  const overlapsHead = Math.abs(center(event).y - axes[to].position.y) < 17;
  const y = overlapsHead ? axes[to].position.y : center(event).y;
  if (overlapsHead) {
    edge.setAttribute('target', axes[to].head);
    edge.setAttribute('style', edge.getAttribute('style') + 'entryX=0;entryY=0.5;entryDx=0;entryDy=0;');
  }
  for (const point of geometry(edge).getElementsByTagName('mxPoint')) {
    point.setAttribute('x', axes[point.getAttribute('as') === 'sourcePoint' ? from : to].position.x);
    point.setAttribute('y', y);
  }
}
const model = doc.getElementsByTagName('mxGraphModel')[0];
model.setAttribute('pageHeight', Math.ceil((bottom + 40) / 10) * 10);
fs.writeFileSync(target, new XMLSerializer().serializeToString(doc), 'utf8');
console.log(JSON.stringify(axes.map(({ name, position }) => ({ name, ...position }))));
