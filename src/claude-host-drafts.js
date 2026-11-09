import {rescueHash} from './claude-checkpoints.js'

function initialize(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS claude_host_drafts(
    session TEXT NOT NULL,batch_id TEXT NOT NULL,revision TEXT NOT NULL,claim_id TEXT NOT NULL,
    proof TEXT NOT NULL,summary TEXT NOT NULL,model TEXT NOT NULL,overshoot REAL,
    PRIMARY KEY(session,batch_id,revision));`)
}
const proof=work=>rescueHash([work.level,work.first,work.last,work.children,work.digest])
export function hostDraft(store,session,work,revision) {
  initialize(store)
  const row=store.db.prepare('SELECT * FROM claude_host_drafts WHERE session=? AND batch_id=? AND revision=?').get(session,work.batch_id,revision)
  return row&&row.proof===proof(work)?{summary:row.summary,model:row.model,overshoot:row.overshoot}:null
}
export function retainHostDraft(store,session,work,claim,input,summary) {
  initialize(store)
  const result=store.db.prepare(`INSERT INTO claude_host_drafts SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sources WHERE session=?) AND NOT EXISTS(SELECT 1 FROM deleted_sessions WHERE session=?)
    ON CONFLICT(session,batch_id,revision) DO UPDATE SET claim_id=excluded.claim_id,proof=excluded.proof,summary=excluded.summary,model=excluded.model,overshoot=excluded.overshoot`)
    .run(session,work.batch_id,claim.revision,claim.claim_id,proof(work),summary,String(input.model||'configured').slice(0,80),Number.isFinite(input.overshoot)?input.overshoot:null,session,session)
  if(!result.changes)throw Error('Conversation was deleted; summary not saved')
}
// A lost process receipt must not require a new lease or buy a new summary.
// It only acknowledges this exact output of the exact original claim.
export function hostSavedReceipt(store,session,input,revision) {
  initialize(store)
  const draft=store.db.prepare('SELECT * FROM claude_host_drafts WHERE session=? AND batch_id=? AND revision=? AND claim_id=?').get(session,input.batch_id,revision,input.claim_id||'')
  if(!draft||draft.summary!==input.summary||draft.model!==String(input.model||'configured').slice(0,80))return false
  const node=store.node(session,input.batch_id)
  return !!node&&node.summary===draft.summary&&draft.proof===proof({...node,batch_id:node.id,children:JSON.parse(node.children)})
}
