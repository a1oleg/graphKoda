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
  let currentEditor, currentStableId, currentPlacement, scrollTimer;
  const sourceHeadroomLines = 5;
  const pointer = vscode.window.createTextEditorDecorationType({
    after: { contentIconPath: vscode.Uri.file(path.join(__dirname, 'media', 'presentation-code-pointer.svg')), width: '44px', height: '30px', margin: '0 4px' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const open = async ({ stableId, endStableId, editorAreaHeight, placement, diagramFile, previousStableId }) => {
    clearTimeout(scrollTimer);
    if (!['RIGHT', 'BELOW'].includes(placement)) throw Error('Choose RIGHT or BELOW');
    const target = resolvePresentationSource(stableId, roots);
    const last = endStableId ? resolvePresentationSource(endStableId, roots) : null;
    if(last && (last.file.toLowerCase()!==target.file.toLowerCase() || last.endLine<target.startLine))throw Error('Invalid end-of-code boundary');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
    if (target.endLine > document.lineCount || target.startColumn > document.lineAt(target.startLine - 1).text.length || target.endColumn > document.lineAt(target.endLine - 1).text.length) throw Error('Source range is stale');
    if (previousStableId) {
      if (currentStableId !== previousStableId || currentPlacement !== placement || !currentEditor || !vscode.window.visibleTextEditors.includes(currentEditor) || currentEditor.document.uri.toString() !== document.uri.toString()) throw Error('Previous source scene must be restored before continuing');
      const range = new vscode.Range(target.startLine-1,target.startColumn,target.endLine-1,target.endColumn);
      const alreadyVisible=currentEditor.visibleRanges.some(r=>r.contains(range));
      currentEditor.setDecorations(pointer, []);
      // Give code more headroom than the diagram's 32px top inset. Animate by
      // source lines, not screen pixels, while the diagram animates in parallel.
      const editor=currentEditor, from=editor.visibleRanges[0]?.start.line||0;
      const to=Math.max(0,target.startLine-1-sourceHeadroomLines), started=Date.now(), durationMs=1400;
      let lastLine=-1;
      const advance=()=>{
        if(!vscode.window.visibleTextEditors.includes(editor))return;
        const t=Math.min(1,(Date.now()-started)/durationMs), eased=t*t*(3-2*t);
        const line=Math.round(from+(to-from)*eased);
        if(line!==lastLine){editor.revealRange(new vscode.Range(line,0,line,0),vscode.TextEditorRevealType.AtTop);lastLine=line;}
        if(t<1)scrollTimer=setTimeout(advance,40);
      };
      advance();
      currentStableId=stableId;
      return {stage:'source-continued',stableId,previousStableId,placement,file:target.file,viewColumn:currentEditor.viewColumn,range:target,previouslyVisible:alreadyVisible,scrollRequested:true,reveal:'top-with-headroom',headroomLines:sourceHeadroomLines,durationMs};
    }
    const command = placement === 'RIGHT' ? 'workbench.action.newGroupRight' : 'workbench.action.newGroupBelow';
    if (!(await vscode.commands.getCommands(true)).includes(command)) throw Error('Editor split command unavailable: ' + command);
    await openDiagram(diagramFile);
    const dedicated = vscode.workspace.getConfiguration('coldKode').get('presentationWindow', false);
    let codeFraction=placement==='BELOW'?0.34:0.5, codeHeight=null;
    if(placement==='BELOW'&&last){
      if(!Number.isFinite(editorAreaHeight)||editorAreaHeight<200)throw Error('Measured editorAreaHeight required for bounded code pane');
      const config=vscode.workspace.getConfiguration('editor',document.uri);
      const configured=Number(config.get('lineHeight',0)),font=Number(config.get('fontSize',20));
      const lineHeight=configured===0?Math.round(font*1.4):configured<8?Math.round(font*configured):configured;
      // Visible source lines + tab/breadcrumb chrome + modest vertical breathing room.
      codeHeight=(last.endLine-target.startLine+1)*lineHeight+64;
      codeFraction=codeHeight/editorAreaHeight;
      if(codeFraction>0.7)throw Error('Requested code range leaves insufficient diagram space');
      codeFraction=Math.max(0.12,codeFraction);
    }
    if (dedicated) {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      // Re-running a scene must reuse the two zones, not accumulate new splits.
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: placement === 'BELOW' ? 1 : 0,
        groups: [{ size: 1-codeFraction }, { size: codeFraction }],
      });
    }
    const anchor = vscode.window.tabGroups.activeTabGroup;
    const key = diagramFile + ':' + placement;
    let group = dedicated ? vscode.window.tabGroups.all.find(g => g.viewColumn === vscode.ViewColumn.Two) : panels.get(key);
    if (!group || (!dedicated && (!vscode.window.tabGroups.all.includes(group) || group === anchor))) {
      await vscode.commands.executeCommand(command);
      group = vscode.window.tabGroups.activeTabGroup;
      if (group === anchor) throw Error('Editor split did not create a group');
      panels.set(key, group);
    }
    const start = new vscode.Position(target.startLine - 1, target.startColumn);
    const end = new vscode.Position(target.endLine - 1, target.endColumn);
    const range = new vscode.Range(start, end);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: group.viewColumn, preview: false, preserveFocus: false });
    currentEditor = editor;
    currentStableId = stableId; currentPlacement = placement;
    editor.selection = new vscode.Selection(start, start);
    // Layout restoration/smooth scrolling can overwrite an immediate reveal.
    // Wait for the new group to settle, then anchor the first line, not the
    // whole function range (which may exceed the narrow panel).
    await new Promise(resolve=>setTimeout(resolve,350));
    const firstLine=new vscode.Range(target.startLine-1,0,target.startLine-1,0);
    editor.revealRange(firstLine, vscode.TextEditorRevealType.AtTop);
    await new Promise(resolve=>setTimeout(resolve,350));
    editor.revealRange(firstLine, vscode.TextEditorRevealType.AtTop);
    await new Promise(resolve=>setTimeout(resolve,350));
    const visible=editor.visibleRanges;
    if(last&&!visible.some(r=>r.start.line<=target.startLine-1&&r.end.line>=last.endLine-1))throw Error('Requested code range is not fully visible after layout');
    return { stage: 'source-opened', stableId, endStableId, placement, file: target.file, viewColumn: editor.viewColumn, range: target, codeFraction, codeHeight, visibleRanges:visible.map(r=>({startLine:r.start.line+1,endLine:r.end.line+1})) };
  };
  // The code pointer uses the editor's own range layout, never screenshot coordinates.
  open.pointer = ({ stableId, visible = true }) => {
    if (!currentEditor || !vscode.window.visibleTextEditors.includes(currentEditor)) throw Error('Open the source pane first');
    if (!visible) { currentEditor.setDecorations(pointer, []); return { stage: 'source-pointer-hidden' }; }
    const target = resolvePresentationSource(stableId, roots);
    if (target.file.toLowerCase() !== currentEditor.document.uri.fsPath.toLowerCase()) throw Error('Pointer target is not in the open source pane');
    const document = currentEditor.document;
    if (target.endLine > document.lineCount || target.startColumn > document.lineAt(target.startLine - 1).text.length || target.endColumn > document.lineAt(target.endLine - 1).text.length) throw Error('Source pointer range is stale');
    const range = new vscode.Range(target.startLine - 1, target.startColumn, target.endLine - 1, target.endColumn);
    currentEditor.setDecorations(pointer, [range]);
    return { stage: 'source-pointer-moved', stableId, text: document.getText(range), viewColumn: currentEditor.viewColumn, visibleStartLine:(currentEditor.visibleRanges[0]?.start.line??0)+1, coordinateSource: 'VS Code source range' };
  };
  open.dispose = () => {clearTimeout(scrollTimer);pointer.dispose();};
  return open;
}
module.exports = { resolvePresentationSource, createPresentationSourceOpener };
