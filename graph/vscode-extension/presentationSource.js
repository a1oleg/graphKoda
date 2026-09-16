// Source identity stays semantic; placement is presentation-only metadata.
const fs = require('node:fs');
const path = require('node:path');

function resolvePresentationSource(stableId, roots) {
  const match = /^(.+):(\d+):(\d+):(\d+):(\d+)$/.exec(String(stableId));
  if (!match || path.isAbsolute(match[1]) || match[1].split(/[\\/]/).includes('..')) throw Error('Expected source stableId with a relative path');
  const [, relativePath, sl, sc, el, ec] = match;
  const location = { startLine: +sl, startColumn: +sc, endLine: +el, endColumn: +ec };
  if (+sl < 1 || +el < +sl || (+el === +sl && +ec < +sc)) throw Error('Invalid source range');
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const base = fs.realpathSync(root), file = path.resolve(base, relativePath);
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    if (!real.toLowerCase().startsWith((base + path.sep).toLowerCase())) throw Error('Source outside allowed roots');
    if (!candidates.some(p => p.toLowerCase() === real.toLowerCase())) candidates.push(real);
  }
  if (candidates.length !== 1) throw Error('Missing or ambiguous source file: ' + relativePath);
  return { file: candidates[0], ...location };
}

function createPresentationSourceOpener({ vscode, roots, openDiagram }) {
  const panels = new Map();
  return async ({ stableId, placement, diagramFile }) => {
    if (!['RIGHT', 'BELOW'].includes(placement)) throw Error('Choose RIGHT or BELOW');
    const target = resolvePresentationSource(stableId, roots);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
    if (target.endLine > document.lineCount || target.startColumn > document.lineAt(target.startLine - 1).text.length || target.endColumn > document.lineAt(target.endLine - 1).text.length) throw Error('Source range is stale');
    const command = placement === 'RIGHT' ? 'workbench.action.newGroupRight' : 'workbench.action.newGroupBelow';
    if (!(await vscode.commands.getCommands(true)).includes(command)) throw Error('Editor split command unavailable: ' + command);
    await openDiagram(diagramFile);
    const anchor = vscode.window.tabGroups.activeTabGroup;
    const key = diagramFile + ':' + placement;
    let group = panels.get(key);
    if (!group || !vscode.window.tabGroups.all.includes(group) || group === anchor) {
      await vscode.commands.executeCommand(command);
      group = vscode.window.tabGroups.activeTabGroup;
      if (group === anchor) throw Error('Editor split did not create a group');
      panels.set(key, group);
    }
    const start = new vscode.Position(target.startLine - 1, target.startColumn);
    const end = new vscode.Position(target.endLine - 1, target.endColumn);
    const range = new vscode.Range(start, end);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: group.viewColumn, preview: false, preserveFocus: false });
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    return { stage: 'source-opened', stableId, placement, file: target.file, viewColumn: editor.viewColumn, range: target };
  };
}
module.exports = { resolvePresentationSource, createPresentationSourceOpener };
