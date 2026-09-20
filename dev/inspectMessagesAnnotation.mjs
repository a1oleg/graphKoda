import { config } from 'dotenv';
import neo4j from 'neo4j-driver';
import { getAnnotationProfile, resolveAnnotationSubjects } from '../graph/packages/orchestrator/src/orchestrator/annotationProfiles.js';
import { resolveAnnotation } from '../graph/packages/orchestrator/src/orchestrator/annotationResolver.js';
import fs from 'node:fs';
config({path:'graph/.env', quiet:true});
const driver=neo4j.driver(process.env.NEO4J_URI,neo4j.auth.basic(process.env.NEO4J_USER||process.env.NEO4J_USERNAME,process.env.NEO4J_PASSWORD));
const session=driver.session({database:process.env.NEO4J_DATABASE||process.env.NEO4J_DB||'neo4j'});
try {
 if(process.argv.includes('--transactions')) {
 const r=await session.run('SHOW TRANSACTIONS YIELD transactionId, currentQuery, elapsedTime RETURN transactionId, currentQuery, elapsedTime');
 console.log(JSON.stringify(r.records.map(r=>r.toObject())));
 } else if(process.argv.includes('--resolve')) {
 const r=await resolveAnnotation(driver,process.env.NEO4J_DATABASE||process.env.NEO4J_DB||'neo4j',{
 stableId:'services/api/claude.ts:1023:2:1023:21',atStableId:'services/api/claude.ts:1023:2:1023:21',maxDepth:4,persist:false,
 onTiming:t=>{if(t.phase==='resolve-subjects'||t.phase==='load-dependencies')console.error(JSON.stringify(t));}});
 fs.writeFileSync('tmp/messages-annotation-audit.json',JSON.stringify(r,null,2));
 console.log(JSON.stringify({count:r.generationOrder.length,milliseconds:r.diagnostics.totalMilliseconds,
 tasks:r.generationOrder.map(i=>({id:i.stableId,kind:i.annotationKind})),report:'tmp/messages-annotation-audit.json'}));
 } else if(process.argv.includes('--edges')) {
 const r=await session.run(`MATCH (n {stableId: $id})-[r]-(m) RETURN properties(n) AS n,type(r) AS type,startNode(r).stableId AS from,properties(r) AS edge,properties(m) AS m,labels(m) AS labels`,{id:process.argv.at(-1)});
 console.log(JSON.stringify(r.records.map(r=>{const v=r.toObject();return {type:v.type,from:v.from,edge:v.edge,id:v.m.stableId,name:v.m.name,labels:v.labels,syntax:String(v.m.syntax||'').slice(0,300)};})));process.exitCode=0;
 } else {
 let ids=['services/api/claude.ts:1023:2:1023:21'];
 for(let depth=0;depth<3;depth++) {
  const subjects=await resolveAnnotationSubjects(session,ids);
  const next=[];
  for(const [id,s] of subjects){
   const p=getAnnotationProfile(s.annotationKind);
   const deps=p ? (p.dependenciesMany? (await p.dependenciesMany(session,[s.stableId])).get(s.stableId):await p.dependencies(session,s.stableId)):[];
   console.log(JSON.stringify({depth,id,subject:s,deps}));
   next.push(...(deps||[]).filter(d=>d.recurse).map(d=>d.stableId));
  }
  ids=[...new Set(next)];
 }
 }
}finally{await session.close();await driver.close();}
