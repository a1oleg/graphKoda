import {scenario as inputScenario,buildFrames,buildSequence,accumulatedContexts} from './replayModel.js';
import {speculationScenario} from './speculationReplay.js';
import {resolveReplayRoute,replayRoutes} from './replayRoutes.js';
const params=new URLSearchParams(location.search);
const scenario = params.has('stableId') ? resolveReplayRoute(params.get('stableId'))?.model
  : params.get('scenario') === 'speculation' ? speculationScenario : inputScenario;
function start() {
if(!scenario){document.body.textContent='Для этого узла нет подготовленного маршрута аннотатора.';return;}
const $=id=>document.getElementById(id), byId=new Map(scenario.nodes.map(n=>[n.id,n]));
const frames=buildFrames(scenario); let index=0;
const collapsedContexts=new Set();
const menu=document.createElement('div');menu.className='node-menu';menu.hidden=true;menu.setAttribute('role','menu');document.body.append(menu);
function closeMenu(){menu.hidden=true;}
function nodeStableId(node){return node.stableId || (node.id===scenario.root?replayRoutes.find(route=>route.model===scenario)?.stableId:'') || '';}
function nodeContext(node){
  const stableId=nodeStableId(node);
  return [node.title,stableId?`stableId: ${stableId}`:'',`${node.file}:${node.line}`].filter(Boolean).join('\n');
}
function openMenu(event,id,edge=null){
  event.preventDefault();event.stopPropagation();
  const node=byId.get(id);if(!node)return;
  menu.replaceChildren();
  const actions=[
    ['Добавить в Чат','message-square-plus',async()=>{
      if(params.get('host')!=='vscode')throw new Error('Добавление в чат доступно в визуализаторе расширения VS Code.');
      let value=nodeContext(node),stableId=nodeStableId(node);
      if(edge){
        const source=byId.get(edge.source().data('subject')),target=byId.get(edge.target().data('subject'));
        stableId=edge.data('stableId') || '';
        value=[`Связь: ${edge.data('label') || (edge.hasClass('reply')?'возврат контекста':edge.hasClass('lifeline')?'ось':'запрос контекста')}`,
          `visualEdgeId: ${edge.id()}`,stableId?`stableId: ${stableId}`:'',
          source?`Источник:\n${nodeContext(source)}`:'',target?`Адресат:\n${nodeContext(target)}`:''].filter(Boolean).join('\n');
      }else if(!contextElements.get(id).hidden)value+=`\n\n${contextElements.get(id).innerText}`;
      parent.postMessage({type:'annotationVisualizer',action:'addToChat',text:value,stableId},'*');
    }],
  ];
  if(params.get('host')==='vscode')actions.unshift(['Перейти в Код','file-code',()=>parent.postMessage({type:'annotationVisualizer',action:'openSource',file:node.file,line:node.line},'*')]);
  for(const [label,icon,action] of actions){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');
    const glyph=document.createElement('i');glyph.dataset.lucide=icon;button.append(glyph,document.createTextNode(label));
    button.onclick=async()=>{closeMenu();try{await action();}catch(error){window.alert(error.message);}};menu.append(button);
  }
  menu.hidden=false;window.lucide?.createIcons();
  menu.style.left=`${Math.max(4,Math.min(event.clientX,innerWidth-menu.offsetWidth-4))}px`;
  menu.style.top=`${Math.max(4,Math.min(event.clientY,innerHeight-menu.offsetHeight-4))}px`;
  menu.querySelector('button').focus({preventScroll:true});
}
document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
menu.addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp'].includes(event.key))return;
  event.preventDefault();const buttons=[...menu.querySelectorAll('button')],current=buttons.indexOf(document.activeElement);
  buttons[(current+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();
});
window.addEventListener('blur',closeMenu);window.addEventListener('resize',closeMenu);
document.title=`${scenario.title || 'Input'} · проход аннотатора`;
const cy=window.cytoscape({container:$('graph'),minZoom:.08,maxZoom:2,elements:buildSequence(scenario,frames),autoungrabify:true,
  layout:{name:'preset',fit:false},zoom:.8,pan:{x:20,y:20},style:[
    {selector:'node',style:{'shape':'roundrectangle','background-color':'#fff','border-width':1.5,'border-color':'#a9b8c0','label':'data(label)','font-size':12,'font-family':'system-ui','text-wrap':'wrap','text-max-width':170,'text-valign':'center','width':185,'height':48,'color':'#25383f'}},
    {selector:'node[system = 1]',style:{'shape':'hexagon','background-color':'#f2eefa','border-color':'#9177aa'}},
    {selector:'edge',style:{'width':1.5,'line-color':'#c5cfd3','target-arrow-color':'#c5cfd3','target-arrow-shape':'triangle','curve-style':'straight'}},
    {selector:'.participant',style:{'width':220,'height':104,'opacity':0,'label':'','z-index':3}},
    {selector:'.anchor',style:{'width':1,'height':1,'border-width':0,'background-opacity':0,'label':''}},
    {selector:'.event',style:{'width':1,'height':1,'border-width':0,'background-opacity':0,'label':''}},
    {selector:'.lifeline',style:{'target-arrow-shape':'none','line-style':'dashed','line-color':'#bbc5ca','z-index':0}},
    {selector:'.message',style:{'label':'data(label)','font-size':12,'text-margin-y':-12,'text-wrap':'wrap','text-max-width':210,'text-background-color':'#ffffff','text-background-opacity':1,'text-background-padding':2,'z-index':2}},
    {selector:'.reply',style:{'line-style':'dashed'}},
    {selector:'.future',style:{'opacity':.18}},
    {selector:'.visited',style:{'line-color':'#56a58e','target-arrow-color':'#56a58e','width':2.5}},
    {selector:'node.wait',style:{'background-color':'#fff2cd','border-color':'#b88a30'}},
    {selector:'node.done',style:{'background-color':'#e2f2e9','border-color':'#3b946c'}},
    {selector:'node.current',style:{'border-width':4}},
    {selector:'edge.focused',style:{'line-color':'#176db3','target-arrow-color':'#176db3','width':4}},
    {selector:'.context-block',style:{'width':220,'height':48,'padding':0,'label':'','opacity':0}},
  ]});
cy.add(scenario.nodes.map(node=>({data:{id:`context-${node.id}`,subject:node.id,label:''},classes:'context-block',style:{display:'none'}})));
cy.on('cxttap','edge',event=>{
  const edge=event.target,id=edge.source().data('subject');
  if(event.originalEvent)openMenu(event.originalEvent,id,edge);
});
const axisNames=[...new Set(scenario.nodes.flatMap(node=>[node.title,node.title.replace(/\s*\(.*$/u,'')]))].filter(Boolean).sort((a,b)=>b.length-a.length);
const namePattern=new RegExp(`(${axisNames.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})`,'gu');
function richText(element,value){
  element.replaceChildren();
  for(const part of String(value).split(namePattern)){
    if(axisNames.includes(part)){const strong=document.createElement('strong');strong.textContent=part;element.append(strong);}
    else element.append(document.createTextNode(part));
  }
}
function text(parent,tag,value,cls){const e=document.createElement(tag);richText(e,value);if(cls)e.className=cls;parent.append(e);return e;}
const contextLayer=document.createElement('div');contextLayer.className='sequence-context-layer';$('graph').append(contextLayer);
function syntaxHeading(element,node){
  const code=document.createElement('code');element.append(code);
  for(const [value,kind] of node.syntax.parts){
    const part=document.createElement('span');part.className=`syntax-${kind}`;part.textContent=value;code.append(part);
  }
  const description=document.createElement('div');description.className='axis-description';
  description.textContent=node.syntax.description;element.append(description);
}
const axisElements=new Map(scenario.nodes.map(node=>{
  const element=document.createElement('div');element.className='sequence-axis';
  element.oncontextmenu=event=>openMenu(event,node.id);
  syntaxHeading(element,node);
  contextLayer.append(element);return [node.id,element];
}));
const contextElements=new Map(scenario.nodes.map(node=>{
  const element=document.createElement('div');element.className='sequence-context';element.hidden=true;
  element.oncontextmenu=event=>openMenu(event,node.id);
  contextLayer.append(element);return [node.id,element];
}));
function positionContextBlocks(){
  for(const [id,element] of axisElements){
    const node=cy.$id(id),point=node.renderedPosition(),zoom=cy.zoom();
    element.style.transform=`translate(${point.x-node.width()*zoom/2}px,${point.y-node.height()*zoom/2}px) scale(${zoom})`;
  }
  for(const [id,element] of contextElements){
    if(element.hidden)continue;
    const block=cy.$id(`context-${id}`), point=block.renderedPosition(), zoom=cy.zoom();
    element.style.transform=`translate(${point.x-block.width()*zoom/2}px,${point.y-block.height()*zoom/2}px) scale(${zoom})`;
  }
}
cy.on('pan zoom resize',positionContextBlocks);
cy.on('pan zoom',closeMenu);
function render(followActive=true){const f=frames[index];
  closeMenu();
  cy.elements().removeClass('wait done current visited focused future');
  f.stack.forEach(id=>cy.$id(id).addClass('wait'));f.ready.forEach(id=>cy.$id(id).addClass('done'));
  cy.$id(f.id).addClass(f.ready.includes(f.id)?'done current':'wait current');
  for(const [id,element] of axisElements){
    element.dataset.state=f.ready.includes(id)?'done':f.stack.includes(id)||id===f.id?'wait':'idle';
    element.dataset.active=String(id===f.id);
  }
  cy.elements('[frame]').forEach(element=>{
    const step=element.data('frame');
    if(step>index)element.addClass('future');
    else if(step<index)element.addClass('visited');
    else element.addClass(element.isEdge()?'focused':'current');
  });
  const contexts=accumulatedContexts(scenario,frames,index);
  cy.nodes('.context-block').style('display','none');
  for(const element of contextElements.values())element.hidden=true;
  const level=cy.$id(`event-${index}`).position('y');
  for(const context of contexts){
    const block=cy.$id(`context-${context.id}`), owner=byId.get(context.id);
    const element=contextElements.get(context.id);element.replaceChildren();element.hidden=false;
    element.dataset.state=context.ready?'done':'wait';
    element.dataset.active=String(context.id===f.id);
    const collapsed=collapsedContexts.has(context.id);
    const header=document.createElement('div');header.className='context-heading';element.append(header);
    const title=document.createElement('div');title.className='context-title';header.append(title);
    syntaxHeading(title,owner);
    const toggle=document.createElement('button');toggle.type='button';toggle.className='context-toggle';
    toggle.title=collapsed?'Развернуть':'Свернуть';
    toggle.setAttribute('aria-label',`${toggle.title}: ${owner.title}`);
    toggle.setAttribute('aria-expanded',String(!collapsed));
    const icon=document.createElement('i');icon.dataset.lucide=collapsed?'chevron-down':'chevron-up';toggle.append(icon);
    toggle.onclick=()=>{
      if(collapsed)collapsedContexts.delete(context.id);else collapsedContexts.add(context.id);
      render(false);
      contextElements.get(context.id).querySelector('button').focus({preventScroll:true});
    };
    header.append(toggle);
    if(!collapsed){
      if(context.ready)text(element,'p',context.result);
      if(owner.deps.length){
        text(element,'p',context.ready?'Получено из:':'Контекст:');
        const list=document.createElement('ul');list.className='context-checklist';element.append(list);
        for(const id of owner.deps){
          const ready=context.dependencies.some(dep=>dep.id===id), dep=byId.get(id);
          const item=document.createElement('li');item.dataset.ready=String(ready);
          const status=document.createElement('span');status.className='dependency-status';
          status.setAttribute('role','img');status.setAttribute('aria-label',ready?'Получено':'Ожидается');
          status.title=ready?'Получено':'Ожидается';
          const icon=document.createElement('i');icon.dataset.lucide=ready?'check':'square';
          status.append(icon);item.append(status);text(item,'strong',dep.title);list.append(item);
        }
      }else if(!context.ready)text(element,'p','...');
    }
    block.style('height',element.offsetHeight);
    block.style('display','element');
    block.addClass(context.id===f.id?'current':context.ready?'done':'wait');
    const contextLevel=context.readyAt===null?level:cy.$id(`event-${context.readyAt}`).position('y');
    block.position({x:cy.$id(context.id).position('x'),y:contextLevel+32+block.outerHeight()/2});
  }
  positionContextBlocks();
  const active=cy.$id(`event-${index}`).renderedPosition();
  if(followActive&&(active.x<30||active.x>cy.width()-100||active.y<80||active.y>cy.height()-80)){
    cy.panBy({x:cy.width()/2-active.x,y:Math.min(180,cy.height()/2)-active.y});
  }
  $('counter').textContent=`${index} / ${frames.length-1}`;$('timeline').value=index;
  $('back').disabled=index===0;$('reset').disabled=index===0;$('next').disabled=index===frames.length-1;
  window.lucide?.createIcons();
}
$('next').onclick=()=>{index=Math.min(index+1,frames.length-1);render();};$('back').onclick=()=>{index=Math.max(index-1,0);render();};$('reset').onclick=()=>{index=0;render();};
$('timeline').max=frames.length-1;$('timeline').oninput=e=>{index=Number(e.target.value);render();};$('fit').onclick=()=>cy.fit(undefined,24);
new ResizeObserver(()=>cy.resize()).observe($('graph'));
window.lucide?.createIcons();render();
}
if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
