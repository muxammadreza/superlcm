import {createHash} from 'node:crypto'
export const rescueHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')
export function rescueSourceHash(store,session,last) {
  return rescueHash(store.eventRows(session).filter(e=>e.ordinal<=last).map(e=>[e.ordinal,e.digest]))
}
// Rescue roots have both an exact raw range and the existing summary children.
// Their verified coverage is separate from ordinary leaf/merge depth.
export function claudeCheckpoints(store,session,cache=new Map()) {
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='claude_compaction_rescues'").get())return []
  const rows=store.db.prepare("SELECT n.*,r.preparation FROM claude_compaction_rescues r JOIN nodes n ON n.session=r.session AND n.id=r.node_id WHERE r.session=? AND r.state='saved'").all(session)
  return rows.flatMap(n=>{
    let p;try{p=JSON.parse(n.preparation)}catch{return []}
    if(!p||rescueSourceHash(store,session,n.last)!==p.sourceHash)return []
    return [{...n,checkpoint:true,rescueRequest:p.request||null,sourceIncomplete:store.nodeSourceIncomplete(session,n,new Set(),cache)}]
  })
}
export function claudeCompactionNodes(store,session) {
  const cache=new Map(),roots=claudeCheckpoints(store,session,cache),ids=new Set(roots.map(n=>n.id)),byId=new Map(roots.map(n=>[n.id,n]))
  return store.db.prepare('SELECT * FROM nodes WHERE session=?').all(session)
    .filter(n=>!n.id.startsWith('claude-rescue-')||ids.has(n.id))
    .map(n=>({...byId.get(n.id)||n,sourceIncomplete:store.nodeSourceIncomplete(session,n,new Set(),cache)}))
}

// A checkpoint can summarize old summary children and a directly read raw suffix.
// Expose that suffix as navigation ranges, without inventing nodes or changing edges.
export function claudeDirectSources(store,session,node) {
  if(!node.id.startsWith('claude-rescue-')||!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='claude_compaction_rescues'").get())return []
  const row=store.db.prepare("SELECT preparation FROM claude_compaction_rescues WHERE session=? AND node_id=? AND state='saved'").get(session,node.id)
  if(!row)return []
  const p=JSON.parse(row.preparation)
  if(rescueSourceHash(store,session,node.last)!==p.sourceHash)return []
  const children=Array.isArray(node.children)?node.children:JSON.parse(node.children)
  const ranges=children.map(id=>store.node(session,id)).filter(Boolean)
    .map(n=>({first:Math.max(node.first,n.first),last:Math.min(node.last,n.last)}))
    .filter(r=>r.first<=r.last).sort((a,b)=>a.first-b.first)
  let next=node.first;const direct=[]
  for(const r of ranges){if(r.first>next)direct.push({first:next,last:r.first-1});next=Math.max(next,r.last+1)}
  if(next<=node.last)direct.push({first:next,last:node.last})
  return direct
}
