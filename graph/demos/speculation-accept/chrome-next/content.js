/* UI-only automation. No database driver, credentials, page internals or remote code. */
(() => {
  'use strict';
  const STEPS = Object.freeze([
    { query: 'DemoStage1 NEXT DemoStage1', title: 'Первая функция' },
    { query: 'DemoStage2 NEXT DemoStage2', title: 'Вторая функция' },
    { query: 'DemoStage1 VALUE_FROM DemoStage2', title: 'Связь с созданием объекта' }
  ]);

  function createBloomNext(win, overrides = {}) {
    const doc = win.document;
    const timing = { poll: 120, debounce: 700, settle: 450, ready: 12000, result: 130000, ...overrides };
    const hostId = 'coldkode-bloom-next';
    if (doc.getElementById(hostId)) return null;
    let busy = false, error = '', disposed = false, active = null, previousIdentity = '';
    let confirmed = null, emptySince = null;
    const host = doc.createElement('div');
    host.id = hostId;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; left: 232px; bottom: 84px; z-index: 9999;
          width: 290px; max-width: calc(100vw - 32px); color-scheme: dark;
          font: 14px/1.45 system-ui, sans-serif; color: #e9edf0; }
        :host([hidden]) { display: none; }
        * { box-sizing: border-box; }
        section { padding: 16px; background: #172125; border: 1px solid #38535c;
          border-radius: 14px; box-shadow: 0 8px 30px #0006; }
        header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        strong { font-size: 14px; letter-spacing: .03em; }
        #step { color: #69e5bd; font-variant-numeric: tabular-nums; }
        #title { margin-bottom: 4px; font-size: 17px; font-weight: 600; }
        #status { color: #b6c7cc; min-height: 40px; font-size: 12px; overflow-wrap: anywhere; }
        #status.error { color: #ffb7a9; }
        #next { width: 100%; margin: 12px 0 10px; padding: 10px 14px; border: 0;
          border-radius: 9px; background: #69e5bd; color: #102b23; font: 700 16px system-ui; cursor: pointer; }
        #next:hover:enabled { background: #97f3d3; }
        #next:disabled { background: #314d46; color: #93b0a6; cursor: default; }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        details { margin-top: 10px; color: #9bb3bc; font-size: 11px; }
        code { display: block; margin-top: 6px; white-space: normal; }
        @media (max-width: 700px) { :host { left: 16px; bottom: 84px; width: 260px; } }
      </style>
      <section aria-label="Bloom Demo Next">
        <header><strong title="Bloom Demo Next 1.0.11">BLOOM · DEMO · 1.0.11</strong><span id="step"></span></header>
        <div id="title"></div>
        <div id="status" role="status" aria-live="polite"></div>
        <button id="next" type="button">next</button>
        <details><summary>Что будет выполнено</summary><code id="query"></code></details>
      </section>`;
    (doc.body || doc.documentElement).append(host);
    const ui = Object.fromEntries(['step', 'title', 'status', 'next', 'query'].map(id => [id, shadow.getElementById(id)]));
    const input = () => doc.querySelector('input[data-testid="search-input"], input[aria-label="search input"]');
    const button = label => doc.querySelector(`button[aria-label="${label}"]`);
    const available = el => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
      !el.closest('[inert], [aria-hidden="true"]');
    const isBloom = () => /^\/projects\/[^/]+\/studio\/bloom\/?$/.test(win.location.pathname);
    function identity() {
      const title = doc.querySelector('main h2[title]');
      const database = doc.querySelector('button[aria-label^="Database:"]');
      return `${win.location.pathname}|${title?.textContent || ''}|${database?.textContent || ''}`;
    }
    function searchArea() {
      let el = input();
      while (el && el !== doc.body) {
        if (el.querySelector('[data-testid="search-query-button"], button[aria-label="Run Query"], button[aria-label="Cancel Query"]')) return el;
        el = el.parentElement;
      }
      return null;
    }
    function tokens() {
      return (searchArea()?.textContent.match(/DemoStage[12]|VALUE_FROM|NEXT/g) || []).join(' ');
    }
    function total() {
      const card = doc.querySelector('[data-testid="card-panel-expand"]');
      const match = card?.textContent.match(/\(\d+\/(\d+)\)/);
      if (match) return Number(match[1]);
      // The counter moves to a tab while Bloom's card list is expanded.
      for (const tab of doc.querySelectorAll('[role="dialog"] [role="tab"]')) {
        const all = tab.textContent.match(/^All \((\d+)\)$/);
        if (all) return Number(all[1]);
      }
      return null;
    }
    const loading = () => !!button('Cancel Query') || !!doc.querySelector('[role="status"][aria-label="Loading content"]');
    function state() {
      const currentIdentity = identity();
      if (currentIdentity !== previousIdentity) {
        error = '';
        previousIdentity = currentIdentity;
        confirmed = null;
        emptySince = null;
      }
      const count = total();
      // A confirmed empty scene establishes a playback cursor.
      // Restored contents, search chips and scene names never resume a demo.
      return { stage: confirmed?.stage ?? null, count,
        changed: !!confirmed && count !== confirmed.count,
        expectedCount: confirmed?.count ?? null };
    }

    function text(el, value) { if (el.textContent !== value) el.textContent = value; }
    function paint() {
      if (disposed) return;
      host.hidden = !isBloom() || !input();
      let snapshot = state();
      if (isBloom() && available(input()) && snapshot.count === 0 && !loading() &&
          (!busy || active?.previousCount > 0)) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= timing.settle && (snapshot.stage !== 0 || snapshot.changed)) {
          active = null;
          confirmed = { stage: 0, count: 0 };
          error = '';
          snapshot = state();
        }
      } else emptySince = null;
      const { stage, count, changed } = snapshot;
      const next = STEPS[stage];
      const finished = stage === 3;
      text(ui.step, stage === null ? '— / 3' : `${stage} / 3`);
      text(ui.title, stage === null ? 'Сцена сохранена' : busy ? 'Выполняется поиск…' : changed ? 'Содержимое сцены изменилось' : finished ? 'Все три этапа показаны' : stage === 0 ? 'Начало демонстрации' : next?.title || 'Подготовка…');
      text(ui.status, error || (busy ? 'Дождитесь результата Bloom.' : changed || finished || stage === null ? 'Для показа с нуля выберите Clear Scene в Bloom. Расширение само сцену не очищает.' : stage === 0 ? 'Пустая сцена · этап 0. Next покажет первую функцию.' : `${count} элементов в сцене. Next добавит следующий этап.`));
      ui.status.classList.toggle('error', !!error);
      text(ui.query, next?.query || 'Демонстрация: DemoStage1 → DemoStage2 → VALUE_FROM');
      text(ui.next, 'next');
      const ready = isBloom() && available(input()) && count !== null && !loading();
      ui.next.disabled = busy || !ready || finished || stage === null || changed;

    }
    const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
    function assertContext(context) {
      if (disposed || active !== context || identity() !== context.identity || !isBloom()) {
        throw new Error('Сцена изменилась. Откройте нужную сцену и нажмите Next снова.');
      }
    }
    async function waitFor(check, timeout, context, message) {
      const deadline = Date.now() + timeout;
      do {
        assertContext(context);
        if (check()) return;
        await sleep(timing.poll);
      } while (Date.now() < deadline);
      throw new Error(message);
    }
    function typeQuery(el, value) {
      // Use the native setter so React receives an actual input change.
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    async function next() {
      if (busy || ui.next.disabled) return;
      const before = state();
      if (before.stage === null) return;
      if (before.changed || loading()) { paint(); return; }
      const step = STEPS[before.stage];
      if (!step) return;
      const context = { identity: identity(), previousCount: before.count };
      active = context;
      busy = true;
      error = '';
      paint();
      try {
        const clear = button('Clear input');
        if (available(clear)) {
          clear.click();
          await waitFor(() => !button('Clear input') && input()?.value === '', timing.ready, context,
            'Не удалось очистить строку поиска Bloom.');
        }
        await waitFor(() => available(input()), timing.ready, context, 'Поле поиска Bloom недоступно.');
        const el = input();
        el.focus();
        typeQuery(el, step.query);
        await sleep(timing.debounce);
        await waitFor(() => input()?.value === step.query && available(button('Run Query')) && !loading(), timing.ready, context,
          'Bloom не подготовил поиск. Проверьте строку поиска и повторите Next.');
        assertContext(context);
        if (total() !== before.count) throw new Error('Содержимое сцены изменилось до запуска поиска. Повторите Next.');
        const notices = () => Array.from(doc.querySelectorAll('[role="alert"], [role="status"]'))
          .map(el => el.textContent.trim()).filter(Boolean);
        const previousNotices = new Set(notices());
        button('Run Query').click();
        let stableSince = null;
        let lastCount = null;
        await waitFor(() => {
          const failure = notices().find(message => !previousNotices.has(message) &&
            /error|failed|failure|no results|no matches|nothing found|ошиб|не найден/iu.test(message));
          if (failure) throw new Error(failure);
          const count = total();
          const correct = !loading() && available(button('Run Query')) &&
            tokens() === step.query && input()?.value === '' && count > 0;
          if (count !== lastCount) { stableSince = null; lastCount = count; }
          if (!correct) { stableSince = null; return false; }
          stableSince ??= Date.now();
          return Date.now() - stableSince >= timing.settle;
        }, timing.result, context, 'Ожидаемый результат не появился. Проверьте ошибку поиска в Bloom. Этап не переключён.');
        confirmed = { stage: before.stage + 1, count: total() };
      } catch (cause) {
        if (active === context) error = cause.message || 'Не удалось выполнить поиск.';
      } finally {
        busy = false;
        active = null;
        paint();
      }
    }
    ui.next.addEventListener('click', next);
    // Poll only the small visible UI contract. Also handles Aura SPA navigation,
    // scene switches, manually run queries, expanded card lists and reloads.
    const timer = win.setInterval(paint, timing.poll);
    paint();
    return { state, next, destroy() { disposed = true; active = null; win.clearInterval(timer); host.remove(); } };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createBloomNext, STEPS };
  else createBloomNext(window);
})();
