// One step at a time; token stays on this machine and is never printed.
import fs from 'node:fs/promises';
const input = JSON.parse(process.argv[2] === '--file' ? await fs.readFile(process.argv[3], 'utf8') : process.argv[2] || '{}');
const token = (await fs.readFile(new URL('../tmp/graph-demo-token.local', import.meta.url), 'utf8')).trim();
const response = await fetch('http://127.0.0.1:17843/demo/step', {
  method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
  body:JSON.stringify(input),signal:AbortSignal.timeout(20000),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
console.log(JSON.stringify(result,null,2));
