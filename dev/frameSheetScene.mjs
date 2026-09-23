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
  let source,headers;
  try {
    await client.connect(new StdioClientTransport({command:path.join(sheets,'.venv/Scripts/python.exe'),args:[path.join(sheets,'server.py')]}));
    const result=await client.callTool({name:'get_sheet_data_by_notation',arguments:{spreadsheet_id:spreadsheetId,notation:`${prefix}A${row}:L${row}`}});
    if(result.isError)throw Error(JSON.stringify(result.content));
    source=JSON.parse(result.content.find(c=>c.type==='text').text);
    const headerResult=await client.callTool({name:'get_sheet_data_by_notation',arguments:{spreadsheet_id:spreadsheetId,notation:`${prefix}A1:N1`}});
    if(headerResult.isError)throw Error(JSON.stringify(headerResult.content));
    headers=JSON.parse(headerResult.content.find(c=>c.type==='text').text).values[0];
  } finally {await client.close();}
  const value=(pattern,required=false)=>{
    const i=headers.findIndex(h=>pattern.test(String(h).trim().toLowerCase()));
    if(i<0&&required)throw Error('Missing framing column: '+pattern);
    return String(source.values[0][i]||'').replace(/^stableId:\s*/i,'').trim();
  };
  const top=value(/^(?:стартовый\s+)?верхний/,true),bottom=value(/^(?:стартовый\s+)?нижний/,true);
  if(!top||!bottom)throw Error('Both upper and lower framing targets are required');
  const index=await diagramIndex({file});
  const head=id=>{
    const matches=index.cells.filter(c=>c.stableId===id);
    const heads=matches.filter(c=>!matches.some(p=>p.cellId===c.parent));
    if(heads.length!==1)throw Error('Ambiguous framing head: '+id);
    return heads[0];
  };
  const upper=head(top),lower=head(bottom);
  const rightId=value(/^(?:крайний )?правый/),leftId=value(/^(?:крайний )?левый/);
  const rightmost=rightId&&rightId!=='нет'?head(rightId):null;
  const command={functionStableId,surface:'diagram',action:'presentFocus',stableId:top,cellId:upper.cellId,bottomStableId:bottom,bottomCellId:lower.cellId};
  const leftmost=leftId&&leftId!=='нет'?head(leftId):null;
  if(leftmost)Object.assign(command,{leftStableId:leftmost.stableId,leftCellId:leftmost.cellId});
  if(rightmost)Object.assign(command,{rightStableId:rightmost.stableId,rightCellId:rightmost.cellId});
  const result=apply?await bridge(command):{};
  return {source,headers,upper,lower,leftmost,rightmost,command,...result};
}
