// Layout adapter only: the stored graph keeps typed signature relations.
// The return declaration is placed by the signature compositor, not as an Op.
export function projectSignatureLayout(nodes,edges) {
  const hidden=new Set(nodes.filter(n=>(n.labels||[]).some(l=>l==='ReturnType'||l==='ReturnTypeArgument')).map(n=>n.key));
  const result=[];
  for(const edge of edges){
    if(edge.type==='SIGNATURE_RETURN'){
      for(const body of edges.filter(e=>e.start===edge.end&&e.type==='BODY_ENTRY'))result.push({
        ...body,start:edge.start,type:'NEXT',props:{...body.props,flow_layer:'control',flowLayer:'control',signatureReturnStableId:edge.end,signatureRelationship:'SIGNATURE_RETURN'},
      });
    }else if(!hidden.has(edge.start)&&!hidden.has(edge.end)){
      result.push(['SIGNATURE_PARAMETER','BODY_ENTRY'].includes(edge.type)?{
        ...edge,type:'NEXT',props:{...edge.props,flow_layer:'control',flowLayer:'control',signatureRelationship:edge.type},
      }:edge);
    }
  }
  return {nodes:nodes.filter(n=>!hidden.has(n.key)),edges:result};
}
