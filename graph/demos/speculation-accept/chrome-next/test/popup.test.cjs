const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function popup(t, sendMessage) {
  const root = path.join(__dirname, '..');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'), { runScripts: 'outside-only' });
  dom.window.chrome = { tabs: { query: async () => [{ id: 42 }], sendMessage } };
  dom.window.eval(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'));
  t.after(() => dom.window.close());
  return dom.window.document;
}

test('popup exposes one next button and sends commands to the active tab', async t => {
  const calls=[];
  const doc=popup(t, async (id, message) => {
    calls.push([id,message.type]);
    return {isBloom:true,step:'0 / 3',title:'Ready',status:'Empty',disabled:message.type==='bloom-next',error:false};
  });
  await pause(20);
  assert.equal(doc.querySelectorAll('button').length,1);
  const button=doc.querySelector('button');
  assert.equal(button.textContent,'next');assert.equal(button.disabled,false);
  button.click();button.click();await pause(20);
  assert.deepEqual(calls,[[42,'bloom-state'],[42,'bloom-next']]);
  assert.equal(button.disabled,true);
});

test('popup handles a tab without the Bloom content script', async t => {
  const doc=popup(t, async () => {throw new Error('No receiver');});
  await pause(20);
  assert.equal(doc.querySelector('button').disabled,true);
  assert.ok(doc.getElementById('status').classList.contains('error'));
});
