// Local visual test only. No connection to Neo4j; not included in the ZIP.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const routes = {
  '/projects/fixture/studio/bloom': ['test/fixture.html', 'text/html; charset=utf-8'],
  '/content.js': ['content.js', 'text/javascript; charset=utf-8']
};
http.createServer((req, res) => {
  const route = routes[new URL(req.url, 'http://localhost').pathname];
  if (!route) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(root, route[0])));
}).listen(18773, '127.0.0.1', () => console.log('Fixture: http://127.0.0.1:18773/projects/fixture/studio/bloom'));
