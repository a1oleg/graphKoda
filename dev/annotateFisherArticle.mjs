import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
const require=createRequire(import.meta.url),ts=require('typescript');
const {classify}=require('../graph/vscode-source-colors/classify.js');
const file=process.argv[2],sourceFile='C:/GitHub/coldKode/examples/fisher-yates/src/shuffle.ts';
const source=fs.readFileSync(sourceFile,'utf8').replaceAll('\r\n','\n');
const palette=vm.runInNewContext('('+fs.readFileSync('graph/vscode-source-colors/extension.js','utf8').match(/const palette = (\{[^\n]+\});/)[1]+')');
const colors=Array(source.length).fill('#D4D4D4'),scanner=ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.Standard,source);
for(let k=scanner.scan();k!==ts.SyntaxKind.EndOfFileToken;k=scanner.scan()){
 let color=k>=ts.SyntaxKind.FirstKeyword&&k<=ts.SyntaxKind.LastKeyword?palette.system:null;
 if(k===ts.SyntaxKind.StringLiteral)color='#FFFFFF';if(k===ts.SyntaxKind.NumericLiteral)color='#B5CEA8';
 if(color)colors.fill(color,scanner.getTokenPos(),scanner.getTextPos());
}
for(const m of classify(ts,sourceFile,source))if(palette[m.role])colors.fill(palette[m.role],m.start,m.end);
const steps=[
 ['export function shuffle(): string[] {','Начало корневой функции shuffle. Она перемешивает первые восемь букв алфавита и возвращает массив. Круг Start обозначает вход; синяя плитка рядом — пользовательскую функцию.'],
 ["const alphabet = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ё', 'Ж'];",'Создаём массив alphabet. Массив показан штабелем коробок; открытый штабель означает первое появление переменной. Прикреплённый по диагонали set со штриховкой — виртуальное представление присваивания, а не вызов из исходника.'],
 ['let current: { index: number; value: string | undefined }\n  = { index: alphabet.length - 1, \n      value: undefined };','Создаём current: открытая коробка получает объект. Фигурные скобки раскрывают его поля по вертикали. index начинается с последней позиции массива; value пока undefined. length и undefined — системные сущности, поэтому фиолетовые.'],
 ['for (','Входим в цикл for. Сам цикл — системная конструкция, поэтому его плитка фиолетовая. Условие и уменьшение индекса вынесены в отдельные узлы: по ним виден порядок выполнения.'],
 ['current.index > 0','Проверяем, остались ли элементы для перестановки. Гекс — условное ветвление: true ведёт в тело цикла, false — влево к выходу. На нулевом индексе перебор заканчивается.'],
 ['current.value = alphabet[current.index];','Сохраняем текущую букву до обмена. Справа извлекается элемент массива по current.index, затем значение возвращается в set у current.value. Косая штриховка отмечает виртуальную операцию присваивания.'],
 ['const random = getRandom(current.index + 1);','Создаём random и получаем случайный индекс в ещё не обработанной части массива. Вызов getRandom синий; вычисление аргумента раскрыто справа. Полученное значение записывается виртуальным set в открытую коробку.'],
 ['swap(alphabet, current, random);','Передаём в swap массив, текущую букву с её индексом и случайный индекс. Синий вызов раскрывает семейство из трёх аргументов. swap меняет буквы местами; на следующем проходе последняя позиция уже не участвует.'],
 ['current.index--','Уменьшаем текущий индекс на единицу. Оператор -- показан у переменной, а связь repeat возвращает исполнение к проверке условия. На обмен теперь стоит предпоследняя буква, затем предыдущая.'],
 ['return alphabet;','Возвращаем перемешанный массив. Здесь читается уже существующий alphabet: штабель закрыт, в отличие от объявления в начале. Выход false из условия приводит к этому шагу после завершения цикла.'],
];
steps[2][0]=source.match(/let current:[\s\S]*?value: undefined };/)[0];
const doc=new DOMParser().parseFromString(fs.readFileSync(file,'utf8'),'text/xml');
const root=doc.getElementsByTagName('root')[0];
let cells=Array.from(doc.getElementsByTagName('mxCell'));
if(cells.some(c=>c.getAttribute('id').startsWith('article-code-')))throw Error('Cards already exist');
const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
const g=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const num=(e,k)=>Number(e?.getAttribute(k)||0),parent=c=>byId.get(c?.getAttribute('parent'));
const y=c=>c?num(g(c),'y')+y(parent(c)):0;
const rows=steps.map((_,i)=>byId.get(`f0-fold-row-${i+1}`));
const oldY=rows.map(y),deltas=[];let previousBottom=-Infinity;
for(let i=0;i<rows.length;i++){const next=Math.max(oldY[i],previousBottom+20);deltas[i]=next-oldY[i];previousBottom=next+Math.max(num(g(rows[i]),'height'),132);}
const shiftAt=v=>{let i=oldY.findLastIndex(a=>a<=v);return i<0?0:deltas[i];};
const oldParentY=new Map(cells.map(c=>[c,y(parent(c))]));
for(let i=0;i<rows.length;i++)g(rows[i]).setAttribute('y',String(num(g(rows[i]),'y')+deltas[i]));
for(const c of cells.filter(c=>c.getAttribute('edge')==='1'))for(const p of Array.from(g(c)?.getElementsByTagName('mxPoint')||[])){
 if(p.getAttribute('as')==='offset')continue;const abs=num(p,'y')+oldParentY.get(c);p.setAttribute('y',String(abs+shiftAt(abs)-y(parent(c))));
}
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function htmlCode(text){const start=source.indexOf(text);if(start<0)throw Error('Code not found: '+text);let html='',line=0;for(let i=0;i<text.length;){if(text[i]==='\n'){html+='<br>';line=0;i++;continue;}const color=colors[start+i];let j=i+1;while(j<text.length&&text[j]!=='\n'&&colors[start+j]===color&&j-i+line<65)j++;html+=`<span style="color:${color}">${esc(text.slice(i,j)).replaceAll(' ','&nbsp;')}</span>`;line+=j-i;i=j;if(line>=65){html+='<br>';line=0;}}return `<div style="font-family:Consolas,monospace;font-size:14px;line-height:21px;text-align:left;color:#D4D4D4">${html}</div>`;}
function card(id,value,style,x,top,width,height,step){const c=doc.createElement('mxCell');for(const [k,v]of Object.entries({id,value,style,parent:'1',vertex:'1',annotationFor:step.getAttribute('headStableIds')||step.getAttribute('stableId'),sourceFile}))c.setAttribute(k,v);const geom=doc.createElement('mxGeometry');for(const[k,v]of Object.entries({x,y:top,width,height,as:'geometry'}))geom.setAttribute(k,String(v));c.appendChild(geom);root.appendChild(c);}
for(let i=0;i<steps.length;i++){const [code,note]=steps[i];card(`article-code-${i+1}`,htmlCode(code),'rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=#1E1E1E;strokeColor=#3C4655;strokeWidth=1;align=left;verticalAlign=middle;spacing=14;fontColor=#D4D4D4;fontSize=14;',650,y(rows[i]),600,Math.max(58,(code.split('\n').length+Math.floor(code.length/65))*21+24),rows[i]);card(`article-note-${i+1}`,esc(note),'rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=#F5F5F5;strokeColor=#B8B8B8;strokeWidth=1;align=left;verticalAlign=middle;spacing=12;fontColor=#222222;fontSize=14;fontStyle=0;',1274,y(rows[i]),470,132,rows[i]);}
fs.writeFileSync(file,new XMLSerializer().serializeToString(doc));console.log(JSON.stringify({steps:steps.length,codeCards:10,annotations:10,palette,addedHeight:deltas.at(-1)}));
