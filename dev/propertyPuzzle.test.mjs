import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DOMParser} from '@xmldom/xmldom';
import {PROPERTY_TAB, updatePropertyPuzzles} from './propertyPuzzle.mjs';
import {SIDE_WIDTH,TEXT_PAD,mosaicTextWidth} from './mosaicTileGeometry.mjs';

// Regression checks use the actual, hand-composed queryModel diagram.
const file=new URL('../graph/draw/generated/queryModel.drawio',import.meta.url);
const xml=fs.readFileSync(file,'utf8');
const doc=new DOMParser().parseFromString(xml,'text/xml');
const cells=Array.from(doc.getElementsByTagName('mxCell'));
const geo=c=>c.getElementsByTagName('mxGeometry')[0];
const n=(c,key)=>Number(geo(c).getAttribute(key));
const style=c=>new Map(c.getAttribute('style').split(';').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
const svg=c=>decodeURIComponent(style(c).get('image').slice('data:image/svg+xml,'.length));
const puzzles=cells.filter(c=>c.hasAttribute('puzzleVersion'));

test('queryModel: repeat refresh does not grow or shift any tile',()=>{
  const result=updatePropertyPuzzles(xml);
  assert.equal(result.changed,0);
  assert.equal(result.repairedRoutes,0);
  assert.equal(result.xml,xml);
});

test('queryModel: every property seam has a fixed tab and protected text area',()=>{
  assert(puzzles.length>0);
  for(const c of puzzles){
    const left=c.getAttribute('puzzleLeft')==='true', right=c.getAttribute('puzzleRight')==='true';
    const s=style(c), body=svg(c);
    assert.equal(Number(s.get('spacingLeft')),TEXT_PAD+SIDE_WIDTH[c.getAttribute('mosaicLeftSide')]);
    assert.equal(Number(s.get('spacingRight')),TEXT_PAD+SIDE_WIDTH[c.getAttribute('mosaicRightSide')]);
    assert.equal(s.get('whiteSpace'),'nowrap');
    assert.equal((body.match(/<svg\b/gu)||[]).length,1,'Coordinates must be baked, not nested/scaled');
    if(left){
      assert.equal(c.getAttribute('value'),c.getAttribute('puzzleOriginalLabel').slice(1));
      assert.match(body,/<circle cx="4" cy="18" r="1.2"/u);
      const preceding=puzzles.find(p=>p!==c && p.getAttribute('parent')===c.getAttribute('parent')
        && p.getAttribute('puzzleRight')==='true' && Math.abs(n(p,'x')+n(p,'width')-n(c,'x')-PROPERTY_TAB)<.01);
      assert(preceding,`Missing socket before ${c.getAttribute('id')}`);
    }
    if(right){
      const next=puzzles.find(p=>p.getAttribute('parent')===c.getAttribute('parent')
        && p.getAttribute('puzzleLeft')==='true' && Math.abs(n(c,'x')+n(c,'width')-n(p,'x')-PROPERTY_TAB)<.01);
      assert(next);
    }
  }
  assert(puzzles.some(c=>c.getAttribute('puzzleLeft')==='true' && c.getAttribute('puzzleRight')==='true'),'Nested chains must have both joins');
  assert(puzzles.some(c=>c.getAttribute('value')==='process'),'System receiver participates too');
});

test('queryModel: all cap combinations reserve only their own fixed strips',()=>{
  const tiles=cells.filter(c=>c.getAttribute('mosaicGeometryVersion')==='3');
  assert(tiles.length>puzzles.length);
  for(const c of tiles){
    const s=style(c),left=SIDE_WIDTH[c.getAttribute('mosaicLeftSide')],right=SIDE_WIDTH[c.getAttribute('mosaicRightSide')];
    const textWidth=mosaicTextWidth(c.getAttribute('value'),{fontSize:Number(s.get('fontSize')||12),bold:(Number(s.get('fontStyle'))&1)!==0});
    assert.equal(n(c,'width'),left+TEXT_PAD+textWidth+TEXT_PAD+right);
    assert.equal(Number(s.get('spacingLeft')),left+TEXT_PAD);
    assert.equal(Number(s.get('spacingRight')),right+TEXT_PAD);
  }
  assert(tiles.some(c=>c.getAttribute('value')==='process' && c.getAttribute('mosaicLeftSide')==='hex' && c.getAttribute('mosaicRightSide')==='socket'));
});

test('queryModel: yield uses system purple',()=>{
  const yields=cells.filter(c=>c.getAttribute('value')==='yield');
  assert(yields.length>0);
  for(const c of yields){assert.match(svg(c),/#E1D5E7/);assert.match(svg(c),/#9673A6/);}
});

test('queryModel: resized terminal does not have an inward return waypoint',()=>{
  const edge=cells.find(c=>c.getAttribute('id')==='f0-e21');
  assert(edge,'Real model-stub message edge');
  assert.equal(geo(edge).getElementsByTagName('mxPoint').length,1);
});
