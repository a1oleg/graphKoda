import {measureMosaicTile,mosaicTileImage,mosaicTextWidth} from './mosaicTileGeometry.mjs';
const geo=c=>Array.from(c?.childNodes||[]).find(n=>n.nodeName==='mxGeometry');
const n=(c,k)=>Number(geo(c)?.getAttribute(k)||0);
const label=c=>c.getAttribute('puzzleOriginalLabel')||c.getAttribute('value')||'';
const svg=(fill,stroke)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><path d="M .5 .5 H 99.5 V 29.5 H .5 Z" fill="${fill}" stroke="${stroke}"/></svg>`;
function paint(c,text,left,right,system){
  const body=svg(system?'#E1D5E7':'#DAE8FC',system?'#9673A6':'#007FFF'),m=measureMosaicTile(text,body);
  m.left=left;m.right=right;if(left==='round'){m.width+=10;m.spacingLeft+=10;}if(right==='inward'){m.width+=10;m.spacingRight+=10;}
  c.setAttribute('value',text);c.setAttribute('puzzleOriginalLabel',text);
  c.setAttribute('style',`shape=image;imageAspect=0;image=${mosaicTileImage(body,m,30)};fontSize=12;html=1;align=left;verticalAlign=middle;spacingLeft=${m.spacingLeft};spacingRight=${m.spacingRight};`);
  geo(c).setAttribute('width',String(m.width));c.setAttribute('callPrefixVersion','1');return m.width;
}

/** Fixed cap sizing and measured argument corridors; no source-name exceptions. */
export function refineCallFamilies(doc){
  const cells=Array.from(doc.getElementsByTagName('mxCell')),byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const children=id=>cells.filter(c=>c.getAttribute('parent')===id&&c.getAttribute('vertex')==='1');
  const pos=c=>{if(!c||c.getAttribute('id')==='1')return{x:0,y:0};const p=pos(byId.get(c.getAttribute('parent')));return{x:p.x+n(c,'x'),y:p.y+n(c,'y')};};
  const root=id=>{let c=byId.get(id);while(c&&/-part-\d+$/.test(c.getAttribute('id')))c=byId.get(c.getAttribute('parent'));return c;};
  for(const opening of cells.filter(c=>c.getAttribute('awaitedTypePresentation')==='1'&&c.hasAttribute('locationStableId'))){
    const id=opening.getAttribute('id'),method=children(id).find(c=>/\($/.test(label(c)));if(!method)continue;
    let prefix=children(id).find(c=>label(c)==='await');
    if(!prefix){prefix=doc.createElement('mxCell');for(const[k,v]of Object.entries({id:id+'-prefix-await',parent:id,vertex:'1',value:'await',graphLabels:'System,Keyword,Await',sourceStableId:opening.getAttribute('sourceCallStableId')}))prefix.setAttribute(k,v);
      const g=doc.createElement('mxGeometry');for(const[k,v]of Object.entries({x:0,y:0,width:0,height:30,as:'geometry'}))g.setAttribute(k,String(v));prefix.appendChild(g);opening.parentNode.appendChild(prefix);cells.push(prefix);byId.set(prefix.getAttribute('id'),prefix);}
    const w=paint(prefix,'await','round','flat',true),mw=paint(method,label(method),'flat','inward',false);geo(method).setAttribute('x',String(w));geo(opening).setAttribute('width',String(w+mw));
    const args=cells.filter(e=>e.getAttribute('edgeType')==='ARG'&&root(e.getAttribute('source'))===opening);
    const family=new Set(args.map(e=>root(e.getAttribute('target'))?.getAttribute('id')).filter(Boolean));
    for(let round=0;round<32;round++){const size=family.size;for(const e of cells.filter(c=>['ARG','ArgJoin','FIELD','FieldJoin'].includes(c.getAttribute('edgeType'))))if(family.has(root(e.getAttribute('source'))?.getAttribute('id')))family.add(root(e.getAttribute('target'))?.getAttribute('id'));if(size===family.size)break;}
    const group=byId.get(id+'-awaited-type');if(group)family.add(group.getAttribute('id'));
    const targets=args.map(e=>root(e.getAttribute('target'))).filter(Boolean);if(!targets.length)continue;
    const openingRight=pos(opening).x+n(opening,'width');
    const corridor=24+Math.max(24,...args.map(e=>mosaicTextWidth(e.getAttribute('value')||'')+16));
    const shift=Math.min(0,openingRight+corridor-Math.min(...targets.map(c=>pos(c).x)));
    const isMoved=id=>{let c=byId.get(id);while(c){if(family.has(c.getAttribute('id')))return true;c=byId.get(c.getAttribute('parent'));}return false;};
    for(const key of family){const c=byId.get(key);if(c&&!family.has(c.getAttribute('parent')))geo(c).setAttribute('x',String(n(c,'x')+shift));}
    for(const e of cells.filter(c=>c.getAttribute('edge')==='1')){
      const points=Array.from(geo(e)?.getElementsByTagName('mxPoint')||[]).filter(p=>p.getAttribute('as')!=='offset');
      if(isMoved(e.getAttribute('source'))&&isMoved(e.getAttribute('target')))for(const p of points)p.setAttribute('x',String(Number(p.getAttribute('x'))+shift));
      else if(isMoved(e.getAttribute('source'))&&points.length)points[0].setAttribute('x',String(Number(points[0].getAttribute('x'))+shift));
    }
    const route=(e,points,style)=>{const g=geo(e);for(const a of Array.from(g.childNodes))if(a.nodeName==='Array')g.removeChild(a);const a=doc.createElement('Array');a.setAttribute('as','points');for(const p of points){const q=doc.createElement('mxPoint');q.setAttribute('x',String(p.x));q.setAttribute('y',String(p.y));a.appendChild(q);}g.appendChild(a);e.setAttribute('style',style);};
    const split=openingRight+24;
    for(const e of args){const p=pos(byId.get(e.getAttribute('parent'))),t=root(e.getAttribute('target')),sy=pos(opening).y+n(opening,'height')/2,ty=pos(t).y+n(t,'height')/2;
      route(e,[{x:split-p.x,y:sy-p.y},{x:split-p.x,y:ty-p.y}],(e.getAttribute('style')||'').replace(/(?:exitX|exitY|entryX|entryY)=[^;]*;/g,'')+'exitX=1;exitY=0.5;entryX=0;entryY=0.5;');}
    const wait=byId.get(id+'-awaited-type-await');if(wait&&group){const p=pos(byId.get(wait.getAttribute('parent'))),s=byId.get(wait.getAttribute('source')),a=pos(s),b=pos(group),right=a.x+n(s,'width')+24,mid=b.y-18,left=b.x-20;
      route(wait,[{x:right-p.x,y:a.y+15-p.y},{x:right-p.x,y:mid-p.y},{x:left-p.x,y:mid-p.y},{x:left-p.x,y:b.y+15-p.y}],
        'edgeStyle=none;rounded=0;endArrow=block;strokeColor=#9673A6;exitX=1;exitY=0.5;entryX=0;entryY=0.5;');wait.setAttribute('value','');}
  }
  // Prefix tokens always get the opening cap, including ordinary yield/new rows.
  for(const c of cells.filter(c=>c.getAttribute('vertex')==='1'&&/^(await|yield\s*\*?|new)$/.test(label(c))&&!c.hasAttribute('callPrefixVersion'))){
    const old=n(c,'width'),w=paint(c,label(c),'round','flat',true),delta=w-old,parent=byId.get(c.getAttribute('parent'));
    for(const sibling of children(c.getAttribute('parent')))if(sibling!==c&&n(sibling,'x')>n(c,'x'))geo(sibling).setAttribute('x',String(n(sibling,'x')+delta));
    if(parent&&geo(parent))geo(parent).setAttribute('width',String(n(parent,'width')+delta));
  }
}
