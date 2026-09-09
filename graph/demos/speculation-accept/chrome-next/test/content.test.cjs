const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createBloomNext, STEPS } = require('../content.js');

const TOTALS = [227, 316, 317];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { total = 0, query = '', fail = false, clearDelay = 0, completeDelay = 8, initial = 0, resultTotal, instant = false, autoZoom = false } = {}) {
  const dom = new JSDOM(`<!doctype html><main>
    <button aria-label="Database: demo">demo</button><h2 title="DemoStage1">DemoStage1</h2>
    <div id="search"><span id="chips"></span><label><input data-testid="search-input" aria-label="search input"></label>
    <span id="actions"></span></div>
    <div role="img" aria-label="Graph visualization"></div><button data-testid="card-panel-expand"></button><button aria-label="Fit all nodes">Fit</button>
  </main>`, { url: 'https://console.neo4j.io/projects/test/studio/bloom', pretendToBeVisual: true });
  const win = dom.window, doc = win.document;
  let listener;
  win.chrome = { runtime: { id: 'demo-extension', onMessage: {
    addListener(fn) { listener = fn; }, removeListener(fn) { if (listener === fn) listener = null; }
  } } };
  const message = type => new Promise(resolve => listener({type}, {id:'demo-extension'}, resolve));
  const queries = [], uiEvents = [];
  let fits = 0;
  const counter = doc.querySelector('[data-testid="card-panel-expand"]');
  const actions = doc.getElementById('actions');
  const chips = doc.getElementById('chips');
  function setTotal(n) { counter.textContent = `Card list (0/${n})`; }
  function currentInput() { return doc.querySelector('input[data-testid="search-input"]'); }
  function newButton(label, action, testid) {
    const el = doc.createElement('button'); el.setAttribute('aria-label', label);
    if (testid) el.dataset.testid = testid;
    el.addEventListener('click', action); actions.append(el); return el;
  }
  function renderActions(withRun = true) {
    actions.replaceChildren();
    if (chips.textContent || currentInput().value) newButton('Clear input', () => {
      uiEvents.push('clear');
      win.setTimeout(() => {
        chips.textContent = '';
        // Mimic React replacing the input while clearing a tokenized query.
        const fresh = currentInput().cloneNode(); currentInput().replaceWith(fresh);
        fresh.value = ''; bindInput(fresh); actions.replaceChildren();
      }, clearDelay);
    }, 'search-clear-button');
    if (withRun) newButton('Run Query', () => {
      const q = currentInput().value;
      queries.push(q); uiEvents.push('run');
      chips.textContent = q;
      currentInput().value = '';
      if (instant) {
        setTotal(resultTotal ?? TOTALS[STEPS.findIndex(s => s.query === q)]);
        renderActions(); return;
      }
      actions.replaceChildren(); newButton('Cancel Query', () => {}, 'search-query-button');
      win.setTimeout(() => {
        if (!fail) setTotal(resultTotal ?? TOTALS[STEPS.findIndex(s => s.query === q)]);
        else { const alert = doc.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Search failed'; doc.body.append(alert); }
        renderActions();
        if (autoZoom) doc.querySelector('[aria-label="Reset zoom level"]').textContent = '1%';
      }, completeDelay);
    }, 'search-query-button');
  }
  function bindInput(el) {
    el.addEventListener('input', () => { uiEvents.push('input'); win.setTimeout(() => renderActions(), 2); });
  }
  bindInput(currentInput());
  if (autoZoom) {
    const controls = doc.createElement('div');
    controls.innerHTML = '<button aria-label="Reset zoom level">80%</button><button aria-label="Zoom out">Out</button><button aria-label="Zoom in">In</button>';
    doc.querySelector('main').append(controls);
    const reset = controls.firstChild;
    reset.onclick = () => { reset.textContent = '100%'; };
    controls.children[1].onmousedown = () => { reset.textContent = `${parseInt(reset.textContent) - 10}%`; };
    controls.children[2].onmousedown = () => { reset.textContent = `${parseInt(reset.textContent) + 10}%`; };
  }
  chips.textContent = query; setTotal(total); if (query) renderActions();
  doc.querySelector('[aria-label="Fit all nodes"]').addEventListener('click', () => fits++);
  doc.querySelector('[aria-label="Graph visualization"]').addEventListener('contextmenu', () => {
    const item = doc.createElement('button'); item.setAttribute('role', 'menuitem');
    item.innerHTML = '<span>Clear Scene</span><span>Ctrl ⌫</span>';
    item.addEventListener('click', () => { uiEvents.push('clear-scene'); setTotal(0); item.remove(); });
    doc.body.append(item);
  });
  const controller = createBloomNext(win, { initial, poll: 3, debounce: 10, settle: 5, ready: 100, result: 160 });
  t.after(() => { controller.destroy(); win.close(); });

  return { win, doc, controller, queries, uiEvents, setTotal, message, fits: () => fits };
}

async function idle(f) {
  for (let i=0;i<150;i++) {
    if (!f.controller.view().disabled && f.controller.state().stage === 0) return;
    await pause(3);
  }
  assert.fail('automatic scene preparation did not finish');
}

test('startup preserves saved scene, search and the single next button', async t => {
  const f=fixture(t,{total:317,query:STEPS[2].query});await pause(40);
  assert.equal(f.controller.state().count,317);
  assert.equal(f.controller.state().stage,null);
  assert.equal(f.doc.getElementById('coldkode-bloom-next'),null);

  assert.equal(f.doc.getElementById('chips').textContent,STEPS[2].query);
  assert.deepEqual(f.uiEvents,[]);
});

function clearInBloom(f) {
  f.doc.querySelector('[aria-label="Graph visualization"]').dispatchEvent(new f.win.MouseEvent('contextmenu',{bubbles:true}));
  f.doc.querySelector('[role="menuitem"]').click();
}

test('native Bloom clear resets the cursor and three clicks reveal the stages', async t => {
  const f=fixture(t,{total:317,query:STEPS[2].query});clearInBloom(f);await idle(f);
  for(let i=0;i<3;i++) {await f.controller.next();assert.equal(f.controller.state().stage,i+1);}
  assert.deepEqual(f.queries,STEPS.map(s=>s.query));
  assert.equal(f.controller.view().disabled,true);
  clearInBloom(f);await idle(f);await f.controller.next();
  assert.equal(f.controller.state().stage,1);
  assert.equal(f.queries[3],STEPS[0].query);
});

test('reinjection never clears a saved scene', async t => {
  const f=fixture(t);await idle(f);await f.controller.next();f.controller.destroy();
  const controller=createBloomNext(f.win,{poll:3,settle:5});t.after(()=>controller.destroy());
  await pause(40);assert.equal(controller.state().count,227);assert.equal(controller.state().stage,null);
  assert.equal(f.uiEvents.includes('clear-scene'),false);
});

test('late restored contents are preserved and cannot jump to stage three', async t => {
  const f=fixture(t);await idle(f);f.setTotal(317);await pause(40);
  assert.equal(f.controller.state().count,317);assert.equal(f.controller.state().stage,0);
  assert.equal(f.controller.view().disabled,true);
  assert.deepEqual(f.uiEvents,[]);
});

test('a temporary zero during loading does not reset the stage', async t => {
  const f=fixture(t);await idle(f);await f.controller.next();
  const status=f.doc.createElement('div');status.setAttribute('role','status');status.setAttribute('aria-label','Loading content');f.doc.body.append(status);
  f.setTotal(0);await pause(40);assert.equal(f.controller.state().stage,1);
  f.setTotal(227);status.remove();await pause(20);assert.equal(f.controller.state().stage,1);
});

test('double click submits only one search', async t => {
  const f=fixture(t,{completeDelay:25}); await idle(f);
  const pending=f.controller.next(); await f.controller.next(); await pending;
  assert.equal(f.queries.length,1);assert.equal(f.controller.state().stage,1);
});

test('failed search leaves the current stage and permits retry', async t => {
  const f=fixture(t,{fail:true});await idle(f);await f.controller.next();
  assert.equal(f.controller.state().stage,0);
  assert.match(f.controller.view().status,/Search failed/);
  assert.equal(f.controller.view().disabled,false);
});

test('arbitrary graph size and instant repeated results complete', async t => {
  const f=fixture(t,{instant:true,resultTotal:19});await idle(f);
  await f.controller.next();await f.controller.next();
  assert.equal(f.controller.state().stage,2);assert.equal(f.controller.state().count,19);
});

test('empty search result does not advance', async t => {
  const f=fixture(t,{resultTotal:0});await idle(f);await f.controller.next();
  assert.equal(f.controller.state().stage,0);
  assert.equal(f.controller.view().disabled,false);
});

test('Bloom zoom remains untouched after Next', async t => {
  const f=fixture(t,{autoZoom:true});await idle(f);await f.controller.next();
  assert.equal(f.doc.querySelector('[aria-label="Reset zoom level"]').textContent,'1%');
  assert.equal(f.fits(),0);
});

test('toolbar command returns immediately and search survives popup closing', async t => {
  const f=fixture(t,{completeDelay:25});await idle(f);
  const start=await f.message('bloom-next');
  assert.equal(start.disabled,true);
  assert.equal(start.stage,0);
  await f.message('bloom-next');
  await pause(90);
  const reopened=await f.message('bloom-state');
  assert.equal(reopened.stage,1);
  assert.equal(reopened.disabled,false);
  assert.equal(f.queries.length,1);
  assert.equal(f.doc.getElementById('coldkode-bloom-next'),null);
});

test('a scene change during search prevents submission', async t => {
  const f=fixture(t);await idle(f);const pending=f.controller.next();
  f.doc.querySelector('h2').textContent='Other';await pending;
  assert.deepEqual(f.queries,[]);
});

