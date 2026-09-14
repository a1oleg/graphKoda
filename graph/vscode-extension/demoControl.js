// Local, opt-in-by-token UI automation. No eval, arbitrary selectors or VS Code commands.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function createDemoControl({ workspaceRoot, runtimeSend, runtimeState }) {
  const token = crypto.randomBytes(32).toString('hex');
  const pending = new Map();
  const tokenFile = path.join(workspaceRoot, 'tmp', 'graph-demo-token.local');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const allowed = { diagram: ['contextMenu', 'menuClick', 'dismissMenu'], runtime: ['waitForAnalysis', 'selectCase', 'selectSegment', 'selectAll'] };
  function finish(id, reply) {
    const job = pending.get(id);
    if (!job) return false;
    pending.delete(id); clearTimeout(job.timer);
    if (reply.error) job.reject(new Error(reply.error)); else job.resolve(reply.result || {});
    return true;
  }
  async function step(input) {
    input = Object.fromEntries(['surface', 'action', 'functionStableId', 'sessionId', 'cellId', 'stableId', 'label', 'index', 'id']
      .filter(key => input && Object.prototype.hasOwnProperty.call(input, key)).map(key => [key, input[key]]));
    if (!input || !allowed[input.surface]?.includes(input.action)) throw new Error('Unsupported demo surface/action');
    if (typeof input.functionStableId !== 'string' || !input.functionStableId) throw new Error('functionStableId is required');
    if (pending.size) throw new Error('A demo action is already pending; await it before sending the next');
    if (input.surface === 'runtime' && input.action === 'waitForAnalysis') {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = runtimeState();
        if (state?.analysis && state.functionStableId === input.functionStableId
          && (!input.sessionId || state.analysis.sessionId === input.sessionId)) {
          return { stage: 'analysis-loaded', sessionId: state.analysis.sessionId,
            cases: (state.analysis.cases || state.analysis.iterations || []).map(c => ({ index: c.index, transition: c.transition })),
            segments: (state.analysis.segments || []).map(s => ({ id: s.id })) };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Matching runtime analysis did not load');
    }
    if (input.action === 'contextMenu' && !input.cellId && !input.stableId) throw new Error('cellId or stableId is required');
    if (input.action === 'menuClick' && (typeof input.label !== 'string' || !input.label)) throw new Error('Exact menu label is required');
    if (input.action === 'selectCase' && (!Number.isInteger(input.index) || input.index < 0)) throw new Error('Nonnegative case index is required');
    if (input.action === 'selectSegment' && typeof input.id !== 'string') throw new Error('Segment id is required');
    if (input.surface === 'runtime') {
      const state = runtimeState();
      if (!state?.analysis || state.functionStableId !== input.functionStableId) throw new Error('Open matching runtime analysis first');
      if (input.sessionId && state.analysis.sessionId !== input.sessionId) throw new Error('Runtime session mismatch');
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(id, { error: 'Demo action timed out: matching UI is not ready' }), 15000);
      const job = { id, input, resolve, reject, timer, claimed: false };
      pending.set(id, job);
      if (input.surface === 'runtime') {
        job.claimed = true;
        Promise.resolve(runtimeSend({ type: 'demoAction', requestId: id, ...input }))
          .then(sent => { if (!sent) finish(id, { error: 'Runtime panel is unavailable' }); })
          .catch(error => finish(id, { error: error.message }));
      }
    });
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/demo/')) return false;
    const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
    if (request.method === 'GET' && url.pathname === '/demo/next') {
      const job = [...pending.values()].find(j => j.input.surface === 'diagram' && !j.claimed && j.input.functionStableId === url.searchParams.get('functionStableId'));
      if (job) job.claimed = true;
      json(200, { command: job ? { requestId: job.id, ...job.input } : null }); return true;
    }
    if (request.method !== 'POST' || !['/demo/step', '/demo/ack'].includes(url.pathname)) { json(404, { error: 'Unknown demo route' }); return true; }
    if (url.pathname === '/demo/step' && request.headers.authorization !== `Bearer ${token}`) { json(401, { error: 'Demo token required' }); return true; }
    let body = '';
    try {
      for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error('Demo payload too large'); }
      const data = JSON.parse(body);
      if (url.pathname === '/demo/ack') json(200, { accepted: finish(data.requestId, data) });
      else json(200, await step(data));
    } catch (error) { json(400, { error: error.message }); }
    return true;
  }
  return { step, finish, handle, dispose() {
    for (const id of [...pending.keys()]) finish(id, { error: 'Extension stopped' });
    try { if (fs.readFileSync(tokenFile, 'utf8') === token) fs.unlinkSync(tokenFile); } catch {}
  } };
}
module.exports = { createDemoControl };
