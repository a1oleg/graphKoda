/* The content script owns the operation, so closing this popup cannot cancel it. */
(() => {
  const ui = Object.fromEntries(['step', 'title', 'status', 'next'].map(id => [id, document.getElementById(id)]));
  let tabId, pending = false, polling = false;
  function render(state) {
    if (!state?.isBloom) throw new Error('Откройте вкладку Bloom и нажмите значок расширения.');
    ui.step.textContent = state.step;
    ui.title.textContent = state.title;
    ui.status.textContent = state.status;
    ui.status.classList.toggle('error', state.error);
    ui.next.disabled = pending || state.disabled;
  }
  function failure(error) {
    ui.next.disabled = true;
    ui.title.textContent = 'Bloom недоступен';
    ui.status.textContent = error.message === 'Откройте вкладку Bloom и нажмите значок расширения.'
      ? error.message : 'Откройте Bloom. После обновления расширения перезагрузите вкладку Bloom.';
    ui.status.classList.add('error');
  }
  async function refresh() {
    if (pending || polling || tabId === undefined) return;
    polling = true;
    try { render(await chrome.tabs.sendMessage(tabId, { type: 'bloom-state' })); }
    catch (error) { failure(error); }
    finally { polling = false; }
  }
  ui.next.addEventListener('click', async () => {
    if (pending || ui.next.disabled || tabId === undefined) return;
    pending = true;
    ui.next.disabled = true;
    try {
      const state = await chrome.tabs.sendMessage(tabId, { type: 'bloom-next' });
      pending = false;
      render(state);
    } catch (error) { failure(error); }
    finally { pending = false; }
  });
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    tabId = tabs[0]?.id;
    if (tabId === undefined) throw new Error('No active tab');
    return refresh();
  }).catch(failure);
  const timer = setInterval(refresh, 250);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
