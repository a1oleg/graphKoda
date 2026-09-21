import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {DOMParser} from '@xmldom/xmldom';
import {compactNextRows} from './compactNextRows.mjs';

test('actual Fisher swap NEXT: compact content clearance and stable rerun',()=>{
 const xml=fs.readFileSync('graph/draw/generated/Fisher-Yates.drawio','utf8');
 const doc=new DOMParser().parseFromString(xml,'text/xml');
 const cells=Array.from(doc.getElementsByTagName('mxCell'));
 const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
 const g=c=>Array.from(c.childNodes).find(n=>n.nodeName==='mxGeometry');
 const y=c=>c?Number(g(c)?.getAttribute('y')||0)+y(byId.get(c.getAttribute('parent'))):0;
 const bottom=c=>y(c)+Number(g(c).getAttribute('height'));
 const swap=byId.get('f0-n10'),next=byId.get('f0-n12'),argument=byId.get('f0-n14');
 assert.equal(y(next)-bottom(argument),32,'clearance below the complete argument family');
 assert.equal(y(next)-bottom(swap),70,'NEXT no longer reserves 114px');
 assert.deepEqual(compactNextRows(xml,{cellIds:['f0-e17']}).changed,[]);
 assert.equal(compactNextRows(xml,{cellIds:['f0-e17']}).xml,xml);
});

test('MCP: changed NEXT and repeat routes have no findings; existing stack contacts unchanged',()=>{
 const file='graph/draw/generated/Fisher-Yates.drawio';
 const inspect=f=>JSON.parse(execFileSync(process.execPath,['C:/GitHub/drawio-inspector/src/cli.mjs','validate_geometry','--file',f,'--mode','rendered'],{encoding:'utf8'}));
 const baseline='tmp/fisher-before-next-compaction.drawio';
 fs.writeFileSync(baseline,execFileSync('git',['show',`HEAD:${file}`]));
 const key=f=>`${f.rule}:${f.participants.map(p=>p.cellId).sort().join(',')}`;
 const before=inspect(baseline),after=inspect(file);
 assert(!before.truncated&&!after.truncated);
 assert.deepEqual(after.findings.map(key).sort(),before.findings.map(key).sort());
 assert(!after.findings.some(f=>f.participants.some(p=>['f0-e17','f0-e24','f0-n12'].includes(p.cellId))));
});
