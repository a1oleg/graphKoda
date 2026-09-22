import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {bridge,diagramIndex} from '../graph/presentation/presentation.mjs';

export async function frameSheetScene({functionStableId,file,row=12,spreadsheetId='1otWSZpQP7BueI3vrWpc5M4qOgPxgBbpGEIW8yMEvjSw',sheet='!',apply=true}) {
  if(!Number.isInteger(row)||row<2)throw Error('Scene row must be an integer >= 2');
  const prefix=/^!+$/.test(sheet)?sheet:`'${sheet.replaceAll("'","''")}'!`;
  const sheets=fileURLToPath(new URL('../../google-sheets-mcp/',import.meta.url));
  const client=new Client({name:'scene-framing',version:'1.0.0'});
  let source;
  try {
    await client.connect(new StdioClientTransport({command:path.join(sheets,'.venv/Scripts/python.exe'),args:[path.join(sheets,'server.py')]}));
    const result=await client.callTool({name:'get_sheet_data_by_notation',arguments:{spreadsheet_id:spreadsheetId,notation:`${prefix}A${row}:L${row}`}});
    if(result.isError)throw Error(JSON.stringify(result.content));
    source=JSON.parse(result.content.find(c=>c.type==='text').text);
  } finally {await client.close();}
  const [,,,,,top,bottom]=source.values[0];
  if(!top||!bottom)throw Error('Both upper and lower framing targets are required in F:G');
  const index=await diagramIndex({file});
  const head=id=>{
    const matches=index.cells.filter(c=>c.stableId===id);
    const heads=matches.filter(c=>!matches.some(p=>p.cellId===c.parent));
    if(heads.length!==1)throw Error('Ambiguous framing head: '+id);
    return heads[0];
  };
  const upper=head(top),lower=head(bottom);
  const rightId=source.values[0][7];
  const rightmost=rightId&&rightId!=='нет'?head(rightId):null;
  const command={functionStableId,surface:'diagram',action:'presentFocus',stableId:top,cellId:upper.cellId,bottomStableId:bottom,bottomCellId:lower.cellId};
  const result=apply?await bridge(command):{};
  return {source,upper,lower,rightmost,command,...result};
}
