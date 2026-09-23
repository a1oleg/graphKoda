import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const c=new Client({name:'model-sequence-heads',version:'1'});
await c.connect(new StdioClientTransport({command:'node',args:['C:/GitHub/drawio-inspector/src/mcp.mjs']}));
try{
 const file=process.argv[2]||'C:/GitHub/coldKode/graph/draw/model-stub-sequence-without-stub.drawio';
 const r=await c.callTool({name:'validate_geometry',arguments:{file,mode:'rendered',limit:500}});
 if(r.isError)throw Error(JSON.stringify(r.content));
 const d=r.structuredContent||JSON.parse(r.content[0].text);console.log(JSON.stringify(d));
 if(d.findings?.length)process.exitCode=1;
}finally{await c.close();}
