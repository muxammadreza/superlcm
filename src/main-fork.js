import {randomUUID} from 'node:crypto'
import {summaryEvents} from './summary-source.js'
import {detectSummaryLanguage,userTextFromRecord} from './summary-language.js'
import {estimateSummaryTokens} from './summary-tokens.js'
import {summarySettingsRevision} from './summarize.js'
import {forkHash,forkAnchors,forkTreePlan,forkDirective,parseForkTree} from './fork-summary.js'
import {summarizeNativeFork} from './native-fork.js'
import {claudeCompactAt} from './takeover.js'
import {bindSummaryRun,finishSummaryRun,progressSummaryRun,summaryRunOwns,enqueueSummaryRun,reserveSummaryRun,recoverSummaryRuns,summaryConcurrency} from './summary-runs.js'

export function nativeContextUsage(store,session,provided={}){
  if(provided.tokens>0&&provided.window>0)return provided
  const rows=store.db.prepare('SELECT ordinal FROM events WHERE session=? ORDER BY ordinal DESC LIMIT 512').all(session)
  for(const row of rows){
    let record;try{record=JSON.parse(store.exact(session,row.ordinal))}catch{continue}
    const info=record.payload?.info,usage=info?.last_token_usage??record.message?.usage
    const window=info?.model_context_window??record.context_window??usage?.context_window
    if(!usage||!Number.isFinite(window)||window<=0)continue
    const tokens=usage.input_tokens+(usage.output_tokens||0)+(info?0:(usage.cache_read_input_tokens||0)+(usage.cache_creation_input_tokens||0))
    if(Number.isFinite(tokens)&&tokens>0)return {tokens,window}
  }
  return {tokens:0,window:0}
}
export function forkPreparationThreshold(store,session,window,env=process.env){
  const policy=store.takeover()
  // Ten points before where Claude Code compacts (its window may be capped below the model's).
  if(store.metadata(session).harness==='claude-code'&&policy.ratio!=null)return claudeCompactAt({...policy,ratio:Math.round((policy.ratio-.1)*1e12)/1e12},window,env)
  return store.metadata(session).harness==='claude-code'&&policy.enabled?Math.min(window*.7,policy.window*.7/.8):window*.7
}
function anchor(raw){
  try{
    const r=JSON.parse(raw),m=r.message??r.payload??r
    return forkAnchors([{content:m.content??m.message??m.text??''}])
  }catch{return {firstAnchor:'',lastAnchor:''}}
}
export function planMainFork(store,session,{keepTokens=40000,force=false,env=process.env}={}){
  const done=store.nodeRows(session,0),start=done.length?Math.max(...done.map(n=>n.last))+1:0
  const all=summaryEvents(store,session,start),tuning=store.tuning()
  if(!all.length)return null
  const sizes=all.map(e=>estimateSummaryTokens(e.summaryText)),total=sizes.reduce((a,b)=>a+b,0)
  let remaining=total,cut=-1,pending=new Set()
  for(let i=0;i<all.length;i++){
    remaining-=sizes[i]
    const p=all[i].toolPairing
    if(p.endsTurn)pending.clear()
    for(const id of p.opened)pending.add(id)
    for(const id of p.closed)pending.delete(id)
    if(!pending.size&&(remaining>=keepTokens||force&&total<=keepTokens))cut=i
  }
  if(cut<0)return null
  const selected=all.slice(0,cut+1),leaves=[]
  let first=0,size=0;pending=new Set()
  function add(last){
    const visible=selected.slice(first,last+1).filter(e=>e.summaryText.trim())
    if(visible.length){const a=anchor(store.exact(session,visible[0].ordinal)),b=anchor(store.exact(session,visible.at(-1).ordinal));leaves.push({index:leaves.length,firstMessage:selected[first].ordinal,lastMessage:selected[last].ordinal,firstAnchor:a.firstAnchor,lastAnchor:b.lastAnchor})}
    first=last+1;size=0
  }
  for(let i=0;i<selected.length;i++){
    const p=selected[i].toolPairing;if(p.endsTurn)pending.clear()
    for(const id of p.opened)pending.add(id);for(const id of p.closed)pending.delete(id)
    size+=estimateSummaryTokens(selected[i].summaryText)
    if(!pending.size&&(size>=(tuning.target_tokens||Math.floor(tuning.target_chars/4))||i===selected.length-1))add(i)
  }
  if(!leaves.length)return null
  const originals=selected.map(e=>({ordinal:e.ordinal,digest:e.digest})),digest=forkHash(originals),language=detectSummaryLanguage(selected.map(e=>userTextFromRecord(store.exact(session,e.ordinal))))
  const targetTokens=Math.min(12000,Math.max(2048,Math.floor(total*.1)))
  return {leaves,digest,originals,language,targetTokens,fanout:tuning.fanout,revision:summarySettingsRevision(store,session,env),tree:forkTreePlan(leaves,tuning.fanout)}
}
export function saveForkTree(store,session,plan,tree,{model,usage={},branchId=null,owner,validate=()=>true}={}){
  store.db.exec('BEGIN IMMEDIATE')
  try{
    if(!validate()||owner&&!store.ownsLease(session,owner))throw Error('摘要配置或任务归属已变化，结果未保存')
    for(const row of plan.originals){store.exact(session,row.ordinal);if(store.db.prepare('SELECT digest FROM events WHERE session=? AND ordinal=?').get(session,row.ordinal)?.digest!==row.digest)throw Error('摘要原文已变化，结果未保存')}
    const ids=tree.map(n=>n.archiveId||'s'+n.level+'-'+forkHash([session,plan.digest,n.index,n.summary]).slice(0,24))
    for(const node of tree){
      const inserted=store.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(session,ids[node.index],node.level,node.firstMessage,node.lastMessage,JSON.stringify(node.children.map(i=>ids[i])),node.summary,plan.digest,model)
      if(node.sourceRecords){
        store.db.exec('CREATE TABLE IF NOT EXISTS dsh_node_sources(session TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session,id,seq))')
        for(const seq of node.sourceRecords){if(!plan.originals.some(r=>r.ordinal===seq)||seq<node.firstMessage||seq>node.lastMessage)throw Error('摘要来源不属于当前分支');store.db.prepare('INSERT OR IGNORE INTO dsh_node_sources VALUES(?,?,?)').run(session,ids[node.index],seq)}
      }
      if(inserted.changes)store.db.prepare('INSERT INTO node_fts(session,id,summary) VALUES(?,?,?)').run(session,ids[node.index],node.summary)
    }
    store.db.exec('CREATE TABLE IF NOT EXISTS fork_summary_receipts(session TEXT PRIMARY KEY,digest TEXT NOT NULL,branch TEXT,model TEXT,usage TEXT NOT NULL,at_ms INTEGER NOT NULL)')
    store.db.prepare('INSERT OR REPLACE INTO fork_summary_receipts VALUES(?,?,?,?,?,?)').run(session,plan.digest,branchId,model,JSON.stringify(usage),Date.now())
    store.db.exec('COMMIT');return ids
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
export async function generateMainFork(store,session,{runId,signal,shouldContinue=()=>true,env=process.env,summarize=summarizeNativeFork,force=true,queuedPlan=null,explicit=false}={}){
  const meta=store.metadata(session)
  if(!['claude-code','codex'].includes(meta.harness))throw Error('此工具的分支由运行中的宿主准备')
  const plan=queuedPlan||planMainFork(store,session,{force,env}),owner='fork:'+randomUUID()
  if(!plan){if(runId)finishSummaryRun(store,runId,{state:'done',reason:'no-closed-source'});return {session,created:0}}
  if(runId&&!bindSummaryRun(store,runId,{owner,pid:process.pid}))return {session,busy:true}
  if(!store.lease(session,240000,owner)){if(runId)finishSummaryRun(store,runId,{owner,state:'stopped',reason:'busy'});return {session,busy:true}}
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const valid=()=>shouldContinue()&&(explicit||store.integrationEnabled(meta.harness))&&(explicit||store.effectiveSetting(session,env).mode==='main-fork')&&summarySettingsRevision(store,session,env)===plan.revision&&(!runId||summaryRunOwns(store,runId,owner))
  const timer=setInterval(()=>{if(!valid()||!store.renewLease(session,240000,owner))controller.abort(Error('后台分支摘要已取消'));else if(runId)progressSummaryRun(store,runId,owner)},10000);timer.unref()
  try{
    if(!valid())throw Error('后台分支配置已变化')
    for(const row of plan.originals){store.exact(session,row.ordinal);if(store.db.prepare('SELECT digest FROM events WHERE session=? AND ordinal=?').get(session,row.ordinal)?.digest!==row.digest)throw Error('后台分支原文已变化')}
    const result=await summarize(meta.harness,meta.conversation_id,forkDirective(plan.leaves,plan.targetTokens,plan.language.name,{fanout:plan.fanout}),{env,signal:combined,...(store.harnessSetting(meta.harness)?.mode==='main-fork'&&store.harnessSetting(meta.harness)?.model?{model:store.harnessSetting(meta.harness).model}:{})})
    combined.throwIfAborted()
    const tree=parseForkTree(result.text,plan.leaves,plan.language,{fanout:plan.fanout,targetTokens:plan.targetTokens})
    const ids=saveForkTree(store,session,plan,tree,{...result,owner,validate:valid})
    store.completeSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'ok');if(runId){progressSummaryRun(store,runId,owner,{created:ids.length});finishSummaryRun(store,runId,{owner,state:'done'})}
    return {session,created:ids.length,calls:1,branch:result.branchId}
  }catch(error){if(!combined.aborted)store.failSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'summary_failed');if(runId)finishSummaryRun(store,runId,{owner,state:combined.aborted?'stopped':'failed',error});throw error}
  finally{clearInterval(timer);store.release(session,owner)}
}
// 主模型分支 inside Claude Code (hooks/compact-mod.js): the module answers the plan with $.model.fork, which
// resends the main thread's own last request, so the history is read from its prompt cache. The claim holds
// the 'host' lease for longer than the module waits on the fork; only the matching claim saves or releases it.
const HOST_FORK_LEASE_MS=900000
function hostForkPlan(store,session,input){
  if(typeof input?.run_id!=='string'||typeof input.claim_id!=='string'||!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='fork_summary_plans'").get())return null
  const row=store.db.prepare('SELECT f.plan FROM fork_summary_plans f JOIN summary_runs r ON r.id=f.run_id WHERE f.run_id=? AND r.session=?').get(input.run_id,session)
  const plan=row&&JSON.parse(row.plan)
  return plan?.claim===input.claim_id?plan:null
}
export function claimHostFork(store,session,{env=process.env}={}){
  recoverSummaryRuns(store,{env})
  if(store.summarizing(session))return {none:'busy'}
  const plan=planMainFork(store,session,{env})
  if(!plan)return {none:'no-closed-source'}
  if(store.summaryRetry(session,plan.digest,plan.revision))return {none:'retry-backoff'}
  const queued=enqueueSummaryRun(store,session,{route:'host',origin:'host',revision:plan.revision,planned:plan.tree.length})
  if(!queued.added)return {none:'busy'}
  if(!reserveSummaryRun(store,{id:queued.run.id,limit:summaryConcurrency(env)})){finishSummaryRun(store,queued.run.id,{state:'stopped',reason:'capacity'});return {none:'capacity'}}
  const claim=randomUUID(),owner='host:'+claim
  if(!store.lease(session,HOST_FORK_LEASE_MS,'host')){finishSummaryRun(store,queued.run.id,{state:'stopped',reason:'busy'});return {none:'busy'}}
  store.db.prepare('INSERT INTO host_summary_claims(session,batch_id,revision,claim_id,leaf_only,deadline_ms,run_id) VALUES(?,?,?,?,0,0,?) ON CONFLICT(session) DO UPDATE SET batch_id=excluded.batch_id,revision=excluded.revision,claim_id=excluded.claim_id,leaf_only=0,deadline_ms=0,run_id=excluded.run_id').run(session,plan.digest,plan.revision,claim,queued.run.id)
  store.db.exec('CREATE TABLE IF NOT EXISTS fork_summary_plans(run_id TEXT PRIMARY KEY,plan TEXT NOT NULL)')
  store.db.prepare('INSERT OR REPLACE INTO fork_summary_plans VALUES(?,?)').run(queued.run.id,JSON.stringify({...plan,claim}))
  if(!bindSummaryRun(store,queued.run.id,{owner})){store.releaseHostClaim(session,claim);store.db.prepare('DELETE FROM fork_summary_plans WHERE run_id=?').run(queued.run.id);return {none:'run-replaced'}}
  progressSummaryRun(store,queued.run.id,owner,{first:plan.leaves[0].firstMessage,last:plan.leaves.at(-1).lastMessage})
  return {run_id:queued.run.id,claim_id:claim,directive:forkDirective(plan.leaves,plan.targetTokens,plan.language.name,{fanout:plan.fanout})}
}
// Settles a claim: saves the tree when the fork answered, otherwise stops (or fails) the run.
// Returns handoff when the separate `claude --resume` branch should try instead.
export function settleHostFork(store,session,input,{env=process.env}={}){
  const plan=hostForkPlan(store,session,input)
  if(!plan)return {saved:false,reason:'unknown claim'}
  const runId=input.run_id,owner='host:'+plan.claim,ours=summaryRunOwns(store,runId,owner)
  const valid=()=>store.integrationEnabled('claude-code')&&store.effectiveSetting(session,env).mode==='main-fork'&&summarySettingsRevision(store,session,env)===plan.revision&&summaryRunOwns(store,runId,owner)&&store.ownsLease(session,'host')
  try{
    if(typeof input.text!=='string'){
      // nothing-to-fork: this Claude Code process has no main-thread request yet; unsupported: it has no
      // $.model.fork, so later turns go to `claude --resume` as well. A failed fork waits for backoff.
      const failed=['api-error','empty-reply','timeout','error'].includes(input.reason)
      if(failed)store.failSummaryBatch(session,plan.digest,plan.revision)
      if(input.reason==='unsupported')store.setHostForker(session,false)
      finishSummaryRun(store,runId,{owner,state:failed?'failed':'stopped',reason:'host-fork-'+String(input.reason||'unanswered').slice(0,40),...(failed?{error:Error('Main-thread fork returned no summary; originals retained')}:{})})
      return {saved:false,handoff:['nothing-to-fork','unsupported'].includes(input.reason)}
    }
    if(!valid())throw Object.assign(Error('后台分支配置已变化'),{summaryKind:'cancelled'})
    const tree=parseForkTree(input.text,plan.leaves,plan.language,{fanout:plan.fanout,targetTokens:plan.targetTokens})
    const ids=saveForkTree(store,session,plan,tree,{model:'claude-code-fork:'+String(input.model||'session-model').slice(0,80),usage:input.usage&&typeof input.usage==='object'?input.usage:{},owner:'host',validate:valid})
    store.completeSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'ok')
    progressSummaryRun(store,runId,owner,{created:ids.length});finishSummaryRun(store,runId,{owner,state:'done'})
    return {saved:true,created:ids.length}
  }catch(error){
    const cancelled=error.summaryKind==='cancelled'
    if(!cancelled){store.failSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'summary_failed')}
    finishSummaryRun(store,runId,{owner,state:cancelled?'stopped':'failed',error})
    return {saved:false}
  }finally{
    if(ours)store.releaseHostClaim(session,plan.claim)
    store.db.prepare('DELETE FROM fork_summary_plans WHERE run_id=?').run(runId)
  }
}
