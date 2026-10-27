import {forkRoute} from './fork-route.js'
import {summaryContext} from './summary-model.js'
import {abortable} from './summary-attempt.js'
import {ArchiveDatabase} from './archive-db.js'
// Passive archive summaries use the same one-response tree contract as takeover.
// This module never changes a session surface or invokes a compaction method.
import {isDeepStrictEqual} from 'node:util'
import {createUserMessage,isAgentLoopRequest} from '@deepseek-ai/dsh-llm'
import {forkScope} from './fork-scope.js'
import {forkHash,forkAnchors,forkDirective,parseForkTree} from './fork-summary.js'
import {completeSummaryStream} from './summary-session.js'
import {detectSummaryLanguage} from '../src/summary-language.js'
import {readSettings} from './settings.js'
import {archivePairing} from './archive-planner.js'
const listeners=new Map()
export function registerForkArchive(path,callback,revision=()=>null){
  const callbacks=listeners.get(path)||new Map();callbacks.set(callback,revision);listeners.set(path,callbacks)
  return ()=>{callbacks.delete(callback);if(!callbacks.size)listeners.delete(path)}
}
export function forkArchiveSnapshot(path){return new Map([...(listeners.get(path)||[])].map(([callback,revision])=>[callback,revision()]))}
export async function publishForkArchive(path,id,tree,receipt,snapshot){
  for(const [callback,revision] of listeners.get(path)||[]){
    if(snapshot&&(!snapshot.has(callback)||snapshot.get(callback)!==revision()))throw Error('DSH 摘要配置已变化，旧结果未归档')
    await callback(id,tree,receipt)
  }
}
export function registerArchiveCapture(service){
  service.forkRequests=new Map()
  service.ctx.on('llm/stream',(request,next)=>{
    if(!forkScope.getStore()&&isAgentLoopRequest(request)){
      const {signal,...plain}=request
      service.forkRequests.set(request.sessionId,structuredClone(plain))
    }
    return next()
  })
}
export async function summarizeArchiveFork(service,id,doc,owner,signal,{force=false}={}){
  signal=AbortSignal.any([signal,AbortSignal.timeout(180000)])
  const request=service.forkRequests.get(id),session=service.ctx.sessions.get(id)
  if(!request||!session)return 'awaiting-live-request'
  const info=await abortable(service.ctx.llm.resolveModelInfo(request.provider,request.model,signal),signal)
  const window=info.context?.contextWindow,reserve=request.maxTokens??info.defaultMaxTokens??0
  if(!Number.isSafeInteger(window)||window<=reserve)throw Error('聊天模型缺少上下文容量，原文保留')
  const inputBudget=window-reserve,measurement=service.ctx.tokenMeter.measure(session)
  if(!force&&measurement.totalTokens<inputBudget*(Math.round((doc.settings.compressionRatio-.1)*1e12)/1e12))return 'below-preparation-threshold'
  const byId=new Map(request.messages.map((message,index)=>[message.id,{message,index}]))
  const covered=new Set(service.db.nodes(id).filter(n=>n.level===0).flatMap(n=>n.sources))
  const selected=service.db.sourceRows(id).filter(row=>{
    if(covered.has(row.seq))return false
    const message=session.deriveEventMessage(session.eventAt(row.seq)),found=message&&byId.get(message.id)
    return found&&isDeepStrictEqual(found.message,message)
  })
  if(!selected.length)return 'no-visible-source'
  const leaves=[];let first=0,tokens=0;const pending=new Set()
  for(let i=0;i<selected.length;i++){
    const event=JSON.parse(selected[i].event);archivePairing(event,pending);tokens+=selected[i].tokens
    if(pending.size||tokens<doc.settings.chunkTokens&&i<selected.length-1)continue
    const group=selected.slice(first,i+1),messages=group.map(row=>session.deriveEventMessage(session.eventAt(row.seq)))
    const positions=messages.map(m=>byId.get(m.id).index)
    leaves.push({index:leaves.length,firstMessage:positions[0],lastMessage:positions.at(-1),sources:group.map(row=>row.seq),...forkAnchors(messages)})
    first=i+1;tokens=0
  }
  if(!leaves.length)return 'awaiting-tool-results'
  const language=detectSummaryLanguage(selected.filter(row=>JSON.parse(row.event).type==='user/message').map(row=>row.text))
  const usage={};let text='',options,prompt
  let scoped,route
  try{
    if(doc.settings.forkModelOverride&&doc.settings.summaryAdapter)scoped=summaryContext(service.ctx,doc.settings.summaryAdapter)
    if(scoped)await abortable(scoped.ready,signal)
    route=await forkRoute(scoped?.ctx||service.ctx,request,{enabled:doc.settings.forkModelOverride,provider:doc.settings.summaryProvider,model:doc.settings.summaryModel},signal)
    const targetTokens=Math.max(256,Math.min(12000,Math.floor((route.request.maxTokens||reserve||16384)*.65),Math.floor(inputBudget*.1)))
    options={fanout:doc.settings.fanout,targetTokens};prompt=forkDirective(leaves,targetTokens,language.name,options)
    if(measurement.totalTokens+Math.ceil(prompt.length/2)>=Math.min(inputBudget,route.inputBudget??Infinity)-1024)throw Error('所选后台模型放不下完整对话，原文保留')
    await forkScope.run(true,async()=>{
    const stream=route.ctx.llm.stream({...route.request,signal,messages:[...request.messages,createUserMessage({content:[{type:'text',text:prompt}]})]})
    for await(const chunk of completeSummaryStream(stream,signal)){
      signal.throwIfAborted();if(chunk.type==='text-delta')text+=chunk.text
      if(chunk.type==='usage')Object.assign(usage,chunk.usage)
    }
  })
  }finally{scoped?.dispose()}
  signal.throwIfAborted()
  const current=service.forkRequests.get(id)
  if(current?.provider!==request.provider||current?.model!==request.model)throw Error('聊天模型已变化，摘要未保存')
  const tree=parseForkTree(text,leaves,language,options),digest=forkHash([doc.revision,selected.map(r=>[r.seq,r.event])])
  const ids=tree.map(n=>'fork-'+forkHash([id,digest,n.index]).slice(0,24))
  const nodes=tree.map(n=>({id:ids[n.index],level:n.level,first:leaves[0].sources[0],last:leaves.at(-1).sources.at(-1),children:n.children.map(i=>ids[i]),summary:n.summary,
    sources:leaves.filter(l=>l.firstMessage>=n.firstMessage&&l.lastMessage<=n.lastMessage).flatMap(l=>l.sources)}))
  service.db.saveTree(id,nodes,owner,doc.revision,()=>readSettings(service.file).revision,selected,{provider:route.request.provider,model:route.request.model,usage})
  await service.onTreeSaved?.(id,nodes)
  return 'complete'
}

export async function withForkLease(path,id,revision,signal,run){
  const db=new ArchiveDatabase(path),owner=db.lease(id,revision)
  if(!owner){db.close();throw Error('DSH 已有后台摘要任务，原文保留')}
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const timer=setInterval(()=>{try{if(!db.renew(id,owner))controller.abort(Error('DSH 后台摘要已失去归属'))}catch(error){controller.abort(error)}},10000);timer.unref()
  try{return await run(combined)}finally{clearInterval(timer);db.release(id,owner);db.close()}
}
