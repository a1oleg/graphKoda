import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// A partial body ends at its explicit omission boundary, not at the function's End.
export function finishPartialFunction(xml, boundaryStableId) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const cells = [...doc.getElementsByTagName('mxCell')];
  const byId = new Map(cells.map(cell => [cell.getAttribute('id'), cell]));
  const geometry = cell => cell?.getElementsByTagName('mxGeometry')[0];
  const number = (node, key) => Number(node?.getAttribute(key) || 0);
  const position = cell => {
    if (!cell) return { x: 0, y: 0 };
    const parent = position(byId.get(cell.getAttribute('parent')));
    return { x: parent.x + number(geometry(cell), 'x'), y: parent.y + number(geometry(cell), 'y') };
  };
  const vertex = cell => cell.getAttribute('vertex') === '1';
  const start = cells.find(cell => vertex(cell) && cell.getAttribute('value') === 'Start');
  const boundary = cells.find(cell => vertex(cell) && cell.getAttribute('stableId') === boundaryStableId);
  assert(start && boundary, 'Partial function needs Start and an explicit boundary');
  const boundaryChildren = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const cell of cells) if ((cell.getAttribute('parent') === boundary.getAttribute('id')
      || boundaryChildren.has(cell.getAttribute('parent'))) && !boundaryChildren.has(cell.getAttribute('id'))) {
      boundaryChildren.add(cell.getAttribute('id')); changed = true;
    }
  }
  for (const cell of cells) {
    for (const endpoint of ['source', 'target']) if (boundaryChildren.has(cell.getAttribute(endpoint))) cell.setAttribute(endpoint, boundary.getAttribute('id'));
  }
  const removed = new Set(cells.filter(cell => vertex(cell)
    && (cell.getAttribute('graphLabels') || '').split(',').includes('FunctionEnd')).map(cell => cell.getAttribute('id')));
  for (const cell of cells) if (removed.has(cell.getAttribute('parent'))
    || [...removed].some(id => cell.getAttribute('id') === `${id}-function-caption`)) removed.add(cell.getAttribute('id'));
  const parents = new Set(cells.map(cell => cell.getAttribute('parent')));
  const visibleLeaves = cells.filter(cell => vertex(cell) && !parents.has(cell.getAttribute('id'))
    && !removed.has(cell.getAttribute('id')) && !boundaryChildren.has(cell.getAttribute('id')) && cell !== boundary);
  const bottom = Math.max(...visibleLeaves.map(cell => position(cell).y + number(geometry(cell), 'height')));
  const parent = position(byId.get(boundary.getAttribute('parent')));
  const g = geometry(boundary);
  g.setAttribute('width', '140');
  g.setAttribute('height', '40');
  boundary.setAttribute('value', 'Outside diff');
  g.setAttribute('x', position(start).x + number(geometry(start), 'width') / 2 - number(g, 'width') / 2 - parent.x);
  g.setAttribute('y', bottom + 60 - parent.y);
  boundary.setAttribute('style', 'rounded=0;whiteSpace=wrap;html=1;fillColor=#F8CECC;strokeColor=#B85450;fontColor=#8B1A1A;');
  for (const cell of cells) {
    if (boundaryChildren.has(cell.getAttribute('id')) || removed.has(cell.getAttribute('id')) || removed.has(cell.getAttribute('source')) || removed.has(cell.getAttribute('target'))) {
      cell.parentNode?.removeChild(cell);
    } else if (cell.getAttribute('target') === boundary.getAttribute('id')) {
      for (const points of [...cell.getElementsByTagName('Array')]) points.parentNode.removeChild(points);
    }
  }
  // Expand containing frames without moving the preceding composition.
  for (let frame = byId.get(boundary.getAttribute('parent')); frame && geometry(frame); frame = byId.get(frame.getAttribute('parent'))) {
    geometry(frame).setAttribute('height', Math.max(number(geometry(frame), 'height'), bottom + 60 + number(g, 'height') + 30 - position(frame).y));
  }
  return new XMLSerializer().serializeToString(doc);
}
