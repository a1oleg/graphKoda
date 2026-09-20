import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { finishPartialFunction } from './partialFunctionDrawio.mjs';
import { horizontalMosaicImage } from './localCoordinateDrawio.mjs';

test('partial function ends in a red omission boundary below the body on the Start axis', () => {
  const cell = (id, attributes, x, y, width = 40) => `<mxCell id="${id}" parent="1" vertex="1" ${attributes}><mxGeometry x="${x}" y="${y}" width="${width}" height="40"/></mxCell>`;
  const input = `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    ${cell('start', 'value="Start"', 100, 0)}
    ${cell('body', '', 300, 200)}
    ${cell('outside', 'stableId="outside"', 300, 100, 100)}
    ${cell('end', 'graphLabels="FunctionEnd"', 100, 500)}
    <mxCell id="next" edge="1" source="outside" target="end" parent="1"/>
    </root></mxGraphModel></diagram></mxfile>`;
  const doc = new DOMParser().parseFromString(finishPartialFunction(input, 'outside'), 'text/xml');
  const cells = [...doc.getElementsByTagName('mxCell')];
  assert(!cells.some(c => ['end', 'next'].includes(c.getAttribute('id'))));
  const outside = cells.find(c => c.getAttribute('id') === 'outside');
  const g = outside.getElementsByTagName('mxGeometry')[0];
  assert.equal(Number(g.getAttribute('x')), 50);
  assert.equal(Number(g.getAttribute('y')), 300);
  assert(outside.getAttribute('style').includes('#F8CECC'));
});

test('single predicate has both tips and ochre hatching', () => {
  const svg = decodeURIComponent(horizontalMosaicImage('single', '#BE7000', '#BE7000', true, 74, true).split(',')[1]);
  assert(svg.includes("stroke='#BE7000' stroke-width='4'"));
  const path = svg.match(/<clipPath[^>]*><path d='([^']+)'/)[1];
  assert.equal((path.match(/ L /g) || []).length, 3);
  assert.equal((path.match(/ H /g) || []).length, 2);
});
