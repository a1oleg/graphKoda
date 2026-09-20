import fs from 'node:fs';
const metrics=JSON.parse(fs.readFileSync(new URL('./mosaicFontMetrics.json',import.meta.url),'utf8'));

// Each cap owns its fixed-width strip. Only the text rectangle can grow.
export const SIDE_WIDTH=Object.freeze({flat:0,hex:16,round:10,inward:10,tab:9,socket:9});
export const TEXT_PAD=2;
export function mosaicTextWidth(text, {fontSize=12,bold=false}={}) {
  const widths=metrics[bold?'bold':'normal'];
  return Math.ceil(Math.max(0,...String(text).split('\n').map(line=>[...line].reduce((n,ch)=>n+(widths[ch] ?? 12),0)))*fontSize/12);
}

export function decodeMosaicImage(style) {
  const image=/(?:^|;)image=data:image\/svg\+xml,([^;]+)/u.exec(style)?.[1];
  return image ? decodeURIComponent(image) : null;
}

export function mosaicPartAdvance(part, next, style, fallback) {
  const svg=decodeMosaicImage(style);
  if(!svg) return fallback;
  const member=p=>/^\.[$\p{ID_Start}][\p{ID_Continue}$]*(?:\()?$/u.test(p?.plainText || p?.text || '');
  return measureMosaicTile(part.plainText || part.text || '',svg,{
    leftTab:member(part),rightSocket:member(next),
    bold:/(?:^|;)fontStyle=[1357](?:;|$)/u.test(style),
    fontSize:Number(/(?:^|;)fontSize=([\d.]+)/u.exec(style)?.[1] || 12),
  }).advance;
}

export function inferMosaicSides(svg) {
  const d=/<path\b[^>]*\bd=['"]([^'"]+)['"]/u.exec(svg)?.[1] || '';
  const vb=/viewBox=['"]([\d. -]+)['"]/u.exec(svg)?.[1].split(/\s+/).map(Number);
  const w=vb?.[2] || 100;
  const head=/^M\s*([\d.]+)\s+[\d.]+\s+H\s*([\d.]+)\s*([A-Z])/u.exec(d);
  let left='flat',right='flat';
  if (head) {
    if (head[3]==='L') right='hex';
    if (head[3]==='C') right=Number(head[2])>=w-1?'inward':'round';
    if (/C[^]*Z\s*$/u.test(d) && /H\s+[\d.]+\s+C[^H]*Z\s*$/u.test(d)) {
      left=/H\s+0\s+C[^H]*Z\s*$/u.test(d)?'inward':'round';
    } else if (/L[^L]*Z\s*$/u.test(d) && Number(head[1])>0) left='hex';
  }
  return {left,right};
}

export function measureMosaicTile(text, svg, {leftTab=false,rightSocket=false,fontSize=12,bold=false}={}) {
  const sides=inferMosaicSides(svg);
  const left=leftTab?'tab':sides.left, right=rightSocket?'socket':sides.right;
  const displayText=leftTab?String(text).replace(/^\./u,''):String(text);
  const textWidth=mosaicTextWidth(displayText,{fontSize,bold});
  const width=SIDE_WIDTH[left]+TEXT_PAD+textWidth+TEXT_PAD+SIDE_WIDTH[right];
  return {left,right,displayText,textWidth,width,advance:width-(leftTab?SIDE_WIDTH.tab:0),
    spacingLeft:SIDE_WIDTH[left]+TEXT_PAD,spacingRight:SIDE_WIDTH[right]+TEXT_PAD};
}

export function mosaicTileImage(svg, layout, height, {system=false}={}) {
  const {width:w,left,right}=layout, top=.5,bottom=height-.5,mid=height/2,dot=mid+3;
  const fill=system?'#E1D5E7':(/fill=['"](#[\da-f]+)['"]/iu.exec(svg)?.[1] || '#FFE6CC');
  const stroke=system?'#9673A6':(/stroke=['"](#[\da-f]+)['"]/iu.exec(svg)?.[1] || '#BE7000');
  const r=w-.5, l=.5;
  const rightEdge={
    flat:`H ${r} V ${bottom}`,
    hex:`H ${r-16} L ${r} ${mid} L ${r-16} ${bottom}`,
    round:`H ${r-10} C ${r+3} ${height*.28} ${r+3} ${height*.72} ${r-10} ${bottom}`,
    inward:`H ${r} C ${r-12} ${height*.28} ${r-12} ${height*.72} ${r} ${bottom}`,
    socket:`H ${r} V ${dot-4} H ${r-2} C ${r-3} ${dot-7} ${r-8} ${dot-6} ${r-8} ${dot} C ${r-8} ${dot+6} ${r-3} ${dot+7} ${r-2} ${dot+4} H ${r} V ${bottom}`,
  }[right];
  const leftEdge={
    flat:`H ${l} V ${top}`,
    hex:`H ${l+16} L ${l} ${mid} L ${l+16} ${top}`,
    round:`H ${l+10} C ${l-3} ${height*.72} ${l-3} ${height*.28} ${l+10} ${top}`,
    inward:`H ${l} C ${l+12} ${height*.72} ${l+12} ${height*.28} ${l} ${top}`,
    tab:`H 8.5 V ${dot+4} H 6.5 C 5.5 ${dot+7} .5 ${dot+6} .5 ${dot} C .5 ${dot-6} 5.5 ${dot-7} 6.5 ${dot-4} H 8.5 V ${top}`,
  }[left];
  const start=left==='hex'?16.5:left==='round'?10.5:left==='tab'?8.5:.5;
  const d=`M ${start} ${top} ${rightEdge} ${leftEdge} Z`;
  // Retain virtual-method hatching, clipped to the new assembled contour.
  const hatched=/clip-path=['"]url\(#c\)/u.test(svg);
  let hatch='';
  if(hatched) for(let x=-height;x<w;x+=10) hatch+=`M ${x} ${height} L ${x+height} 0 `;
  const body=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none"><path d="${d}" fill="${fill}"/>${hatched?`<defs><clipPath id="h"><path d="${d}"/></clipPath></defs><path d="${hatch}" clip-path="url(#h)" stroke="${stroke}" stroke-width="1" opacity=".3"/>`:''}<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>${left==='tab'?`<circle cx="4" cy="${dot}" r="1.2" fill="#000000"/>`:''}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(body)}`;
}
