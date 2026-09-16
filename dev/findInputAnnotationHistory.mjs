import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DOMParser } from '@xmldom/xmldom';

const repo = process.argv[2] || 'C:/GitHub/claude-code';
const file = 'graph/draw/generated/onSubmit-REPL.tsx-3142.drawio';
const id = 'screens/REPL.tsx:3142:38:3142:51';
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
const commits = git(['log', '--format=%H', '--', file]).trim().split('\n');
for (const commit of commits) {
  let xml;
  try { xml = git(['show', `${commit}:${file}`]); } catch { continue; }
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const cells = Array.from(doc.getElementsByTagName('mxCell'));
  const targets = cells.filter(cell => [id, `${id}:parameter`].includes(cell.getAttribute('stableId')));
  const ids = new Set(targets.map(cell => cell.getAttribute('id')));
  const annotations = cells.filter(cell => ids.has(cell.getAttribute('annotationTargetId'))
    || (ids.has(cell.getAttribute('id')) && cell.getAttribute('annotationEmbedded') === '1'));
  for (const annotation of annotations) {
    const text = annotation.getAttribute('annotationSavedText') || annotation.getAttribute('value');
    if (!text) continue;
    const found = { repo, commit, stableId: id, text,
      toolGitCommitShortHash: annotation.getAttribute('annotationToolGitCommitShortHash') || null,
      maxDepth: annotation.getAttribute('annotationMaxDepth') || null };
    fs.writeFileSync('tmp/input-annotation-recovered.json', JSON.stringify(found, null, 2));
    console.log(JSON.stringify(found, null, 2));
    process.exit(0);
  }
}
console.log('No annotation found');
