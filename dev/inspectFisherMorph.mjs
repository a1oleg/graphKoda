import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const c=new Client({name:'fisher-morph',version:'1'});await c.connect(new StdioClientTransport({command:'node',args:['C:/GitHub/drawio-inspector/src/mcp.mjs']}));
try{for(const [file,cellId] of [['graph/draw/FY-sequence.drawio','c8'],['graph/draw/generated/Fisher-Yates.drawio','f0-n1']]){
 const r=await c.callTool({name:'inspect_region',arguments:{file:'C:/GitHub/graphKoda/'+file,cellId,padding:10000,limit:500,mode:'xml'}});if(r.isError)throw Error(JSON.stringify(r.content));
 const d=r.structuredContent||JSON.parse(r.content[0].text);
 console.log(JSON.stringify({file,elements:d.elements.filter(n=>file.includes('FY-sequence')||/^(f[012]-n1|f0-n[45])$/.test(n.cellId)||n.stableId==='examples/fisher-yates/src/shuffle.ts:25:8:25:25').map(n=>({id:n.cellId,stableId:n.stableId,label:n.label,b:n.bounds,source:n.source,target:n.target,points:n.xmlWaypoints}))}));
}}finally{await c.close();}
