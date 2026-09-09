import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DuckDBInstance} from '@duckdb/node-api';
import {FunctionFlowDuckdbStage} from './functionFlowDuckdbStage.ts';
import {payloadForTransport} from './fromASTtoPreGraphFlow.ts';
import {captureExtractionProvenance} from '../../../dev/extractionProvenance.mjs';

test('catalog passport and per-fact IDs survive Python reading and reject a mismatched manifest',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-provenance-'));
  try {
    const db=path.join(root,'stage.duckdb'),parquet=path.join(root,'parquet');
    const provenance=captureExtractionProvenance();
    const stage=await FunctionFlowDuckdbStage.create(db,parquet,undefined,provenance);
    stage.addEntity('node',{stableId:'a',labels:['Value'],props:{}});
    stage.addEntity('node',{stableId:'b',labels:['Value'],props:{}});
    stage.addRelationship('edge',{fromId:'a',toId:'b',type:'VALUE_FROM',props:{}});
    await stage.finalize();
    const instance=await DuckDBInstance.create(':memory:');const connection=await instance.connect();
    try{
      for(const file of ['nodes','relationships']){
        const result=await connection.runAndReadAll(`SELECT DISTINCT provenance_id FROM read_parquet('${parquet.replaceAll("'","''")}/${file}.parquet')`);
        assert.deepEqual(result.getRows(),[[provenance.id]]);
      }
    }finally{connection.closeSync();instance.closeSync();}
    const python=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python';
    execFileSync(python,['-c',`
import sys,json,pyarrow as pa,pyarrow.parquet as pq
sys.path.insert(0,'graph/static-extract/py')
from function_flow_catalog import FunctionFlowCatalog
catalog=FunctionFlowCatalog(__import__('pathlib').Path(sys.argv[1]),__import__('pathlib').Path(sys.argv[2]))
assert list(catalog.iter_entities(1))[0][0]['props']['provenance_id']==sys.argv[3]
assert list(catalog.iter_relationships(1))[0][0]['props']['provenance_id']==sys.argv[3]
catalog.close()
file=__import__('pathlib').Path(sys.argv[2])/'provenance.parquet'
rows=pq.read_table(file).to_pylist(); rows[0]['metadata_json']='{}';pq.write_table(pa.Table.from_pylist(rows),file)
try: FunctionFlowCatalog(__import__('pathlib').Path(sys.argv[1]),__import__('pathlib').Path(sys.argv[2]))
except RuntimeError: pass
else: raise AssertionError('mismatched manifest accepted')
`,db,parquet,provenance.id],{stdio:'pipe'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('scoped transport uses the captured passport on every node and edge',()=>{
  const provenance=captureExtractionProvenance();
  const payload=payloadForTransport({functions:[],nodes:[],edges:[],semanticEntities:[{stableId:'a',labels:['Value'],props:{}}],semanticRelationships:[{fromId:'a',toId:'a',type:'VALUE_FROM',props:{}}]} as any,provenance);
  assert.equal(payload.provenance.id,provenance.id);
  assert.equal(payload.semanticEntities[0].props.provenance_id,provenance.id);
  assert.equal(payload.semanticRelationships[0].props.provenance_id,provenance.id);
});
