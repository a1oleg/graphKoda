// Owned integrated terminal; no external windows, shell, or arbitrary commands.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function createPresentationTerminal({ vscode, workspaceRoot, presentationWindow, resolveNode }) {
  let session = null;
  const subscription = vscode.window.onDidCloseTerminal(terminal => {
    if (session?.terminal === terminal) session.closed = true;
  });
  function state() {
    if (!session) return { stage: 'absent' };
    const exit = session.terminal.exitStatus;
    return { sessionId: session.id, stage: session.closed || exit ? 'exited' : 'running',
      exitCode: exit?.code ?? null, submitted: session.submitted,
      // Running is a lifecycle state, NOT proof of application readiness or reply.
      readiness: 'unknown', outputAvailable: false };
  }
  async function step(input) {
    if (!presentationWindow) throw Error('Terminal API requires the presentation window');
    if (!['start', 'read', 'input', 'stop'].includes(input.action)) throw Error('Unsupported terminal action');
    if (input.action === 'read') return state();
    if (input.action === 'start') {
      if (state().stage === 'running') throw Error('Presentation terminal is already running');
      const script = path.join(workspaceRoot, 'dev', 'runOriginalClaudeCodeWithNodeLogging.mjs');
      if (!fs.existsSync(script)) throw Error('Original Claude launcher is missing');
      const node = resolveNode ? resolveNode() : execFileSync('where.exe', ['node.exe'],
        { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
      if (!path.isAbsolute(node) || !fs.existsSync(node)) throw Error('Node executable is unavailable');
      // Run the package script's Node entry point directly. When it exits, there
      // is no shell left behind that could interpret later user input as code.
      const terminal = vscode.window.createTerminal({ name: 'Claude Code — presentation',
        cwd: workspaceRoot, shellPath: node, shellArgs: [script],
        env: { CLAUDE_CODE_MODEL_STUB: '1', MODEL_STUB_REPLY: 'заглушка',
          GRAPH_NODE_LOGGING: '1', RUNTIME_RELAY_URL: 'http://127.0.0.1:8787/graph-relay' } });
      session = { id: randomUUID(), terminal, submitted: 0, closed: false };
      terminal.show(false);
      return state();
    }
    if (!session || input.sessionId !== session.id) throw Error('Matching terminal sessionId is required');
    if (input.action === 'stop') {
      if (state().stage === 'running') session.terminal.dispose();
      session.closed = true;
      return state();
    }
    if (state().stage !== 'running') throw Error('Presentation application has exited');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000
        || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(input.text)) {
      throw Error('Input must be one nonempty line, at most 4000 characters, without control characters');
    }
    session.terminal.sendText(input.text, true);
    session.submitted++;
    return { ...state(), stage: 'input-sent' };
  }
  return { step, dispose() { subscription.dispose(); session?.terminal.dispose(); } };
}
module.exports = { createPresentationTerminal };
