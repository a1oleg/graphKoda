// Measure each branch independently. A sibling's width or caption must not
// create padding before another sibling. All dimensions are in diagram units.
export function argumentFamilyMetrics(branches,{stem=24,branchGap=36,labelPadding=16,closingGap=36}={}) {
  const offsets=branches.map(b=>stem+Math.max(branchGap,b.labelWidth?b.labelWidth+labelPadding:0));
  const right=Math.max(...branches.map((b,i)=>offsets[i]+b.width));
  return {stem,offsets,closingOffset:right+closingGap};
}
