import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {prepareRescueSource,rescuePacket} from './claude-rescue-source.js'
import {rescueHash,rescueSourceHash} from './claude-checkpoints.js'
import {checkedSummary} from './summary-policy.js'
import {summarySettingsRevision} from './summarize.js'
import {compactionDiagnostic} from './compaction-diagnostic.js'
import {rescueCancelled,revokeClaudeRescue} from './claude-rescue-cancellation.js'

function initialize(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS claude_compaction_rescues(
    session TEXT NOT NULL,node_id TEXT NOT NULL,claim_id TEXT NOT NULL,state TEXT NOT NULL,
    deadline_ms INTEGER NOT NULL,revision TEXT NOT NULL,preparation TEXT NOT NULL,
    summary TEXT,failed_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session,node_id));`)
}
const rowFor=(store,session,id)=>store.db.prepare('SELECT * FROM claude_compaction_rescues WHERE session=? AND node_id=?').get(session,id)
function valid(store,session,row,{claimId,deadline=true,cancelId}={}) {
  if(!row||!['generating','ready','saved'].includes(row.state)||claimId&&row.claim_id!==claimId||deadline&&row.state==='generating'&&Date.now()>=row.deadline_ms)return false
  const p=JSON.parse(row.preparation)
  if(rescueCancelled(store.dir,session,row.claim_id,p.cancelId,cancelId))return false
  if(!store.source(session)||store.isDeleted(session)||!store.integrationEnabled('claude-code')||!store.takeover().enabled||store.metadata(session).harness!=='claude-code')return false
  if(row.revision!==summarySettingsRevision(store,session)||p.settingHash!==rescueHash(store.takeover())||p.sourceHash!==rescueSourceHash(store,session,p.through))return false
  if(p.surfaceHash!==rescueSourceHash(store,session,Number.MAX_SAFE_INTEGER))return false
  for(const [id,hash] of p.childHashes)if(rescueHash(store.node(session,id)?.summary||'')!==hash)return false
  for(const e of store.eventRows(session).filter(e=>e.ordinal<=p.through))store.exact(session,e.ordinal)
  return !rescueCancelled(store.dir,session,row.claim_id,p.cancelId,cancelId)
}
function publish(store,session,row,cancelId) {
  if(!['ready','saved'].includes(row?.state)||!valid(store,session,row,{deadline:false,cancelId})||!row.summary)return {use:false}
  const p=JSON.parse(row.preparation),plan=rescuePacket(store,session,p,row.summary)
  if(!plan)return {use:false}
  // The ready output is durable before publishing its checkpoint. If a write
  // or response fails, this same output is reused on the next invocation.
  store.addNode({session,id:p.nodeId,level:p.level,first:0,last:p.through,children:p.children,summary:row.summary,digest:p.sourceHash,model:'claude-code-rescue:'+p.model},
    {validate:()=>valid(store,session,rowFor(store,session,p.nodeId),{deadline:false,cancelId})})
  store.db.prepare("UPDATE claude_compaction_rescues SET state='saved' WHERE session=? AND node_id=? AND claim_id=? AND state IN ('ready','saved')").run(session,p.nodeId,row.claim_id)
  store.noteCompaction(session,{...compactionDiagnostic(plan,{records:store.stats(session).records,before:p.tokens}),through:p.through,stage:'main-rescue',after:plan.after})
  if(row.state!=='saved')store.noteTakeover(session,p.tokens,plan.after)
  return plan
}
export function prepareClaudeRescue(store,session,input) {
  if(store.effectiveSetting(session).mode==='main-fork')return {use:false,reason:'Background branch mode only installs already prepared summaries'}
  initialize(store)
  if(rescueCancelled(store.dir,session,input.cancel_id))return {use:false}
  const src=store.source(session)
  if(!src||store.isDeleted(session)||!store.takeover().enabled||!store.integrationEnabled('claude-code')||store.metadata(session).harness!=='claude-code')return {use:false}
  if(existsSync(src.path))store.ingest(session,src.path)
  const work=prepareRescueSource(store,session,input)
  if(!work)return {use:false}
  const p=work.preparation,old=rowFor(store,session,p.nodeId)
  if(old&&valid(store,session,old,{deadline:false})&&['ready','saved'].includes(old.state))return publish(store,session,old,input.cancel_id)
  if(old?.state==='generating'&&Date.now()<old.deadline_ms||old?.failed_until>Date.now())return {use:false,busy:true}
  const claimId=randomUUID(),deadline=Date.now()+90000,revision=summarySettingsRevision(store,session)
  store.db.prepare(`INSERT INTO claude_compaction_rescues VALUES(?,?,?,?,?,?,?,NULL,0)
    ON CONFLICT(session,node_id) DO UPDATE SET claim_id=excluded.claim_id,state=excluded.state,deadline_ms=excluded.deadline_ms,revision=excluded.revision,preparation=excluded.preparation,summary=NULL,failed_until=0`)
    .run(session,p.nodeId,claimId,'generating',deadline,revision,JSON.stringify(p))
  return {work:{node_id:p.nodeId,claim_id:claimId,deadline_ms:deadline,input_hash:p.inputHash,model:p.model,system:work.system,prompt:work.prompt,task:work.task,maxTokens:work.maxTokens}}
}
export function checkClaudeRescue(store,session,input) {
  initialize(store)
  if(rescueCancelled(store.dir,session,input.cancel_id))return {use:false}
  const src=store.source(session);if(src&&existsSync(src.path))store.ingest(session,src.path)
  const row=rowFor(store,session,input.node_id)
  return {valid:!!row&&input.input_hash===JSON.parse(row.preparation).inputHash&&valid(store,session,row,{claimId:input.claim_id,cancelId:input.cancel_id})}
}
export function saveClaudeRescue(store,session,input) {
  initialize(store)
  if(rescueCancelled(store.dir,session,input.cancel_id))return {use:false}
  const src=store.source(session);if(src&&existsSync(src.path))store.ingest(session,src.path)
  let row=rowFor(store,session,input.node_id)
  if(!row||input.input_hash!==JSON.parse(row.preparation).inputHash||!valid(store,session,row,{claimId:input.claim_id,cancelId:input.cancel_id}))return {use:false}
  const p=JSON.parse(row.preparation)
  if(input.isAnswered!==true)return {use:false}
  const summary=checkedSummary(input.summary,{language:p.language,requireHeading:true,maxChars:60000,finishReason:input.finishReason})
  if(!rescuePacket(store,session,p,summary))return {use:false}
  if(row.summary&&row.summary!==summary)return {use:false}
  if(!row.summary){
    store.db.prepare("UPDATE claude_compaction_rescues SET summary=?,state='ready' WHERE session=? AND node_id=? AND claim_id=? AND state='generating'").run(summary,session,input.node_id,input.claim_id)
    row=rowFor(store,session,input.node_id)
  }
  return publish(store,session,row,input.cancel_id)
}
export function stopClaudeRescue(store,session,input) {
  revokeClaudeRescue(session,input,store.dir)
  initialize(store)
  store.db.prepare("UPDATE claude_compaction_rescues SET state='failed',failed_until=? WHERE session=? AND node_id=? AND claim_id=? AND state IN ('generating','ready')")
    .run(Date.now()+300000,session,input.node_id,input.claim_id)
  return {}
}
