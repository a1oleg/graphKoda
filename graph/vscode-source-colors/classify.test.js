// Regression on actual project code, not invented snippets.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {classify}=require('./classify');
test('Fisher function/loop delimiters; nested object remains independent',()=>{
  const file=path.resolve(__dirname,'../../examples/fisher-yates/src/shuffle.ts');
  const text=fs.readFileSync(file,'utf8');
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const marks=classify(ts,file,text);
  let functions=0,loops=0,objects=0;
  const roleAt=n=>marks.find(m=>m.start===n.getStart(source)&&m.end===n.end)?.role;
  function delimiters(n,kinds,role) {
    for(const child of n.getChildren(source)) if(kinds.includes(child.kind))assert.equal(roleAt(child),role,child.getText(source));
  }
  function visit(n){
    if(ts.isFunctionDeclaration(n)){
      functions++;
      delimiters(n,[ts.SyntaxKind.OpenParenToken,ts.SyntaxKind.CloseParenToken],'call');
      delimiters(n.body,[ts.SyntaxKind.OpenBraceToken,ts.SyntaxKind.CloseBraceToken],'call');
    }
    if(ts.isForStatement(n)){
      loops++;
      delimiters(n,[ts.SyntaxKind.OpenParenToken,ts.SyntaxKind.CloseParenToken],'system');
      delimiters(n.statement,[ts.SyntaxKind.OpenBraceToken,ts.SyntaxKind.CloseBraceToken],'system');
    }
    if(ts.isObjectLiteralExpression(n)||ts.isTypeLiteralNode(n)){
      objects++;
      delimiters(n,[ts.SyntaxKind.OpenBraceToken,ts.SyntaxKind.CloseBraceToken],undefined);
    }
    ts.forEachChild(n,visit);
  }
  visit(source);assert(functions>=3&&loops>=1&&objects>=2);
});
