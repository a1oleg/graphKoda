import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const file = 'graph/draw/generated/queryModel.drawio';
const parse = file => new DOMParser().parseFromString(fs.readFileSync(file, 'utf8'), 'text/xml');
const backup = 'tmp/model-stub/queryModel-before-next-if.drawio';
const old = parse(process.argv.includes('--rebuild') ? backup : file), fresh = parse('tmp/model-stub/queryModel-next-if.drawio');
const cells = doc => Array.from(doc.getElementsByTagName('mxCell'));
const index = doc => new Map(cells(doc).map(c => [c.getAttribute('id'), c]));
const om = index(old), nm = index(fresh);
const geo = c => c.getElementsByTagName('mxGeometry')[0];
const num = (c, key) => Number(c?.getAttribute(key) || 0);
const stable = c => c.getAttribute('stableId');
const root = old.getElementsByTagName('root')[0];
const entryId = 'services/api/claude.ts:1051:5:1051:27';
assert(!cells(old).some(c => stable(c) === entryId), 'Next if is already present');
const entry = cells(fresh).find(c => stable(c) === entryId && c.getAttribute('vertex') === '1' && !c.getAttribute('id').includes('-part-'));
const outside = cells(old).find(c => c.getAttribute('value') === 'Outside diff');
const newOutside = cells(fresh).find(c => c.getAttribute('value') === 'Outside diff');
const end = om.get('f0-n5');
const newEnd = cells(fresh).find(c => stable(c)?.endsWith(stable(end)) && c.getAttribute('value') === 'End');
function position(c, map, stop = 'f0-block') {
  if (!c || c.getAttribute('id') === stop) return { x: 0, y: 0 };
  const p = position(map.get(c.getAttribute('parent')), map, stop), g = geo(c);
  return { x: p.x + num(g, 'x'), y: p.y + num(g, 'y') };
}
const anchor = position(outside, om), head = position(entry, nm);
const dx = anchor.x + num(geo(outside), 'width') / 2 - head.x - num(geo(entry), 'width') / 2;
const dy = anchor.y - head.y;
const conditionRow = entry.getAttribute('parent');
const body = cells(fresh).find(c => c.getAttribute('stableId') === 'flow-block:side:true:services/api/claude.ts:1061:4:1068:3')
  || nm.get('f0-flow-block-2');
assert(body, 'Expected next-if body');
const selected = new Set([conditionRow, body.getAttribute('id')]);
let changed = true;
while (changed) {
  changed = false;
  for (const c of cells(fresh)) if (c.getAttribute('vertex') === '1' && selected.has(c.getAttribute('parent')) && !selected.has(c.getAttribute('id'))) {
    selected.add(c.getAttribute('id')); changed = true;
  }
}
const mapping = new Map([...selected].map(id => [id, `next-if-${id}`]));
mapping.set(newOutside.getAttribute('id'), outside.getAttribute('id'));
mapping.set(newEnd.getAttribute('id'), end.getAttribute('id'));
const previous = cells(old).find(c => stable(c) === 'services/api/claude.ts:1033:6:1033:26' && c.getAttribute('vertex') === '1');
const newPrevious = cells(fresh).find(c => stable(c) === stable(previous) && c.getAttribute('vertex') === '1');
mapping.set(newPrevious.getAttribute('id'), previous.getAttribute('id'));
for (const id of selected) {
  const c = nm.get(id), copy = old.importNode(c, true);
  copy.setAttribute('id', mapping.get(id));
  const parent = c.getAttribute('parent');
  copy.setAttribute('parent', mapping.get(parent) || parent);
  if (!selected.has(parent)) {
    const g = geo(copy); g.setAttribute('x', num(g, 'x') + dx); g.setAttribute('y', num(g, 'y') + dy);
  }
  root.appendChild(copy);
}
const oldIncoming = cells(old).find(c => c.getAttribute('edge') === '1' && c.getAttribute('target') === outside.getAttribute('id'));
oldIncoming.parentNode.removeChild(oldIncoming);
let edgeCount = 0;
for (const c of cells(fresh).filter(c => c.getAttribute('edge') === '1')) {
  const s = c.getAttribute('source'), t = c.getAttribute('target');
  if (!selected.has(s) && !selected.has(t)) continue;
  assert(mapping.has(s) && mapping.has(t), `Unmapped endpoint: ${s} (${mapping.has(s)}) -> ${t} (${mapping.has(t)}); row=${conditionRow}`);
  const copy = old.importNode(c, true);
  copy.setAttribute('id', `next-if-${c.getAttribute('id')}`);
  copy.setAttribute('source', mapping.get(s)); copy.setAttribute('target', mapping.get(t));
  const parent = c.getAttribute('parent');
  copy.setAttribute('parent', mapping.get(parent) || parent);
  if (!selected.has(parent)) {
    for (const p of Array.from(copy.getElementsByTagName('mxPoint'))) {
      if (p.getAttribute('as') === 'offset') continue;
      p.setAttribute('x', num(p, 'x') + dx); p.setAttribute('y', num(p, 'y') + dy);
    }
  }
  root.appendChild(copy); edgeCount++;
}
const bodyBottom = position(body, nm).y + num(geo(body), 'height') + dy;
function moveRow(node, y) {
  const row = om.get(node.getAttribute('parent')), g = geo(row);
  const current = position(node, om);
  g.setAttribute('y', num(g, 'y') + y - current.y);
}
moveRow(outside, Math.max(position(newOutside, nm).y + dy, bodyBottom + 50));
moveRow(end, position(outside, om).y + 130);
outside.setAttribute('value', '...');
const height = position(end, om).y + num(geo(end), 'height') + 50;
geo(om.get('f0-block')).setAttribute('height', height);
geo(om.get('f0-fold-layout-root')).setAttribute('height', height - 50);
const all = index(old);
assert.equal(all.size, cells(old).length, 'Duplicate cell IDs');
for (const c of cells(old)) {
  for (const a of ['parent', 'source', 'target']) if (c.hasAttribute(a)) assert(all.has(c.getAttribute(a)), `Missing ${a}`);
}
for (const required of ['logEvent(', 'getAssistantMessageFromError(', "'tengu-off-switch'", 'yield', '.activated']) {
  assert(cells(old).some(c => c.getAttribute('value') === required), `Missing ${required}`);
}
if (!process.argv.includes('--rebuild')) fs.copyFileSync(file, backup);
fs.writeFileSync(file, new XMLSerializer().serializeToString(old));
console.log(JSON.stringify({ file, addedVertices: selected.size, addedEdges: edgeCount, height }));
