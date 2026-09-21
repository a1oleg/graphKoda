import assert from 'node:assert/strict';
import test from 'node:test';
import { methodMosaicImage } from './localCoordinateDrawio.mjs';
import { mosaicTileImage } from './mosaicTileGeometry.mjs';

test('resized virtual method retains separate hatch and outline colors', () => {
  const svg=decodeURIComponent(methodMosaicImage('start','#99CCFF','#0088FF',{sketch:true}).split(',')[1]);
  const layout={width:36,left:'round',right:'flat'};
  const resized=decodeURIComponent(mosaicTileImage(svg,layout,30).split(',')[1]);
  assert.match(resized,/stroke="#99CCFF" stroke-width="4"/);
  assert.match(resized,/fill="none" stroke="#0088FF" stroke-width="1"/);
  assert.doesNotMatch(resized,/opacity=/);
  const twice=decodeURIComponent(mosaicTileImage(resized,layout,30).split(',')[1]);
  assert.equal(twice,resized);
});
