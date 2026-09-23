import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {alignEdgePorts} from './edgePortAlignment.mjs';
import {compactVerticalContinuations} from './compactVerticalContinuations.mjs';

const file='C:/GitHub/graphKoda/graph/draw/generated/queryModel.drawio';
const cellIds=['f0-e9','f0-e27','f0-e28','f0-e30','f0-e32','f0-e34','f0-e35','f0-e39','f0-e40'];
test('actual queryModel: reported routes meet their port normals in draw.io',async()=>{
  const require=createRequire('C:/GitHub/drawio-inspector/package.json');
  const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const client=new Client({name:'queryModel-port-regression',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['C:/GitHub/drawio-inspector/src/mcp.mjs']}));
  try {
    const inspected=[];
    for(const cellId of cellIds) {
      const result=await client.callTool({name:'inspect_element',arguments:{file,cellId,mode:'rendered'}},undefined,{timeout:180000});
      assert.ok(!result.isError);
      const edge=result.structuredContent.elements[0];
      const points=edge.route.filter((p,i,a)=>!i||Math.hypot(p.x-a[i-1].x,p.y-a[i-1].y)>.01);
      if(cellId==='f0-e34') {
        const end=points.at(-1);
        let branchStart=end;
        for(const p of [...points].reverse()){if(Math.abs(p.y-end.y)>.1)break;branchStart=p;}
        assert.ok(edge.textBounds.x>=branchStart.x,'ARG label must fit on its own branch');
        const gap=end.x-edge.textBounds.x-edge.textBounds.width;
        assert.ok(gap>=6&&gap<=12,'ARG label must hug its right endpoint');
      }
      if(cellId==='f0-e30'||cellId==='f0-e32') {
        assert.ok(points.every(p=>Math.abs(p.x-points[0].x)<.1),
          'Compound-condition continuation must share the upstream axis, without rightward drift');
      }
      if(cellId==='f0-e32') {
        assert.equal(Number(edge.portStyle.exitX),.5,'TRUE must leave the predicate centre');
        // 151 px includes the preceding compound row's set/eval footprint
        // and the side block header; the former extra 234 px is absent.
        assert.ok(points.at(-1).y-points[0].y<=151.1,'Side block must not retain a blank vertical reservation');
      }
      for(const [prefix,p,q] of [['exit',points[0],points[1]],['entry',points.at(-1),points.at(-2)]]) {
        const y=Number(edge.portStyle[prefix+'Y']);
        const vertical=y===0||y===1;
        assert.ok(Math.abs(p[vertical?'x':'y']-q[vertical?'x':'y'])<.1,`${cellId} ${prefix}: sideways kink`);
        if(vertical) assert.ok(y===0?q.y<p.y:q.y>p.y,`${cellId} ${prefix}: reversed normal`);
      }
      inspected.push(edge);
    }
    const joins=inspected.filter(e=>['f0-e35','f0-e39'].includes(e.cellId));
    assert.deepEqual(joins[0].route.slice(-2),joins[1].route.slice(-2),'Argument joins share the final entry segment');
    const opening=await client.callTool({name:'inspect_element',arguments:{file,cellId:'f0-n22-part-9',mode:'rendered'}},undefined,{timeout:180000});
    assert.ok(!opening.isError);
    assert.equal(opening.structuredContent.elements[0].label,'(');
    const validation=await client.callTool({name:'validate_geometry',arguments:{file,mode:'rendered'}},undefined,{timeout:180000});
    assert.ok(!validation.isError);
    assert.ok(!validation.structuredContent.findings.some(f=>f.participants?.some(p=>cellIds.includes(p.cellId))),
      'Reported edges must not intersect vertices after alignment');
    fs.writeFileSync('tmp/queryModel-port-validation.json',JSON.stringify({inspected,validation:validation.structuredContent},null,2));
    console.log(JSON.stringify({checkedEdges:validation.structuredContent.checkedEdges,
      reportedEdges:cellIds,otherFindings:validation.structuredContent.totalFindings}));
  }finally{await client.close();}
});
test('actual queryModel: targeted alignment is idempotent',()=>{
  const xml=fs.readFileSync(file,'utf8');
  assert.equal(alignEdgePorts(xml,{cellIds}).changed,0);
  assert.deepEqual(compactVerticalContinuations(xml,{cellIds:['f0-e30','f0-e32']}).moved,[]);
});
