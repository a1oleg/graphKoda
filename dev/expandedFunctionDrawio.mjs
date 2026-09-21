import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { expandedFunctionView } from './expandedFunctionView.mjs';

const elements = (node, tag) => Array.from(node.getElementsByTagName(tag));
const geometry = cell => elements(cell, 'mxGeometry')[0];
const number = (element, key) => Number(element?.getAttribute(key) || 0);

export function composeExpandedFunctions(rootId, functions, calls, documents, options = {}) {
  const view = { ...expandedFunctionView, ...options };
  const output = new DOMParser().parseFromString('<mxfile><diagram id="fisher-yates" name="Fisher-Yates"><mxGraphModel grid="1" gridSize="10" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>', 'text/xml');
  const root = elements(output, 'root')[0];
  const diagram = elements(output, 'diagram')[0];
  diagram.setAttribute('name', view.name || functions.get(rootId).name);
  diagram.setAttribute('viewKind', view.kind);
  diagram.setAttribute('secondaryParameters', view.secondaryParameters);
  diagram.setAttribute('alignCalledStart', String(view.alignCalledStart));
  let serial = 0;
  const boxes = [];
  function element(tag, attrs, parent) {
    const node = output.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    parent?.appendChild(node);
    return node;
  }
  function build(fnId, ancestors = new Set()) {
    assert(!ancestors.has(fnId), 'Recursive expansion requires a reference boundary');
    const branch = new Set([...ancestors, fnId]);
    const prefix = `f${serial++}-`;
    const doc = new DOMParser().parseFromString(documents.get(fnId), 'text/xml');
    const cells = elements(doc, 'mxCell').filter(c => !['0', '1'].includes(c.getAttribute('id')));
    const byId = new Map(cells.map(c => [c.getAttribute('id'), c]));
    function bounds(cell) {
      const g = geometry(cell);
      let x = number(g, 'x'), y = number(g, 'y');
      let parent = byId.get(cell.getAttribute('parent'));
      const seen = new Set();
      while (parent) {
        assert(!seen.has(parent)); seen.add(parent);
        x += number(geometry(parent), 'x'); y += number(geometry(parent), 'y');
        parent = byId.get(parent.getAttribute('parent'));
      }
      return { x, y, width: number(g, 'width'), height: number(g, 'height') };
    }
    const vertices = cells.filter(c => c.getAttribute('vertex') === '1');
    const rects = vertices.map(bounds);
    const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
    const ownWidth = Math.max(...rects.map(r => r.x + r.width)) - minX + 60;
    const ownHeight = Math.max(...rects.map(r => r.y + r.height)) - minY + 80;
    const group = element('mxCell', { id: prefix + 'block', vertex: 1, parent: '1', value: functions.get(fnId).name,
      stableId: fnId, graphKind: 'Fn', functionStableId: fnId,
      style: 'shape=coldKodeFoldingFrame;html=1;flowBlock=1;rounded=0;fillColor=none;strokeColor=#878787;strokeWidth=1.5;verticalAlign=top;align=left;spacing=8;fontStyle=1;collapsible=0;container=1;recursiveResize=0;' }, root);
    const groupGeometry = element('mxGeometry', { x: 0, y: 0, width: ownWidth, height: ownHeight, as: 'geometry' }, group);
    const copied = new Map();
    for (const cell of cells) {
      const clone = output.importNode(cell, true);
      const id = cell.getAttribute('id'); copied.set(id, clone);
      clone.setAttribute('id', prefix + id);
      for (const key of ['parent', 'source', 'target']) {
        const value = cell.getAttribute(key);
        if (value) clone.setAttribute(key, value === '1' ? prefix + 'block' : prefix + value);
      }
      if (cell.getAttribute('parent') === '1') {
        const g = geometry(clone);
        if (cell.getAttribute('vertex') === '1') {
          g.setAttribute('x', number(g, 'x') - minX + 30);
          g.setAttribute('y', number(g, 'y') - minY + 50);
        } else for (const point of elements(g, 'mxPoint')) {
          if (point.getAttribute('as') === 'offset') continue;
          point.setAttribute('x', number(point, 'x') - minX + 30);
          point.setAttribute('y', number(point, 'y') - minY + 50);
        }
      }
      root.appendChild(clone);
    }
    let nextY = 0, width = ownWidth, height = ownHeight;
    for (const call of calls.filter(c => c.owner === fnId)) {
      const candidates = vertices.filter(c => !c.getAttribute('id').startsWith('fold-') &&
        (c.getAttribute('stableId') === call.id || c.getAttribute('sourceCallStableId') === call.id));
      assert(candidates.length, `Call has no rendered anchor: ${call.id}`);
      const anchor = candidates.sort((a, b) => bounds(b).x + bounds(b).width - bounds(a).x - bounds(a).width)[0];
      const pos = bounds(anchor);
      const child = build(call.callee, branch);
      const anchorY = pos.y - minY + 50 + pos.height / 2;
      const y = Math.max(nextY, view.alignCalledStart ? anchorY - child.startY : pos.y - minY + 50);
      child.group.setAttribute('parent', prefix + 'block');
      child.g.setAttribute('x', ownWidth + 100); child.g.setAttribute('y', y);
      nextY = y + child.height + 60;
      width = Math.max(width, ownWidth + 100 + child.width + 30);
      height = Math.max(height, nextY);
      const edge = element('mxCell', { id: prefix + `call-${child.id}`, edge: 1, parent: prefix + 'block',
        source: copied.get(anchor.getAttribute('id')).getAttribute('id'), target: child.start,
        stableId: call.id, targetStableId: call.callee, edgeType: 'CALLS', graphKind: 'edge', value: 'call',
        style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;strokeColor=#0088FF;fontColor=#0088FF;dashed=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;' }, root);
      const eg = element('mxGeometry', { relative: 1, as: 'geometry' }, edge);
      const points = element('Array', { as: 'points' }, eg);
      element('mxPoint', { x: ownWidth + 50, y: pos.y - minY + 50 + pos.height / 2 }, points);
      element('mxPoint', { x: ownWidth + 50, y: y + child.startY }, points);
    }
    groupGeometry.setAttribute('width', width); groupGeometry.setAttribute('height', height);
    const start = vertices.find(c => !c.getAttribute('id').startsWith('fold-') && (c.getAttribute('graphLabels') || '').includes('FunctionStart'));
    assert(start, `No start for ${fnId}`);
    boxes.push({ id: fnId, width, height });
    return { id: prefix, group, g: groupGeometry, width, height, start: prefix + start.getAttribute('id'), startY: bounds(start).y - minY + 50 + bounds(start).height / 2 };
  }
  const tree = build(rootId);
  tree.g.setAttribute('x', 40); tree.g.setAttribute('y', 40);
  const all = elements(output, 'mxCell');
  const ids = new Set(all.map(c => c.getAttribute('id')));
  assert.equal(ids.size, all.length, 'Duplicate diagram cell IDs');
  for (const c of all) for (const key of ['parent', 'source', 'target']) {
    const id = c.getAttribute(key); if (id) assert(ids.has(id), `Missing ${key} ${id}`);
  }
  return { xml: new XMLSerializer().serializeToString(output), boxes };
}
