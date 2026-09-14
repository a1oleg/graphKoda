import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { collectionTileImage } from './localCoordinateDrawio.mjs';

test('collection tile has two opaque rectangles inside its bounds', () => {
  const svg = decodeURIComponent(collectionTileImage().split(',')[1]);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  assert.equal(doc.getElementsByTagName('rect').length, 2);
  assert.equal(doc.getElementsByTagName('g')[0].getAttribute('fill'), '#FFE6CC');
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
