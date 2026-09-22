import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bridge,diagramIndex} from '../graph/presentation/presentation.mjs';

export async function frameSheetScene({functionStableId,file,row=12}) {
  const sheets=fileURLToPath(new URL('../../google-sheets-mcp/',import.meta.url));
  const client=new Client({name:'scene-framing',version:'1.0.0'});
  let source;
  try {
    await client.connect(new StdioClientTransport({command:path.join(sheets,'.venv/Scripts/python.exe'),args:[path.join(sheets,'server.py')]}));
    const result=await client.callTool({name:'get_sheet_data_by_notation',arguments:{spreadsheet_id:'1otWSZpQP7BueI3vrWpc5M4qOgPxgBbpGEIW8yMEvjSw',notation:`!F${row}:G${row}`}});
    if(result.isError)throw Error(JSON.stringify(result.content));
    source=JSON.parse(result.content.find(c=>c.type==='text').text);
  } finally {await client.close();}
  const [top,bottom]=source.values[0];
  const index=await diagramIndex({file});
  const head=id=>{
    const matches=index.cells.filter(c=>c.stableId===id);
    const heads=matches.filter(c=>!matches.some(p=>p.cellId===c.parent));
    if(heads.length!==1)throw Error('Ambiguous framing head: '+id);
    return heads[0];
  };
  const upper=head(top),lower=head(bottom);
  const result=await bridge({functionStableId,surface:'diagram',action:'presentFocus',stableId:top,cellId:upper.cellId,bottomStableId:bottom,bottomCellId:lower.cellId});
  return {source,upper,lower,...result};
}
