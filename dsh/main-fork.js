import { CHECKPOINT_PREAMBLE } from './checkpoint-frame.js'
import {forkScope} from './fork-scope.js'
export {forkScope} from './fork-scope.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { prepareAsyncRegion } from './async-region.js'
import { appendRecallEnvelope } from './marker.js'
import { completeSummaryStream } from './summary-session.js'
import { summaryAttempt } from './summary-attempt.js'
import {forkRoute} from './fork-route.js'
import {abortable} from './summary-attempt.js'
import { currentPolicy } from './ratio-runtime.js'
import { draftNode, assembleTree } from './draft-tree.js'
import { forkDirective, forkAnchors, forkHash, parseForkTree } from './fork-summary.js'
import { reindexSession, nodeLevel } from './core.js'
import {publishForkArchive,withForkLease,forkArchiveSnapshot} from './archive-fork.js'
import {assembleRegions} from './assembled-region.js'
import {markerFromSummary} from './marker.js'
import { dshSummaryLanguage } from './dsh-summary-language.js'

export function captureMainRequest(engine, agent, options) {
  engine.mainRequests ??= new WeakMap()
  const {signal, ...request} = options
  engine.mainRequests.set(agent, {request: structuredClone(request), generation: engine.runtimeGeneration})
}
export async function summarizeMainFork(engine, agent, prepared, signal) {
  const capture = engine.mainRequests?.get(agent), policy = currentPolicy(engine, agent)
  if (!capture || capture.generation !== engine.runtimeGeneration) throw Error('DSH 尚未捕获当前模型的原始请求')
  if (!Number.isFinite(policy?.inputBudget)) throw Error('主模型分支需要按模型容量管理压缩')
  const indexed = reindexSession(engine.superLcmStore,agent.session)
  if (indexed.errors.length) throw Error('DSH 原文归档未完成')
  const route=await summaryAttempt(async abort=>{
    if(engine.rollingConfig.forkModelOverride)await abortable(engine.summaryModelReady,abort)
    return forkRoute(engine.rollingConfig.forkModelOverride?(engine.summaryContext||engine.ctx):engine.ctx,capture.request,{enabled:engine.rollingConfig.forkModelOverride,provider:engine.config.summarizationProvider,model:engine.config.summarizationModel},abort)
  },signal,15000)
  const request = route.request, byId = new Map(request.messages.map((message,index)=>[message.id,{message,index}]))
  const parts = []; let from = 0, tokens = 0
  for (let i = 0; i < prepared.shadowedSeqs.length; i++) {
    tokens += prepared.selectedNodes[i].tokens
    if ((tokens < policy.foldBatchTokens || !toolPairingBalancedAfter(agent.session, prepared.shadowedSeqs[i])) && i < prepared.shadowedSeqs.length - 1) continue
    const part = prepareAsyncRegion(engine,agent,{start:prepared.shadowedSeqs[from],end:prepared.shadowedSeqs[i]})
    const originals = part.shadowedSeqs.map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)
    const positions = originals.map(message=>{
      const found = byId.get(message.id)
      if (!found || !isDeepStrictEqual(found.message,message)) throw Error('DSH 原始请求与归档选区不同，无法原样分支')
      return found.index
    })
    if (!positions.length || positions.some((n,index)=>index && n !== positions[index-1]+1)) throw Error('DSH 后台分块缺少连续原文')
    parts.push({...part,range:{index:parts.length,firstMessage:positions[0],lastMessage:positions.at(-1),...forkAnchors(originals)}})
    from = i+1; tokens = 0
  }
  const plan = parts.map(part=>part.range), target = Math.max(256,Math.min(Math.floor(policy.summaryPrefixTargetTokens*.7),Math.floor((request.maxTokens||16384)*.65)))
  const treeOptions={fanout:policy.condensedMinFanout||4,targetTokens:target}
  const language=dshSummaryLanguage(agent.session)
  const directive = forkDirective(plan,target,language.name,treeOptions)
  const directiveTokens = engine.ctx.tokenMeter.estimateMessage(createUserMessage({content:[{type:'text',text:directive}]}))
  if (prepared.activeTokens + directiveTokens >= Math.min(policy.inputBudget,route.inputBudget??Infinity) - 1024) throw Error('DSH 后台分支没有足够输入空间，原文保留')
  const options = {...request,messages:[...request.messages,createUserMessage({content:[{type:'text',text:directive}]})]}
  const archiveSnapshot=forkArchiveSnapshot(engine.superLcmStore.path)
  const raw = [], usage = {}; let text = ''
  await withForkLease(engine.superLcmStore.path,agent.session.id,policy.signature||'main-fork',signal,leasedSignal=>summaryAttempt(abort=>forkScope.run(true,async()=>{
    for await (const chunk of completeSummaryStream(route.ctx.llm.stream({...options,signal:abort}),abort)) {
      raw.push(chunk)
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') Object.assign(usage,chunk.usage)
    }
  }),leasedSignal,policy.summaryTimeoutMs))
  signal?.throwIfAborted()
  const blocks = parseForkTree(text,plan,language,treeOptions),built=[]
  for(const block of blocks){
    const children=block.children.map(i=>built[i])
    const part=block.level===0?parts[block.index]:assembleRegions(engine,children)
    const childIds=block.level===0?part.trustedChildNodeIds:children.map(p=>markerFromSummary(p.summary).id)
    const compactionId=randomUUID()
    const summary=appendRecallEnvelope([{type:'text',text:block.summary}],{id:randomUUID(),children:childIds})
    const checkpointMessage=createUserMessage({content:[{type:'text',text:CHECKPOINT_PREAMBLE+'\n\n<compacted-summary>'},...summary,{type:'text',text:'</compacted-summary>'}],source:compactCheckpointSource(compactionId)})
    built.push({...part,summary,checkpointMessage,compactionId,provider:request.provider,model:request.model,
      trustedChildNodeIds:childIds,treeKind:block.level?'condensed':'leaf',
      usage:block.index===0?usage:{},depth:block.level===0?1+Math.max(0,...childIds.map(id=>nodeLevel(engine.superLcmStore,agent.session.id,id))):1+Math.max(...children.map(p=>p.depth)),rawOutput:block.index===0?raw:undefined})
  }
  built.at(-1).usage=usage;built.at(-1).rawOutput=raw
  const tree=built.map(draftNode),frontier=[built.at(-1)]
  const summarized=assembleTree(engine,frontier,tree,parts.length)
  const archiveTree=blocks.map((block,index)=>({id:'fork-'+tree[index].nodeId,level:block.level,summary:block.summary,
    sources:built[index].shadowedSeqs,children:block.children.map(i=>'fork-'+tree[i].nodeId)}))
  if (engine.ctx.tokenMeter.estimateMessage(summarized.checkpointMessage)>policy.summaryPrefixTargetTokens) throw Error('DSH 后台分支摘要超过预算，保留原文')
  try{await publishForkArchive(engine.superLcmStore.path,agent.session.id,archiveTree,{provider:request.provider,model:request.model,usage},archiveSnapshot)}catch(error){engine.ctx.logger?.warn?.('后台摘要归档待重试：'+error.message)}
  return {...summarized,forkParts:frontier,forkLeafCount:parts.length,rawOutput:raw,usage,prefixHash:forkHash(request.messages),mainFork:true}
}
