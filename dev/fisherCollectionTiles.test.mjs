import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { collectionTileImage, collectionTileBackCells } from './localCoordinateDrawio.mjs';

test('collection backs extend outside the unchanged front tile bounds', () => {
  const doc = new DOMParser().parseFromString(`<root>${collectionTileBackCells('tile', 'group', 60, 0, 100, 40).join('')}</root>`, 'application/xml');
  const layers = Array.from(doc.getElementsByTagName('mxGeometry'));
  assert.deepEqual(layers.map(n => Number(n.getAttribute('x'))), [46, 53]);
  assert.deepEqual(layers.map(n => Number(n.getAttribute('y'))), [-14, -7]);
  assert.ok(layers.every(n => n.getAttribute('width') === '100' && n.getAttribute('height') === '40'));
  assert.ok(decodeURIComponent(collectionTileImage()).includes("H 100 V 49"));
});

test('Fisher extraction splits index access and marks collection arguments and returns', () => {
  const payload = JSON.parse(fs.readFileSync(new URL('../tmp/fisher-yates/extracted.json', import.meta.url)));
  const read = payload.nodes.find(n => n.label === 'indexed field value');
  const parts = JSON.parse(read.renderPartsJson);
  assert.deepEqual(parts.map(p => p.text), ['alphabet', '[', 'current', '.index', ']']);
  assert.ok(parts[3].labels.includes('FieldAccess'));
  const arg = payload.nodes.find(n => n.labels.includes('ArgumentOccurrence') && n.diaName === 'alphabet');
  assert.ok(arg.labels.includes('Collection'));
  const returned = payload.nodes.find(n => n.labels.includes('Return') && n.actionTextRaw?.includes('return alphabet'));
  assert.ok(JSON.parse(returned.renderPartsJson)[1].labels.includes('Collection'));
});
