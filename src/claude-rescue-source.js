import {coveredThrough,frontier,tailStart,turnTail,safeAssistantStarts,renderPacket} from './compaction.js'
import {verifiedCompactionInput} from './claude-compaction-input.js'
import {claudeCompactionNodes,rescueHash,rescueSourceHash} from './claude-checkpoints.js'
import {summarySource,summaryToolPairing,recentUserTexts} from './summary-source.js'
import {detectSummaryLanguage} from './summary-language.js'
import {buildSummaryPrompt,SUMMARY_SYSTEM} from './summary-policy.js'
import {estimateSummaryTokens} from './summary-tokens.js'
import {isReducedSummary} from './summary-fitting.js'
import {isRequestCopy} from './claude-records.js'

import {ids,canonical,bodies,liveMessage} from './claude-live-messages.js'
export {liveMessage} from './claude-live-messages.js'

const messageKey=m=>rescueHash([m.role,m.text.trim(),ids(m.toolUses),ids(m.toolResultIds)])
function archivedMessages(store,session) {
  return store.eventRows(session).flatMap(e=>{
    const raw=store.exact(session,e.ordinal),record=JSON.parse(raw),role=record.message?.role||record.role||record.type
    if(isRequestCopy(record))return []
    if(!['user','assistant'].includes(role))return []
    const content=record.message?.content??record.content
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n'):''
    const pairing=summaryToolPairing(raw)
    const blocks=Array.isArray(content)?content:[],toolBodies=bodies({toolUses:blocks.filter(b=>b.type==='tool_use'),toolResults:blocks.filter(b=>b.type==='tool_result')})
    const message={role,text,toolUses:pairing.opened,toolResultIds:pairing.closed}
    return [{ordinal:e.ordinal,digest:e.digest,key:messageKey(message),native:record.isCompactSummary===true,
      endsTurn:pairing.endsTurn===true,
      toolBodies:toolBodies.map(body=>Object.fromEntries(Object.entries(body).map(([name,value])=>[name,rescueHash(canonical(value))])))}]
  })
}
export function rescuePacket(store,session,p,summary) {
  const node={id:p.nodeId,level:p.level,first:0,last:p.through,summary,rescueRequest:p.request}
  const packet=renderPacket({meta:store.metadata(session),summaries:[node],through:p.through,keep:p.keep,instructions:p.instructions,request:p.request})
  if(!packet)return null
  const after=p.keptTokens+estimateSummaryTokens(packet)
  if(after>p.window*.35)return null
  return {use:true,packet,start:p.start,keep:p.keep,through:p.through,after:Math.ceil(after),rescue:true}
}
export function prepareRescueSource(store,session,input) {
  const setting=store.takeover(),messages=(input.messages||[]).map(liveMessage)
  const context=verifiedCompactionInput(store,session,messages),events=context.events
  if(messages.some(m=>!Number.isFinite(m.size)||m.size<=0))return null
  const archived=archivedMessages(store,session),keys=messages.map(messageKey),candidates=[]
  for(let at=0;at+keys.length<=archived.length;at++)if(keys.every((key,i)=>{
    const stored=archived[at+i]
    return stored.key===key&&messages[i].toolBodies.every(body=>{
      const original=stored.toolBodies.find(b=>b.id===rescueHash(body.id)&&b.kind===rescueHash(body.kind))
      return !!original&&Object.entries(body).every(([name,value])=>{
        const storedHash=original[name]??(name==='error'?rescueHash(false):undefined)
        return storedHash!==undefined&&storedHash===rescueHash(canonical(value))
      })
    })
  }))candidates.push(at)
  // The entire exact active sequence must identify one original timeline.
  if(candidates.length!==1)return null
  const active=archived.slice(candidates[0],candidates[0]+messages.length)
  if(active.at(-1).ordinal!==archived.at(-1).ordinal)return null
  // Full sequence and tool-body matching above identify the exact source turn,
  // even when separate notifications happen to repeat the same prompt text.
  context.messages=context.messages.map((m,i)=>({...m,verifiedTurnBoundary:active[i].endsTurn}))
  if(active[0].native)context.messages[0].nativeSummary=true
  const window=Math.min(input.window||setting.window,setting.window),tokens=input.tokens
  if(!Number.isFinite(tokens)||tokens<=0||!Number.isFinite(window)||window<1000||messages.length<2||typeof input.model!=='string'||!input.model)return null
  const size=m=>m.size,total=messages.reduce((s,m)=>s+size(m),0)||1
  let start=tailStart(context.messages,messages.length),request=null
  const want=Math.min(setting.keep,tokens/2)
  let wide=start,newest=messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total
  while(wide>0&&newest<want)newest+=size(messages[--wide])*tokens/total
  const safe=new Set(safeAssistantStarts(context.messages))
  // Ordinary suffixes start at human prompts; a long single turn needs the
  // existing verified request carry plus a tool-complete assistant boundary.
  if(start===0||start===messages.length||messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total>window*.3){
    const within=turnTail({messages:context.messages,events,cut:messages.length,tokens,total,size,keepTokens:setting.keep,window})
    if(!within)return null
    start=within.start;request=within.request
  }else if(wide>0&&newest<=want*2){
    while(wide>0&&context.messages[wide].role!=='user')wide--
    if(wide>0)start=Math.min(start,wide)
  }
  if(start<=0||start>=messages.length)return null
  const pending=new Set()
  for(const m of context.messages.slice(0,start)){if(m.verifiedTurnBoundary)pending.clear();for(const id of m.toolUses)pending.add(id);for(const id of m.toolResultIds)pending.delete(id)}
  if(context.messages[start].verifiedTurnBoundary)pending.clear()
  if(pending.size||messages[start].toolResultIds.length||request&&!safe.has(start))return null
  const matched=active.slice(0,start),through=matched.at(-1).ordinal
  const nodes=claudeCompactionNodes(store,session).filter(n=>n.last<=through)
  const covered=coveredThrough(nodes),prefix=frontier(nodes,covered)
  if(prefix.some(n=>isReducedSummary(n.summary)))return null
  let from=covered+1,content=prefix.map(n=>`[summary ${n.id}; records ${n.first}-${n.last}]\n${n.summary}`).join('\n')
  const opening=matched[0]
  // A real native checkpoint is usable historical context; a person pasting
  // the same prose cannot supply this proof.
  if(opening.native&&opening.ordinal>=from){
    const original=JSON.parse(store.exact(session,opening.ordinal)),blocks=original.message?.content??original.content
    const native=typeof blocks==='string'?blocks:blocks.filter(b=>b.type==='text').map(b=>b.text||'').join('\n')
    content+=`\n[verified native checkpoint record ${opening.ordinal}]\n${native}`
    from=opening.ordinal+1
  }
  for(const e of store.eventRows(session).filter(e=>e.ordinal>=from&&e.ordinal<=through)){
    if(request?.ordinal===e.ordinal)continue // carried verbatim, never rewritten
    const source=summarySource(store.exact(session,e.ordinal))
    if(source)content+=`\n[record ${e.ordinal}]\n${source}`
    if(content.length>32e6)return null
  }
  if(!content.trim())return null
  const language=detectSummaryLanguage(recentUserTexts(store,session)),level=1+Math.max(0,...prefix.map(n=>n.level))
  const outputTokens=Math.max(1024,Math.min(12000,Math.floor(window*.12)))
  const task={level,kind:'checkpoint',first:0,last:through,language,requireHeading:true,maxChars:60000,targetTokens:outputTokens}
  const prompt=buildSummaryPrompt(content,task),inputTokens=estimateSummaryTokens(SUMMARY_SYSTEM+prompt)
  if(inputTokens+outputTokens+2048>window||prompt.length>32e6)return null
  const p={start,keep:messages.length-start,through,request,window,tokens,keptTokens:messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total,
    instructions:input.instructions||'',model:input.model,level,language,outputTokens,sourceHash:rescueSourceHash(store,session,through),
    children:prefix.map(n=>n.id),childHashes:prefix.map(n=>[n.id,rescueHash(n.summary)]),inputHash:rescueHash(messages),settingHash:rescueHash(setting),cancelId:input.cancel_id||null,surfaceHash:rescueSourceHash(store,session,Number.MAX_SAFE_INTEGER)}
  p.nodeId='claude-rescue-'+rescueHash([session,p.sourceHash,p.inputHash,p.settingHash,p.model,p.childHashes,p.instructions,p.window,p.keptTokens]).slice(0,40)
  return {preparation:p,system:SUMMARY_SYSTEM,prompt,task,maxTokens:outputTokens}
}
