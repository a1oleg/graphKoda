const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPresentationTerminal } = require('./presentationTerminal');
function fixture(presentationWindow = true) {
  let close, options;
  const sent = [];
  const terminal = { show() {}, sendText(text, enter) { sent.push([text, enter]); },
    dispose() { close(terminal); } };
  const api = createPresentationTerminal({ presentationWindow,
    workspaceRoot: path.resolve(__dirname, '../..'), resolveNode: () => process.execPath,
    vscode: { window: { onDidCloseTerminal(fn) { close = fn; return { dispose() {} }; },
      createTerminal(value) { options = value; return terminal; } } } });
  return { api, terminal, sent, options: () => options };
}
test('owned VS Code terminal runs only the fixed launcher, accepts prompt and stops', async () => {
  const f = fixture();
  assert.equal((await f.api.step({ action: 'read' })).stage, 'absent');
  const s = await f.api.step({ action: 'start', command: 'ignored' });
  assert.equal(f.options().shellPath, process.execPath);
  assert.match(f.options().shellArgs[0], /runOriginalClaudeCodeWithNodeLogging.mjs$/);
  assert.equal(f.options().env.CLAUDE_CODE_MODEL_STUB, '1');
  assert.equal(s.readiness, 'unknown');
  await assert.rejects(f.api.step({ action: 'start' }), /already running/);
  await assert.rejects(f.api.step({ action: 'input', text: 'привет' }), /sessionId/);
  for (const text of ['x\ny', '\x03', '\x1b[200~', '', 'x'.repeat(4001)]) {
    await assert.rejects(f.api.step({ action: 'input', sessionId: s.sessionId, text }), /Input/);
  }
  await f.api.step({ action: 'input', sessionId: s.sessionId, text: 'привет' });
  assert.deepEqual(f.sent, [['привет', true]]);
  await f.api.step({ action: 'stop', sessionId: s.sessionId });
  await assert.rejects(f.api.step({ action: 'input', sessionId: s.sessionId, text: 'привет' }), /exited/);
  f.api.dispose();
});
test('main window and arbitrary actions are rejected; exitStatus blocks input', async () => {
  const main = fixture(false);
  await assert.rejects(main.api.step({ action: 'start' }), /presentation window/);
  main.api.dispose();
  const f = fixture();
  await assert.rejects(f.api.step({ action: 'exec' }), /Unsupported/);
  const s = await f.api.step({ action: 'start' });
  f.terminal.exitStatus = { code: 1 };
  await assert.rejects(f.api.step({ action: 'input', sessionId: s.sessionId, text: 'привет' }), /exited/);
  assert.equal((await f.api.step({ action: 'read' })).exitCode, 1);
  f.api.dispose();
});
