import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const local = name => new URL(`./annotation-plan/${name}`, import.meta.url);
const assets = {
  'replay.html': [local('replay.html'), 'text/html'],
  'replay.js': [local('replay.js'), 'text/javascript'],
  'replayModel.js': [local('replayModel.js'), 'text/javascript'],
  'replayRoutes.js': [local('replayRoutes.js'), 'text/javascript'],
  'speculationReplay.js': [local('speculationReplay.js'), 'text/javascript'],
  'replay.css': [local('replay.css'), 'text/css'],
  'app.js': [local('app.js'), 'text/javascript'],
  'style.css': [local('style.css'), 'text/css'],
  'cytoscape.js': [require.resolve('cytoscape/dist/cytoscape.min.js'), 'text/javascript'],
  'dagre.js': [require.resolve('cytoscape-dagre'), 'text/javascript'],
  'icons.js': [path.join(path.dirname(require.resolve('lucide/package.json')), 'dist/umd/lucide.min.js'), 'text/javascript'],
};
export function serveAnnotationPlanUi(pathname, response) {
  const name = pathname.slice('/annotation-plan/assets/'.length);
  const entry = pathname === '/annotation-plan' ? [local('index.html'), 'text/html']
    : Object.hasOwn(assets, name) ? assets[name] : null;
  if (!entry) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': `${entry[1]}; charset=utf-8`,
    'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'" });
  response.end(fs.readFileSync(entry[0]));
}
