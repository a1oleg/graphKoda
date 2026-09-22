import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bridge} from '../graph/presentation/presentation.mjs';
import {frameSheetScene} from './frameSheetScene.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=JSON.parse(await fs.readFile(path.join(root,'tmp/fisher-yates/runtime/latest.json'),'utf8'));
const file=path.join(root,'graph/draw/generated/Fisher-Yates.drawio');
const client=new Client({name:'fisher-live-cases',version:'1.0.0'});
const report={sessionId:run.sessionId,stages:[]};
const out=path.join(root,'tmp/fisher-yates/runtime/live-cases-audit.json');
const base={functionStableId:run.root};
const pause=()=>new Promise(resolve=>setTimeout(resolve,600));
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(root,'../drawio-inspector/src/mcp.mjs')]}));
  const response=await client.callTool({name:'inspect_region',arguments:{file,mode:'rendered',stableId:run.loop,padding:1000,limit:500}},undefined,{timeout:180000});
  if(response.isError)throw Error(JSON.stringify(response.content));
  const region=response.structuredContent;
  report.mcp=region;
  const entry=region.elements.find(e=>e.kind==='vertex'&&e.stableId===run.loop&&e.label==='for');
  assert(entry,'MCP did not find the loop');
  const targets=region.elements.filter(e=>e.kind==='vertex'&&e.cellId.startsWith('f0-')
    && ['for','current.value','random','swap','current.index'].includes(e.label));
  const reads=async(stage)=>{
    const nodes=[];
    for(const target of targets){
      nodes.push({label:target.label,...await bridge({...base,surface:'diagram',action:'presentRead',stableId:target.stableId,cellId:target.cellId})});
    }
    report.stages.push({stage,nodes});
    await fs.writeFile(out,JSON.stringify(report,null,2));
    console.log(JSON.stringify({stage,nodes:nodes.map(n=>({label:n.label,cellId:n.cellId,visible:n.visible,bounds:n.screenBounds}))}));
    return nodes;
  };
  await bridge({...base,surface:'editor',action:'openDiagram',filePath:file});
  report.framing=await frameSheetScene({functionStableId:run.root,file});
  const lowerParts=region.elements.filter(e=>e.kind==='vertex'&&e.stableId===report.framing.lower.stableId);
  const bottom=lowerParts.reduce((a,b)=>a.bounds.y+a.bounds.height>b.bounds.y+b.bounds.height?a:b);
  if(!targets.some(e=>e.cellId===bottom.cellId))targets.push(bottom);
  await pause();
  const before=await reads('before-panel');
  const upperFrame=before.find(n=>n.cellId===entry.cellId);
  const lowerFrame=before.find(n=>n.cellId===bottom.cellId);
  assert(Math.abs(upperFrame.screenBounds.y-16)<2,'Upper target is not at the top margin');
  assert(Math.abs(lowerFrame.viewport.height-lowerFrame.screenBounds.y-lowerFrame.screenBounds.height-16)<2,'Lower target is not at the bottom margin');
  assert(before.find(n=>n.cellId===entry.cellId)?.visible,'Loop is not visible before opening statistics');
  await bridge({...base,surface:'diagram',action:'presentPointer',stableId:run.loop,cellId:entry.cellId,text:'for',pointerId:'narrator'});
  await bridge({...base,surface:'diagram',action:'contextMenu',cellId:entry.cellId});
  await bridge({...base,surface:'diagram',action:'menuClick',label:'показать статистику Цикла'});
  await bridge({...base,surface:'runtime',action:'waitForAnalysis',sessionId:run.sessionId});
  await pause();
  const opened=await reads('panel-opened');
  const compare=(nodes,expected)=>{
    for(const node of nodes){
      const original=expected.find(n=>n.cellId===node.cellId);
      if(!original.visible)continue;
      assert(node.visible,`${node.label} left the visible viewport`);
      for(const key of ['x','y','width','height']) assert(Math.abs(node.screenBounds[key]-original.screenBounds[key])<1,`${node.label}: screen ${key} changed`);
    }
  };
  compare(opened,before);
  for(let index=0;index<8;index++){
    await bridge({...base,surface:'runtime',action:'selectCase',index,sessionId:run.sessionId});
    await pause();
    compare(await reads('case-'+index),opened);
  }
  await bridge({...base,surface:'runtime',action:'selectAll',sessionId:run.sessionId});
  await pause();
  compare(await reads('clear'),opened);
  report.passed=true;
} catch(error){report.error=error.message;throw error;}
finally {await fs.writeFile(out,JSON.stringify(report,null,2));await client.close();}
