import { estimateSummaryTokens } from './summary-tokens.js'
import { MAX_SUMMARY_INPUT } from './runtime.js'

const render=node=>`[${node.id}, events ${node.first}-${node.last}]\n${node.summary}`
export const mergeContent=batch=>batch.map(render).join('\n\n')
// A parent can only claim a range that its actual children collectively cover.
// Overlap is allowed here because old rescue checkpoints may cover a prefix.
export function coversSummaryRange(children,first,last){
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||last<first||!children.length)return false
  let next=first
  for(const child of [...children].sort((a,b)=>a.first-b.first||a.last-b.last)){
    if(!Number.isSafeInteger(child.first)||!Number.isSafeInteger(child.last)||child.first<first||child.last>last||child.last<child.first||child.first>next)return false
    next=Math.max(next,child.last+1)
  }
  return next===last+1
}
// fanout is a minimum. Very small same-level summaries can wait for more
// adjacent siblings, rather than buying a new parent each time four appear.
export function selectSummaryMerge(lower, owned, {fanout, targetTokens, requireContiguous=false}) {
  const minimum=targetTokens==null?0:Math.min(2000,Math.max(512,Math.floor(targetTokens/10)))
  const maximum=targetTokens??Infinity
  let batch=[],tokens=0,bodyTokens=0,chars=0
  for(const node of lower) {
    if(owned.has(node.id)) {batch=[];tokens=0;bodyTokens=0;chars=0;continue}
    if(requireContiguous&&batch.length&&batch.at(-1).last+1!==node.first){batch=[];tokens=0;bodyTokens=0;chars=0}
    const content=render(node)
    if(content.length>MAX_SUMMARY_INPUT || estimateSummaryTokens(content)>maximum) {
      batch=[];tokens=0;bodyTokens=0;chars=0;continue
    }
    // Keep eligible adjacent suffixes when a larger older sibling makes the
    // whole prefix too expensive. Dropping the complete window loses work.
    while(batch.length && (chars+content.length+2>MAX_SUMMARY_INPUT || tokens+estimateSummaryTokens(content)+1>maximum)) {
      const oldest=batch.shift()
      chars-=render(oldest).length+(batch.length?2:0)
      tokens-=estimateSummaryTokens(render(oldest))+(batch.length?1:0)
      bodyTokens-=estimateSummaryTokens(oldest.summary)
    }
    batch.push(node);chars+=content.length+(batch.length>1?2:0);tokens+=estimateSummaryTokens(content)+(batch.length>1?1:0);bodyTokens+=estimateSummaryTokens(node.summary)
    if(batch.length>=fanout && bodyTokens>=minimum)return batch
  }
  return null
}
