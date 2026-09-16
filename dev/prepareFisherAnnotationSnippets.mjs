import {readScene,mutateScene,syncScene} from '../graph/scene/scene.mjs';
let s=await readScene('fisher');
function implementation(title){const matches=Object.values(s.nodes).filter(n=>n.title===title&&n.labels.includes('FunctionImplementation'));if(matches.length!==1)throw Error('Implementation missing or ambiguous: '+title);return matches[0].stableId;}
const snippets=[
 {id:'random',ownerStableId:implementation('getRandom'),order:1,width:340,height:156,text:'Выбирает случайный целый индекс от нуля до переданной границы, не включая её. Math.random задаёт случайное число, Math.floor округляет результат вниз.'},
 {id:'swap',ownerStableId:implementation('swap'),order:2,width:340,height:156,text:'Меняет местами текущий и выбранный элементы массива. В текущую позицию записывает выбранный элемент, а на его место — заранее сохранённое текущее значение.'},
 {id:'shuffle',ownerStableId:implementation('shuffle'),order:3,width:540,height:156,text:'Перемешивает алфавит, проходя его с конца. На каждом шаге getRandom выбирает индекс в оставшейся части, а swap меняет выбранный элемент с текущим. Обработанная часть растёт; функция возвращает перемешанный массив.'},
];
// A narration pointer would overlap the newly shown root annotation.
for(const pointerId of Object.keys(s.pointers))s=await mutateScene({sceneId:'fisher',expectedRevision:s.revision,action:'pointer',pointerId,visible:false});
s=await mutateScene({sceneId:'fisher',expectedRevision:s.revision,action:'annotations',snippets,visibleThrough:3});
console.log(JSON.stringify({file:s.file,order:snippets.map(a=>a.id),allVisible:s.annotationStep===3}));
try{console.log(await syncScene('fisher'));}catch(e){console.log('Saved; live sync unavailable: '+e.message);}
