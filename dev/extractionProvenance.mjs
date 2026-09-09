import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import projectPaths from './projectPaths.cjs';

export function gitIdentity(root) {
  const git = args => execFileSync('git', args, {cwd:root, maxBuffer:64*1024*1024, stdio:['ignore','pipe','pipe']});
  const commit=git(['rev-parse','HEAD']).toString().trim();
  const status=git(['status','--porcelain=v1','-z','--untracked-files=all']);
  let dirtyFingerprint=null;
  if(status.length){
    const hash=createHash('sha256').update(status).update(git(['diff','--no-ext-diff','--binary','HEAD']));
    const untracked=git(['ls-files','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean).sort();
    for(const file of untracked){
      const absolute=path.join(root,file);
      hash.update(file).update('\0').update(fs.lstatSync(absolute).isSymbolicLink()?fs.readlinkSync(absolute):fs.readFileSync(absolute));
    }
    dirtyFingerprint=hash.digest('hex');
  }
  // Remote URLs may embed credentials. Repository commits identify the checkout
  // without serializing local credential-bearing Git configuration.
  return {commit, dirtyFingerprint};
}

export function captureExtractionProvenance(roots=projectPaths) {
  const extractor=gitIdentity(roots.toolRoot),source=gitIdentity(roots.sourceRoot);
  const identity={
    extractor_commit:extractor.commit, extractor_dirty_fingerprint:extractor.dirtyFingerprint,
    source_revision:source.commit, source_dirty_fingerprint:source.dirtyFingerprint,
    extraction_options:JSON.stringify(Object.fromEntries(Object.entries(process.env)
      .filter(([key])=>key.startsWith('GRAPH_EXTRACT_')).sort(([a],[b])=>a.localeCompare(b)))),
  };
  return {id:createHash('sha256').update(JSON.stringify(identity)).digest('hex'),...identity,extracted_at:new Date().toISOString()};
}

export function assertExtractionUnchanged(provenance) {
  if(captureExtractionProvenance().id!==provenance.id)throw new Error('Source or extractor changed during extraction; discard this result and retry.');
}
