import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureExtractionProvenance} from './extractionProvenance.mjs';

test('Git identities separate source from extractor and hash untracked contents', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provenance-'));
  try {
    for(const name of ['tool','source']){
      const cwd=path.join(root,name);fs.mkdirSync(cwd);
      execFileSync('git',['init','-q'],{cwd});
      fs.writeFileSync(path.join(cwd,'file.txt'),name);
      execFileSync('git',['add','file.txt'],{cwd});
      execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd});
    }
    const roots={toolRoot:path.join(root,'tool'),sourceRoot:path.join(root,'source')};
    const original=captureExtractionProvenance(roots);
    assert.match(original.extractor_commit,/^[a-f0-9]{40}$/);
    assert.equal(original.extractor_dirty_fingerprint,null);
    fs.writeFileSync(path.join(roots.toolRoot,'new.txt'),'one');
    const first=captureExtractionProvenance(roots);
    fs.writeFileSync(path.join(roots.toolRoot,'new.txt'),'two');
    const second=captureExtractionProvenance(roots);
    assert.notEqual(first.id,second.id);
    assert.equal(first.source_revision,original.source_revision);
    assert.equal(first.source_dirty_fingerprint,null);
    fs.writeFileSync(path.join(roots.sourceRoot,'file.txt'),'changed source');
    const third=captureExtractionProvenance(roots);
    assert.notEqual(third.source_dirty_fingerprint,null);
    assert.equal(third.extractor_dirty_fingerprint,second.extractor_dirty_fingerprint);
    assert.equal(captureExtractionProvenance(roots).id,third.id);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
