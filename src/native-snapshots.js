// Versioned, immutable visible-message snapshots for native stores that can branch or mutate.
// These snapshots are the exact retained source; never claim byte-exact provenance to a live DB.
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const hash=x=>createHash('sha256').update(x).digest('hex')
function plain(content){if(typeof content==='string')return content;if(Array.isArray(content))return content.filter(p=>['text','input_text','output_text'].includes(p?.type)&&typeof p.text==='string').map(p=>p.text).join('\n');return ''}
function persistSnapshot(store,harness,id,title,rows,provenance){
 if(typeof id!=='string'||!id||id.length>200)throw Error('Invalid native conversation ID')
 const lines=rows.filter(x=>['user','assistant'].includes(x.role)).map(x=>({role:x.role,content:plain(x.content),native_id:x.native_id,provenance})).filter(x=>x.content.trim())
 if(!lines.length)throw Error('此对话暂无可见用户/助手文本')
 const raw=lines.map(x=>JSON.stringify(x)).join('\n')+'\n';if(Buffer.byteLength(raw)>32*1024*1024)throw Error('快照超过 32 MiB，请缩小来源')
 const digest=hash(raw),folder=join(store.dir,'native-snapshots');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,digest+'.jsonl')
 if(!existsSync(path))writeFileSync(path,raw,{flag:'wx',mode:0o600});else if(hash(readFileSync(path))!==digest)throw Error('Existing snapshot changed')
 const session=harness+'-'+hash(id).slice(0,16)+'-'+digest.slice(0,16);const result=store.ingest(session,path)
 store.setMetadata(session,{harness,externalId:id,name:title||id,nameSource:'native'})
 return {...result,source:store.metadata(session),summary_count:store.summaries(session).total,import_kind:'snapshot',note:'已保存可见消息的不可变快照；精确展开针对保留快照，不冒充实时原生库。未调用模型。'}
}
export function importPi(store,entry){
 if(statSync(entry.path).size>32*1024*1024)throw Error('Pi 单次快照文件超过 32 MiB')
 const raw=readFileSync(entry.path,'utf8');const records=raw.split('\n').slice(0,-1).map(line=>JSON.parse(line));const header=records.find(x=>x.type==='session');if(header?.id!==entry.conversation_id)throw Error('Pi source identity changed')
 const entries=records.filter(x=>x.type!=='session'&&x.id),byId=new Map(entries.map(x=>[x.id,x]));if(byId.size!==entries.length)throw Error('Duplicate Pi tree entry ID')
 let current=entries.at(-1);const chain=[],seen=new Set();while(current){if(seen.has(current.id))throw Error('Pi source branch cycle');seen.add(current.id);chain.push(current);if(current.parentId&&!byId.has(current.parentId))throw Error('Pi source branch has missing parent');current=current.parentId?byId.get(current.parentId):null}chain.reverse()
 const title=records.filter(x=>x.type==='session_info').at(-1)?.name||entry.name
 return persistSnapshot(store,'pi',header.id,title,chain.filter(x=>x.type==='message').map(x=>({role:x.message?.role,content:x.message?.content,native_id:x.id})),{kind:'pi-current-branch-snapshot',source:entry.path,session_id:header.id,leaf_id:entries.at(-1)?.id||null})
}
