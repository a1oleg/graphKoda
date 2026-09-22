import {DOMParser, XMLSerializer} from '@xmldom/xmldom';

export function compactForDeparture(xml) {
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const cells=[...doc.getElementsByTagName('mxCell')];
  const byId=new Map(cells.map(c=>[c.getAttribute('id'),c]));
  const geo=c=>[...(c?.childNodes||[])].find(n=>n.nodeName==='mxGeometry');
  const number=(g,k)=>Number(g?.getAttribute(k)||0);
  const box=c=>{
    const g=geo(c);let x=number(g,'x'),y=number(g,'y');
    for(let p=byId.get(c?.getAttribute('parent'));p;p=byId.get(p.getAttribute('parent'))){x+=number(geo(p),'x');y+=number(geo(p),'y');}
    return {x,y,width:number(g,'width'),height:number(g,'height')};
  };
  let changed=0;
  for(const edge of cells.filter(c=>c.getAttribute('edgeType')==='NEXT'&&!c.hasAttribute('forDepartureCompacted'))){
    const source=byId.get(edge.getAttribute('source')),target=byId.get(edge.getAttribute('target'));
    if(!(source?.getAttribute('graphLabels')||'').split(',').includes('For')||!target)continue;
    const a=box(source),b=box(target);
    if(b.x<=a.x+a.width||b.y<=a.y+a.height)continue;
    const delta=(b.y+b.height/2-a.y-a.height/2)/2;
    let row=target;
    while(row&&!/-fold-row-|^fold-row-/.test(row.getAttribute('id')))row=byId.get(row.getAttribute('parent'));
    if(!row)continue;
    const cutoff=box(row).y;
    const snapshots=new Map(cells.map(c=>[c,box(c)]));
    const selected=new Set(cells.filter(c=>c.getAttribute('vertex')==='1'&&snapshots.get(c).y>=cutoff));
    const moved=new Set();
    for(const c of selected){
      let ancestor=false;
      for(let p=byId.get(c.getAttribute('parent'));p;p=byId.get(p.getAttribute('parent')))if(selected.has(p)){ancestor=true;break;}
      if(!ancestor){geo(c).setAttribute('y',number(geo(c),'y')-delta);moved.add(c);}
    }
    for(const c of cells.filter(c=>c.getAttribute('edge')==='1')){
      let parentMoved=false;
      for(let p=byId.get(c.getAttribute('parent'));p;p=byId.get(p.getAttribute('parent')))if(moved.has(p))parentMoved=true;
      if(parentMoved)continue;
      const parentY=snapshots.get(byId.get(c.getAttribute('parent')))?.y||0;
      for(const point of c.getElementsByTagName('mxPoint'))if(point.getAttribute('as')!=='offset'&&number(point,'y')+parentY>=cutoff)point.setAttribute('y',number(point,'y')-delta);
    }
    const style=new Map(edge.getAttribute('style').split(';').filter(Boolean).map(s=>{const i=s.indexOf('=');return [i<0?s:s.slice(0,i),i<0?'':s.slice(i+1)];}));
    for(const [k,v]of Object.entries({exitX:1,exitY:0.5,exitPerimeter:1,entryX:0.5,entryY:0,entryPerimeter:1}))style.set(k,String(v));
    edge.setAttribute('style',[...style].map(([k,v])=>v?`${k}=${v}`:k).join(';')+';');
    const g=geo(edge);
    for(const child of [...g.childNodes])if(child.nodeName==='Array'&&child.getAttribute('as')==='points')g.removeChild(child);
    const points=doc.createElement('Array');points.setAttribute('as','points');
    const p=doc.createElement('mxPoint'),parent=snapshots.get(byId.get(edge.getAttribute('parent')))||{x:0,y:0};
    p.setAttribute('x',b.x+b.width/2-parent.x);p.setAttribute('y',a.y+a.height/2-parent.y);points.appendChild(p);g.appendChild(points);
    edge.setAttribute('forDepartureCompacted',String(delta));changed++;
  }
  return {xml:new XMLSerializer().serializeToString(doc),changed};
}
