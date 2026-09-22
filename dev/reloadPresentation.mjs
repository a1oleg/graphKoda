import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://127.0.0.1:17844';
const health=async()=>{
  const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw Error('Presentation health failed');
  return response.json();
};
const before=await health();
if(before.presentationWindow!==true)throw Error('Not a presentation window');
const tokenFile=path.join(root,'tmp/graph-presenter-token.local');
const token=(await fs.readFile(tokenFile,'utf8')).trim();
const response=await fetch(origin+'/demo/step',{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
  body:JSON.stringify({surface:'window',action:'reload'}),signal:AbortSignal.timeout(5000),
});
const result=await response.json();
if(!response.ok||result.stage!=='reload-scheduled')throw Error(result.error||'Reload was not scheduled');
const deadline=Date.now()+60000;
while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,500));
  try {
    const after=await health();
    const refreshedToken=(await fs.readFile(tokenFile,'utf8')).trim();
    if(after.presentationWindow&&after.pid!==before.pid&&refreshedToken!==token){
      console.log(JSON.stringify({stage:'reloaded',beforePid:before.pid,pid:after.pid,version:after.version}));
      process.exit(0);
    }
  } catch {}
}
throw Error('Reload was scheduled but a new presentation host did not become ready in 60 seconds');
