// Regression on actual project code, not invented snippets.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {classify}=require('./classify');
test('Fisher undefined types and intrinsic value are all system-colored',()=>{
  const file=path.resolve(__dirname,'../../examples/fisher-yates/src/shuffle.ts');
  const text=fs.readFileSync(file,'utf8');
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const marks=classify(ts,file,text);
  let types=0,values=0;
  function visit(node){
    if(node.kind===ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(node)&&node.text==='undefined')){
      const mark=marks.find(m=>m.start===node.getStart(source)&&m.end===node.end);
      assert.equal(mark?.role,'system',`undefined at ${node.getStart(source)}`);
      if(node.kind===ts.SyntaxKind.UndefinedKeyword)types++;else values++;
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  assert(types>=2&&values>=1,'Exercise both type and value syntax in actual Fisher code');
});
test('color ranges use the editor buffer despite normalized paths and different line endings',()=>{
  const os=require('node:os');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-colors-'));
  try {
    const file=path.join(directory,'sample.ts');
    fs.writeFileSync(file,'// disk\r\nfunction run() { return false; }\r\n');
    const buffer='// unsaved editor text\n\nfunction run() { return true; }\n';
    const marks=classify(ts,file,buffer);
    assert(marks.length>0);
    for(const mark of marks)assert.equal(buffer.slice(mark.start,mark.end),mark.text);
    assert(marks.some(mark=>mark.role==='true'&&mark.text==='true'));
    assert(!marks.some(mark=>mark.role==='false'));
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
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
