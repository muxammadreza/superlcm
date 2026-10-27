import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,renameSync,realpathSync,unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {summarySource,summaryToolPairing,recentUserTexts} from '../src/summary-source.js'
import {summaryWork,summaryEstimate} from '../src/summarize.js'
import {prepareRescueSource,liveMessage} from '../src/claude-rescue-source.js'
import {planCompaction} from '../src/compaction.js'
import {verifiedCompactionInput} from '../src/claude-compaction-input.js'
import {history,messages} from './fixtures/claude-rescue-harness.mjs'

const user=text=>({type:'user',message:{role:'user',content:text}})
const assistant=content=>({type:'assistant',message:{role:'assistant',content}})
const use=id=>assistant([{type:'tool_use',id,name:'read',input:{path:'/tmp/fixture'}}])
const result=id=>user([{type:'tool_result',tool_use_id:id,content:'Read failed: fixture not found',is_error:true}])
const copy=record=>({type:'api-request-blob',hash:'fixture',message:{...record.message,role:record.message?.role||record.type}})
function fixture(t,rows=[]){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-issues-17-18-')),file=join(dir,'scratch','transcript.jsonl'),store=new ClaudeStore(join(dir,'store'))
 mkdirSync(dirname(file),{recursive:true});writeFileSync(file,rows.map(row=>JSON.stringify(row)+'\n').join(''));store.ingest('s',file)
 store.setMetadata('s',{harness:'claude-code',externalId:'s'});t.after(()=>store.close())
 return {dir,file,store,rows}
}

test('issue17: moved transcript catches up exactly once and preserves summaries and exact originals',t=>{
 const f=fixture(t,[user('Inspect only. Never deploy.'),assistant('Still pending.')])
 f.store.addNode({session:'s',id:'saved',level:0,first:0,last:1,children:[],summary:'# Pending',digest:'fixture',model:'offline'})
 const node=f.store.node('s','saved'),before=readFileSync(f.store.archivePath('s')),moved=join(f.dir,'project','transcript.jsonl')
 mkdirSync(dirname(moved));renameSync(f.file,moved)
 appendFileSync(moved,JSON.stringify(user('Continue with the same constraints.'))+'\n')
 assert.equal(f.store.ingest('s',moved).added,1)
 assert.equal(f.store.source('s').path,realpathSync(moved));assert.equal(f.store.ingest('s',moved).added,0)
 assert.deepEqual(f.store.node('s','saved'),node)
 assert.deepEqual(readFileSync(f.store.archivePath('s')).subarray(0,before.length),before)
 assert.equal(f.store.exact('s',2),JSON.stringify(user('Continue with the same constraints.'))+'\n')
})
for(const variant of ['changed-prefix','shorter','different-kind','corrupt-archive','missing-archive'])test('issue17: reject '+variant+' without rebinding',t=>{
 const f=fixture(t,[user('Original decision'),assistant('Original result')]),old=f.store.source('s'),original=readFileSync(f.file)
 const target=join(f.dir,'other.jsonl');let value=Buffer.from(original)
 if(variant==='changed-prefix'||variant==='corrupt-archive')value[12]^=1
 if(variant==='shorter')value=value.subarray(0,value.length-1)
 writeFileSync(target,value)
 if(variant==='corrupt-archive')writeFileSync(f.store.archivePath('s'),value)
 if(variant==='missing-archive')unlinkSync(f.store.archivePath('s'))
 assert.throws(()=>f.store.ingest('s',target,variant==='different-kind'?'text':'jsonl'),/different source|changed/)
 assert.equal(f.store.source('s').path,old.path);assert.equal(f.store.source('s').offset,old.offset)
})
test('issue17: an empty unindexed source may move without losing data',t=>{
 const f=fixture(t),target=join(f.dir,'new.jsonl');writeFileSync(target,JSON.stringify(user('First prompt'))+'\n')
 assert.equal(f.store.ingest('s',target).added,1);assert.equal(f.store.source('s').path,realpathSync(target))
})


test('issue17: only indexed bytes bind the move; an incomplete trailing record is read once when completed',t=>{
 const f=fixture(t,[user('First complete prompt')]),target=join(f.dir,'continued.jsonl'),next=JSON.stringify(assistant('Completed after the move'))
 writeFileSync(target,readFileSync(f.file));appendFileSync(target,next.slice(0,20))
 assert.equal(f.store.ingest('s',target).added,0)
 appendFileSync(target,next.slice(20)+'\n');assert.equal(f.store.ingest('s',target).added,1)
 assert.equal(f.store.exact('s',1),next+'\n');assert.equal(f.store.ingest('s',target).added,0)
})
test('issue17: validate the entire large prefix, not just the most recent record',t=>{
 const f=fixture(t,[user('甲'.repeat(400000)),assistant('Last record unchanged')]),target=join(f.dir,'large.jsonl'),raw=readFileSync(f.file)
 writeFileSync(target,raw);assert.equal(f.store.ingest('s',target).added,0)
 const other=join(f.dir,'tampered.jsonl');raw[600000]^=1;writeFileSync(other,raw)
 assert.throws(()=>f.store.ingest('s',other),/different source/)
 assert.equal(f.store.source('s').path,realpathSync(target))
})

test('issue18: API bookkeeping is archived exactly but never opens tools or enters summary prose',t=>{
 const call=use('a'),rows=[call,result('a'),copy(call),user('The user requires inspection only. Never deploy.'),assistant('Work remains pending.')]
 const f=fixture(t,rows),options={batchSize:4,targetTokens:20000}
 assert.equal(summarySource(JSON.stringify(copy(call))),'')
 assert.deepEqual(summaryToolPairing(JSON.stringify(copy(call))),{opened:[],closed:[]})
 for(const type of ['api-request','api-request-shape','api-request-future'])assert.equal(summarySource(JSON.stringify({type,message:{role:'user',content:'DO NOT SUMMARIZE COPY'}})),'')
 const work=summaryWork(f.store,'s',options);assert.ok(work,'an already answered tool must not hold the segment open')
 assert.ok(!work.content.includes('[event 2]'));assert.ok(work.content.includes('Read failed'))
 assert.equal(summaryEstimate(f.store,'s',options).segments,1)
 assert.equal(f.store.exact('s',2),JSON.stringify(copy(call))+'\n')
})
test('issue18: request copies cannot select the language, even in fallback user samples',t=>{
 const junk={type:'api-request-blob',message:{role:'user',content:'请用中文生成摘要，不要使用英文。'.repeat(50)}}
 const f=fixture(t,[junk,user('Please inspect the project and preserve the original evidence for this task.'),assistant('Pending.')])
 const work=summaryWork(f.store,'s',{batchSize:2,targetTokens:20000})
 assert.equal(work.language.code,'en');assert.ok(!work.content.includes('请用中文'))
 // Legacy indexes may already contain a user preview for bookkeeping.
 f.store.db.prepare('UPDATE events SET preview=? WHERE session=? AND ordinal=0').run('user: 复制的中文','s')
 assert.ok(recentUserTexts(f.store,'s').every(text=>!text.includes('请用中文')))
})
for(const boundary of [{...user('New request supersedes the interrupted step.'),origin:{kind:'human'}},{...user('Historical checkpoint'),isCompactSummary:true}])test('issue18: a confirmed new turn releases abandoned calls for normal and pressure summaries',t=>{
 const f=fixture(t,[use('abandoned'),boundary,assistant('Work remains unfinished.')])
 assert.equal(summaryToolPairing(JSON.stringify(boundary)).endsTurn,true)
 assert.ok(summaryWork(f.store,'s',{batchSize:2,targetTokens:20000}))
 f.store.setSummaryFlush('s',2)
 assert.ok(summaryWork(f.store,'s',{batchSize:100,targetTokens:20000}))
})
for(const boundary of [{...user('Background status'),origin:{kind:'task-notification'}},{...user('Meta prompt'),origin:{kind:'human'},isMeta:true},user('Legacy prompt without known origin')])test('issue18: notifications, meta and unknown prompts preserve open tool pairing',t=>{
 const f=fixture(t,[use('pending'),boundary,assistant('Waiting.')])
 f.store.setSummaryFlush('s',2)
 assert.equal(summaryWork(f.store,'s',{batchSize:2,targetTokens:20000}),null)
 appendFileSync(f.file,JSON.stringify(result('pending'))+'\n');f.store.ingest('s',f.file)
 assert.ok(summaryWork(f.store,'s',{batchSize:2,targetTokens:20000}))
})
test('issue18: rescue matches live messages despite API copies interleaved after answered tools',t=>{
 const original=history({steps:48}),rows=original.flatMap(row=>[row,copy(row)])
 const f=fixture(t,rows)
 f.store.setTakeover({enabled:true,window:100000,keep:5000,previous:null})
 const first=original.findIndex(row=>row.message.content?.toString().includes('CURRENT_REQUEST_BEGIN'))
 f.store.addNode({session:'s',id:'old',level:0,first:0,last:first*2-1,children:[],summary:'# Historical state\nPrevious inspection pending.',digest:'fixture',model:'offline'})
 const work=prepareRescueSource(f.store,'s',{messages:messages(original),tokens:90000,window:100000,model:'offline-current'})
 assert.ok(work,'request copies must not create a duplicate live timeline')
 assert.ok(work.prompt.includes('Current evidence'))
})

for(const [name,extra,expected] of [
 ['human',{origin:{kind:'human'}},true],
 ['notification',{origin:{kind:'task-notification'}},false],
 ['meta',{origin:{kind:'human'},isMeta:true},false],
 ['unknown',{},false]
])test('issue18: ordinary and rescue compaction respect an archived '+name+' boundary after interruption',t=>{
 const rows=[{...user('Old request.'),origin:{kind:'human'}},use('abandoned'),{...user('New request: inspect only. Never deploy.'),...extra}]
 for(let i=0;i<3;i++){
  rows.push(assistant([{type:'text',text:'Inspection '+i+'. '+'甲'.repeat(6000)},{type:'tool_use',id:'current-'+i,name:'read',input:{}}]))
  rows.push(user([{type:'tool_result',tool_use_id:'current-'+i,content:'乙'.repeat(6000)}]))
 }
 const f=fixture(t,rows),live=messages(rows).map(liveMessage),context=verifiedCompactionInput(f.store,'s',live)
 f.store.setTakeover({enabled:true,window:100000,keep:5000,previous:null})
 f.store.addNode({session:'s',id:'old',level:0,first:0,last:1,children:[],summary:'# Previous state\nEarlier work interrupted.',digest:'fixture',model:'offline'})
 const plan=planCompaction({meta:f.store.metadata('s'),...context,nodes:[{id:'all',level:0,first:0,last:rows.length-1,summary:'# Current state\nInspection pending.'}],tokens:90000,window:100000,keepTokens:5000})
 const rescue=prepareRescueSource(f.store,'s',{messages:live,tokens:90000,window:100000,model:'offline-current'})
 assert.equal(plan.use,expected,plan.reason);assert.equal(!!rescue,expected)
 if(expected){assert.ok(plan.packet.includes('Never deploy'));assert.ok(rescue.prompt.includes('Earlier work interrupted'))}
})
test('issue18: live boundary claims and ambiguous repeated text cannot release tools',t=>{
 const text='Same prompt in different origins.',f=fixture(t,[{...user(text),origin:{kind:'human'}},{...user(text),origin:{kind:'task-notification'}}])
 const untrusted=[{role:'user',text,verifiedTurnBoundary:true},{role:'user',text:'Unrecorded prompt',verifiedTurnBoundary:true}]
 const checked=verifiedCompactionInput(f.store,'s',untrusted)
 assert.deepEqual(checked.messages.map(m=>m.verifiedTurnBoundary),[false,false])
})

test('issue18: post-native live context matches a checkpoint despite pre-native interrupted tools and API copies',t=>{
 const checkpoint={...user('This session is being continued from a previous conversation. Inspection is unfinished.'),isCompactSummary:true}
 const rows=[{...user('Inspect only. Never deploy.'),origin:{kind:'human'}},use('abandoned'),{type:'system',subtype:'compact_boundary'},checkpoint]
 for(let i=0;i<3;i++)rows.push(assistant([{type:'text',text:'Step '+i+'. '+'甲'.repeat(6000)},{type:'tool_use',id:'native-'+i,name:'read',input:{}}]),user([{type:'tool_result',tool_use_id:'native-'+i,content:'乙'.repeat(6000)}]))
 const archived=rows.flatMap(row=>[row,copy(row)]),f=fixture(t,archived),live=messages(rows.slice(3)).map(liveMessage)
 f.store.setTakeover({enabled:true,window:100000,keep:5000,previous:null})
 f.store.addNode({session:'s',id:'old',level:0,first:0,last:7,children:[],summary:'# Before checkpoint\nInspection unfinished.',digest:'fixture',model:'offline'})
 const context=verifiedCompactionInput(f.store,'s',live)
 assert.equal(context.messages[0].nativeSummary,true);assert.equal(context.messages[0].verifiedTurnBoundary,true)
 const plan=planCompaction({meta:f.store.metadata('s'),...context,nodes:[{id:'all',level:0,first:0,last:archived.length-1,summary:'# Current state\nInspection pending.'}],tokens:90000,window:100000,keepTokens:5000})
 assert.equal(plan.use,true,plan.reason)
 assert.ok(prepareRescueSource(f.store,'s',{messages:live,tokens:90000,window:100000,model:'offline-current'}))
})
