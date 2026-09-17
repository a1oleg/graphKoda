const vscode = require('vscode');
const path = require('node:path');
const {classify} = require('./classify');
const palette = {call:'#569CD6',system:'#C586C0',systemRoot:'#C586C0',systemMember:'#D7B5D8',valueRoot:'#CE9178',valueMember:'#E5BFAE'};
function activate(context) {
  const types = Object.fromEntries(Object.entries(palette).map(([role,color])=>[role,vscode.window.createTextEditorDecorationType({color})]));
  const output = vscode.window.createOutputChannel('coldKode Source Colors');
  context.subscriptions.push(output,...Object.values(types));
  const cache = new Map(); let timer;
  function update() {
    if (!vscode.workspace.getConfiguration('coldKode').get('sourceColors.enabled',false)) {
      for(const e of vscode.window.visibleTextEditors) for(const t of Object.values(types)) e.setDecorations(t,[]);
      return;
    }
    let ts;
    for(const root of vscode.workspace.workspaceFolders||[]) {
      try { ts=require(require.resolve('typescript',{paths:[root.uri.fsPath]})); break; } catch {}
    }
    if(!ts) {output.appendLine('TypeScript compiler not found in workspace; semantic overlays skipped.');return;}
    for(const editor of vscode.window.visibleTextEditors) {
      const doc=editor.document;
      if(doc.uri.scheme!=='file'||!['typescript','typescriptreact','javascript','javascriptreact'].includes(doc.languageId))continue;
      const key=doc.uri.toString(); let entry=cache.get(key);
      try {
        if(!entry||entry.version!==doc.version) {
          entry={version:doc.version,marks:classify(ts,doc.fileName,doc.getText())};cache.set(key,entry);
          output.appendLine(`${doc.fileName}: ${entry.marks.length} semantic color ranges`);
        }
        for(const [role,type] of Object.entries(types)) editor.setDecorations(type,entry.marks.filter(m=>m.role===role).map(m=>new vscode.Range(doc.positionAt(m.start),doc.positionAt(m.end))));
      } catch(error) {
        for(const type of Object.values(types))editor.setDecorations(type,[]);
        output.appendLine(String(error));
      }
    }
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(update,250);}
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(schedule),vscode.workspace.onDidChangeTextDocument(schedule),vscode.workspace.onDidChangeConfiguration(schedule),vscode.workspace.onDidCloseTextDocument(d=>cache.delete(d.uri.toString())),{dispose(){clearTimeout(timer);cache.clear();}});
  schedule();
}
module.exports={activate};
