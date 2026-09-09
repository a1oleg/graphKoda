const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createBloomNext, STEPS } = require('../content.js');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { total = 0, query = '', fail = false, clearDelay = 0, completeDelay = 8 } = {}) {
  const dom = new JSDOM(`<!doctype html><main>
    <button aria-label="Database: demo">demo</button><h2 title="DemoStage1">DemoStage1</h2>
    <div id="search"><span id="chips"></span><label><input data-testid="search-input" aria-label="search input"></label>
    <span id="actions"></span></div>
    <button data-testid="card-panel-expand"></button><button aria-label="Fit all nodes">Fit</button>
  </main>`, { url: 'https://console.neo4j.io/projects/test/studio/bloom', pretendToBeVisual: true });
  const win = dom.window, doc = win.document;
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
      actions.replaceChildren(); newButton('Cancel Query', () => {}, 'search-query-button');
      win.setTimeout(() => {
        if (!fail) setTotal(STEPS.find(s => s.query === q)?.total ?? 99);
        renderActions();
      }, completeDelay);
    }, 'search-query-button');
  }
  function bindInput(el) {
    el.addEventListener('input', () => { uiEvents.push('input'); win.setTimeout(() => renderActions(), 2); });
  }
  bindInput(currentInput());
  chips.textContent = query; setTotal(total); if (query) renderActions();
  doc.querySelector('[aria-label="Fit all nodes"]').addEventListener('click', () => fits++);
  const controller = createBloomNext(win, { poll: 3, debounce: 10, settle: 5, ready: 100, result: 160 });
  t.after(() => { controller.destroy(); win.close(); });
  const shadow = doc.getElementById('coldkode-bloom-next').shadowRoot;
  return { win, doc, controller, queries, uiEvents, setTotal, shadow, fits: () => fits };
}

test('empty scene: three Next actions accumulate the exact graph patterns', async t => {
  const f = fixture(t);
  for (let index = 0; index < 3; index++) {
    assert.equal(f.controller.state().stage, index);
    await f.controller.next();
    assert.equal(f.controller.state().stage, index + 1);
    assert.equal(f.controller.state().count, STEPS[index].total);
  }
  assert.deepEqual(f.queries, STEPS.map(s => s.query));
  assert.equal(f.fits(), 3);
  assert.equal(f.shadow.getElementById('next').disabled, true);
  assert.match(f.shadow.getElementById('status').textContent, /Для повтора/);
  await f.controller.next();
  assert.equal(f.queries.length, 3);
});

test('existing DemoStage1 starts at step 2, including asynchronous input replacement', async t => {
  const f = fixture(t, { total: 7, query: STEPS[0].query, clearDelay: 12 });
  assert.equal(f.controller.state().stage, 1);
  await f.controller.next();
  assert.deepEqual(f.queries, [STEPS[1].query]);
  assert.deepEqual(f.uiEvents, ['clear', 'input', 'run']);
  assert.equal(f.controller.state().stage, 2);
});

test('double Next cannot submit the same transition twice', async t => {
  const f = fixture(t, { total: 7, query: STEPS[0].query, completeDelay: 25 });
  const first = f.controller.next();
  assert.equal(f.shadow.getElementById('next').disabled, true);
  await f.controller.next(); await first;
  assert.equal(f.queries.length, 1);
});

test('query failure keeps step 1 and reports the failure without fitting', async t => {
  const f = fixture(t, { total: 7, query: STEPS[0].query, fail: true });
  await f.controller.next();
  assert.equal(f.controller.state().stage, 1);
  assert.match(f.shadow.getElementById('status').textContent, /Ожидаемый результат не появился/);
  assert.equal(f.fits(), 0);
  assert.equal(f.shadow.getElementById('next').disabled, false);
});

test('scene switch during preparation prevents query submission', async t => {
  const f = fixture(t, { total: 7, query: STEPS[0].query });
  const pending = f.controller.next();
  await pause(5); f.doc.querySelector('h2').textContent = 'Different scene';
  await pending;
  assert.equal(f.queries.length, 0);
  assert.equal(f.fits(), 0);
});

test('an unrelated query with matching counts does not enable Next', async t => {
  const f = fixture(t, { total: 7, query: 'Person KNOWS Person' });
  assert.equal(f.controller.state().stage, null);
  await f.controller.next(); assert.equal(f.queries.length, 0);
  assert.equal(f.shadow.getElementById('next').disabled, true);
});

test('unexpected extra nodes are not silently treated as a demo stage', async t => {
  const f = fixture(t, { total: 32, query: STEPS[2].query });
  assert.equal(f.controller.state().stage, null);
  await f.controller.next(); assert.equal(f.queries.length, 0);
});

test('expanded card list is supported', t => {
  const f = fixture(t, { total: 30, query: STEPS[1].query });
  f.doc.querySelector('[data-testid="card-panel-expand"]').remove();
  const dialog = f.doc.createElement('div'); dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<button role="tab">All (30)</button><button role="tab">Selected (2)</button>';
  f.doc.querySelector('main').append(dialog);
  assert.equal(f.controller.state().stage, 2);
});

test('Fit can be disabled and completion can be recovered on re-injection', async t => {
  const f = fixture(t, { total: 30, query: STEPS[1].query });
  f.shadow.getElementById('fit').checked = false;
  await f.controller.next();
  assert.equal(f.fits(), 0);
  f.controller.destroy();
  const second = createBloomNext(f.win);
  try { assert.equal(second.state().stage, 3); } finally { second.destroy(); }
});

test('partial first-stage node search is completed by the first Next', async t => {
  const f = fixture(t, { total: 4, query: 'DemoStage1' });
  await f.controller.next();
  assert.deepEqual(f.queries, [STEPS[0].query]);
  assert.equal(f.controller.state().stage, 1);
});

test('navigation away from Bloom stops actions', async t => {
  const f = fixture(t, { total: 7, query: STEPS[0].query });
  const pending = f.controller.next();
  f.win.history.pushState({}, '', '/projects/test/instances');
  await pending;
  assert.equal(f.queries.length, 0);
  assert.equal(f.doc.getElementById('coldkode-bloom-next').hidden, true);
});

test('repeated injection does not duplicate the panel', t => {
  const f = fixture(t);
  assert.equal(createBloomNext(f.win), null);
  assert.equal(f.doc.querySelectorAll('#coldkode-bloom-next').length, 1);
});

test('zero stage is explicit even when the empty scene has an arbitrary name', t => {
  const f = fixture(t);
  f.doc.querySelector('h2').textContent = 'Untitled Scene';
  assert.equal(f.controller.state().stage, 0);
  assert.equal(f.shadow.getElementById('step').textContent, '0 / 3');
  assert.match(f.shadow.getElementById('status').textContent, /этап 0/);
  assert.equal(f.shadow.getElementById('next').disabled, false);
});

test('saved DemoStage1 with no restored search starts at the second step', async t => {
  const f = fixture(t, { total: 7 });
  assert.equal(f.controller.state().stage, 1);
  await f.controller.next();
  assert.deepEqual(f.queries, [STEPS[1].query]);
});

test('saved named demo copies recognize the accumulated stage without search chips', t => {
  const f = fixture(t, { total: 30 });
  f.doc.querySelector('h2').textContent = 'DemoStage1 (Copy)';
  assert.equal(f.controller.state().stage, 2);
  f.setTotal(31);
  assert.equal(f.controller.state().stage, 3);
});

test('an unrelated saved populated scene is not zero or an inferred demo', t => {
  const f = fixture(t, { total: 7 });
  f.doc.querySelector('h2').textContent = 'Customers';
  assert.equal(f.controller.state().stage, null);
});

test('clearing the graph returns to stage zero even with previous stage-three search chips', t => {
  const f = fixture(t, { total: 31, query: STEPS[2].query });
  f.setTotal(0);
  assert.equal(f.controller.state().stage, 0);
});
