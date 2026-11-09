import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {ClaudeStore} from '../src/store.js'
import {parseForkTree,forkHash} from '../src/fork-summary.js'
import {saveForkTree} from '../src/main-fork.js'
import {summaryWork,buildHierarchy} from '../src/summarize.js'
import {isReducedSummary} from '../src/summary-fitting.js'
import {planCompaction,frontier,renderPacket} from '../src/compaction.js'
import {readApiKey,saveApiKey,removeApiKey} from '../src/api-credentials.js'
import {captureDshPacket,projectDshEvent} from '../src/dsh.js'
import {SuperLcmStore} from '../dsh/store.js'
import {syncDshSummaries} from '../src/dsh-summaries.js'
import {makePiSnapshot} from '../src/pi-snapshot.js'
import {registerPiCompaction} from '../src/pi-runtime.js'
import {piMcpClient} from '../src/pi-mcp-client.js'
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'superlcm-audit-fixes-')),store=new ClaudeStore(join(dir,'index'));t.after(()=>store.close());return {dir,store}}
const ingest=(f,rows)=>{const file=join(f.dir,'history.jsonl');writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');f.store.ingest('s',file);return file}

test('unseen long source is explicitly incomplete and cannot authorize replacement',async t=>{
 const f=fixture(t),raw={type:'assistant',message:{content:'A'.repeat(15000)+'CRITICAL_MIDDLE'+'B'.repeat(15000)}}
 ingest(f,[raw,{type:'user',message:{content:'Next request'}}]);f.store.setTuning({target_tokens:2000,fanout:4})
 assert.equal(summaryWork(f.store,'s').reducedSources,true)
 await buildHierarchy(f.store,'s',{model:'offline',maxPieces:1,targetTokens:2000,summarize:async()=> '# State\nInspection is unfinished.'})
 const nodes=f.store.nodeRows('s',0);assert.ok(isReducedSummary(nodes[0].summary));assert.equal(nodes[0].sourceIncomplete,true)
 const result=planCompaction({meta:f.store.metadata('s'),events:f.store.eventRows('s'),nodes,messages:[{role:'assistant',text:raw.message.content},{role:'user',text:'Next request'}],tokens:90000})
 assert.equal(result.use,false);assert.ok(f.store.exact('s',0).includes('CRITICAL_MIDDLE'))
})
test('parent keeps incomplete-source quality even when an older child lacks a visible marker',async t=>{
 const f=fixture(t)
 ingest(f,[{role:'user',content:'First source.'},{role:'assistant',content:'Second source.'}])
 for(let i=0;i<2;i++)f.store.addNode({session:'s',id:'child-'+i,level:0,first:i,last:i,children:[],summary:'# State\nA plain legacy summary.',digest:'digest-'+i,model:'offline',sourceComplete:i!==0})
 assert.equal(isReducedSummary(f.store.nodeRows('s',0)[0].summary),false)
 const work=summaryWork(f.store,'s',{fanout:2,targetChars:10000});assert.equal(work.kind,'condensed');assert.equal(work.reducedSources,true)
 await buildHierarchy(f.store,'s',{model:'offline',fanout:2,targetChars:10000,maxPieces:1,summarize:async()=> '# Overview\nEarlier work remains pending.'})
 const parent=f.store.nodeRows('s',1)[0];assert.equal(parent.sourceIncomplete,true);assert.ok(isReducedSummary(parent.summary))
})
test('original substring search covers long middle and tool results, with resumable limits',t=>{
 const f=fixture(t);ingest(f,[{type:'user',message:{content:'a'.repeat(21000)+'UNIQUE_MIDDLE'}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',content:'UNIQUE_TOOL'}]}}])
 assert.equal(f.store.find('UNIQUE_MIDDLE',{session:'s'}).events.length,1)
 assert.equal(f.store.find('UNIQUE_TOOL',{session:'s'}).events.length,1)
 assert.equal(f.store.search('s','UNIQUE_TOOL').events.length,1)
 const first=f.store.find('UNIQUE',{session:'s',limit:1});assert.equal(first.search_complete,false)
 const second=f.store.find('UNIQUE',{session:'s',limit:1,cursor:first.next_cursor});assert.equal(second.events.length,1);assert.notEqual(first.events[0].ordinal,second.events[0].ordinal)
 assert.equal(second.search_complete,true)
})
test('existing permissive archive directory and SQLite are made private',t=>{
 if(process.platform==='win32')return t.skip('POSIX permissions')
 const dir=mkdtempSync(join(tmpdir(),'superlcm-permissions-')),home=join(dir,'existing');mkdirSync(home,{mode:0o755})
 const store=new ClaudeStore(home);t.after(()=>store.close())
 assert.equal(statSync(home).mode&0o777,0o700);assert.equal(statSync(join(home,'lcm.sqlite')).mode&0o777,0o600)
})
test('independent concurrent credential writes survive restart and legacy import',async t=>{
 const f=fixture(t);saveApiKey(f.store.dir,'global','synthetic-global')
 const module=new URL('../src/api-credentials.js',import.meta.url).href
 await Promise.all(Array.from({length:12},(_,i)=>new Promise((resolve,reject)=>{
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');import(workerData.module).then(m=>{m.saveApiKey(workerData.dir,'model:'+workerData.i,'synthetic-key-'+workerData.i);parentPort.postMessage('ok')})`,{eval:true,workerData:{module,dir:f.store.dir,i:String(i)}})
  worker.on('error',reject);worker.on('exit',code=>code?reject(Error('credential worker failed')):resolve())
 })))
 for(let i=0;i<12;i++)assert.equal(readApiKey(f.store.dir,'model:'+i),'synthetic-key-'+i)
 assert.equal(readApiKey(f.store.dir,'global'),'synthetic-global');assert.equal(removeApiKey(f.store.dir,'model:1'),true);assert.equal(readApiKey(f.store.dir,'model:1'),null)
})
test('a longer model parent remains available instead of dropping its unique content',t=>{
 const f=fixture(t);ingest(f,[{role:'user',content:'First original'},{role:'assistant',content:'Second original'}])
 const leaves=[{firstMessage:0,lastMessage:0},{firstMessage:1,lastMessage:1}],large='# Overview\n'+ 'Repeated evidence. '.repeat(400)
 const tree=parseForkTree(JSON.stringify({blocks:[{index:0,summary:'# First\nPending.'},{index:1,summary:'# Second\nKeep originals.'},{index:2,summary:large}]}),leaves,undefined,{targetTokens:10000})
 assert.equal(tree[2].kind,'condensed');assert.equal(tree[2].summary,large.trim());assert.equal(tree[2].compression.nonShrinking,true)
 const originals=f.store.eventRows('s').map(r=>({ordinal:r.ordinal,digest:r.digest}))
 const ids=saveForkTree(f.store,'s',{digest:'audit',originals},tree,{model:'offline'})
 assert.equal(f.store.outline('s',ids[2]).node.summary,large.trim())
 assert.ok(frontier(f.store.nodeRows('s',0),1).length)
})
test('a frozen leaf is reused verbatim without asking the model to rewrite it',()=>{
 const leaves=[{firstMessage:0,lastMessage:0,frozenSummary:'# Historical state\nOriginal immutable decisions.'},{firstMessage:1,lastMessage:1}]
 const result=parseForkTree(JSON.stringify({blocks:[{index:1,summary:'# New work\nPending inspection.'},{index:2,summary:'# Overview\nPending.'}]}),leaves)
 assert.equal(result[0].summary,leaves[0].frozenSummary)
 assert.throws(()=>parseForkTree(JSON.stringify({blocks:[{index:2,summary:'# Overview\nPending.'}]}),leaves),/缺失/)
})
test('over-budget legacy root falls back to complete cheaper descendants',()=>{
 const nodes=[{id:'a',level:0,first:0,last:0,summary:'# A\nFirst'},{id:'b',level:0,first:1,last:1,summary:'# B\nSecond'},{id:'r',level:1,first:0,last:1,summary:'# Huge\n'+'x'.repeat(130000)}]
 const chosen=frontier(nodes,1);assert.deepEqual(chosen.map(n=>n.id),['a','b']);assert.ok(renderPacket({meta:{code:'test'},summaries:chosen,through:1,keep:1}))
})
test('large DSH event and the next sequence both archive without clipping',t=>{
 const f=fixture(t);f.store.setIntegrationEnabled('dsh',true)
 const id='large-audit',header={id,createdAt:1,cwd:'/synthetic'}
 const event=(seq,text)=>({seq,time:seq+1,type:'user/message',data:{content:[{type:'text',text}]},surfaceOp:'append'})
 const first=event(0,'x'.repeat(5*1024*1024)),last=event(1,'AFTER_LARGE')
 captureDshPacket(f.store,{header,records:[projectDshEvent(id,first,'preview')]})
 const result=captureDshPacket(f.store,{header,records:[projectDshEvent(id,last,'AFTER_LARGE')]})
 assert.equal(f.store.stats(result.session).records,2);assert.equal(JSON.parse(f.store.exact(result.session,0)).event.data.content[0].text.length,5*1024*1024)
 assert.ok(f.store.exact(result.session,1).includes('AFTER_LARGE'))
})
test('legacy DSH mirror retires only an exact same-identity same-source duplicate',t=>{
 const f=fixture(t),native=new SuperLcmStore(join(f.store.dir,'lcm.sqlite'));t.after(()=>native.close())
 const id='forest-audit',summary='# State\nPending inspection.'
 native.upsertNode({sessionId:id,nodeId:'new',summarySeq:1,sourceSeqs:[0],childIds:[],status:'ready',summary:[{type:'text',text:summary}],summaryText:summary})
 const header={id,createdAt:1,cwd:'/synthetic'},records=[0,1].map(seq=>projectDshEvent(id,{seq,time:seq+1,type:seq?'assistant/message':'user/message',data:{content:[{type:'text',text:'original'}]},surfaceOp:'append'},'original'))
 const {session}=captureDshPacket(f.store,{header,records}),oldId='dsh-fork-'+forkHash([id,'fork-new']).slice(0,24)
 saveForkTree(f.store,session,{digest:'audit',originals:[{ordinal:0,digest:f.store.eventRows(session)[0].digest}]},[{index:0,archiveId:oldId,level:0,firstMessage:0,lastMessage:0,sourceRecords:[0],children:[],summary}],{model:'offline'})
 syncDshSummaries(f.store,session,id)
 assert.deepEqual(f.store.roots(session).map(n=>n.id),['dsh-native-new']);assert.ok(f.store.node(session,oldId),'history is retained')
})
test('Pi standalone API pins image content instead of treating a placeholder as coverage',()=>{
 const rows=[{role:'user',content:[{type:'image',data:'synthetic-image',mimeType:'image/png'}]},{role:'assistant',content:[{type:'text',text:'old '.repeat(20000)}]},{role:'user',content:'new '.repeat(4000)}].map((message,i)=>({sourceEntry:{id:'e'+i,type:'message'},messages:[message]}))
 const ctx={getContextUsage:()=>({tokens:90000}),sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'fixture',getSessionFile:()=>'/synthetic',getLeafId:()=> 'e2'}}
 assert.equal(makePiSnapshot(ctx,{enabled:true,ratio:.8,keep:5000,summaryMode:'api'}),null)
})
test('Pi preparation counts system and tool overhead before provider usage exists',async()=>{
 const handlers=new Map(),rows=[{role:'user',content:'old '.repeat(15000)},{role:'assistant',content:[{type:'text',text:'old '.repeat(15000)}]},{role:'user',content:'new '.repeat(15000)}].map((message,i)=>({sourceEntry:{id:'e'+i,type:'message'},messages:[message]}))
 const p={enabled:true,summaryEnabled:true,summaryMode:'api',ratio:.8,keep:5000},ctx={model:{contextWindow:100000,maxTokens:1000},getContextUsage:()=>({tokens:45000}),getSystemPrompt:()=> 'fixed '.repeat(25000),isIdle:()=>false,sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'fixture',getSessionFile:()=>'/synthetic',getLeafId:()=> 'e2'},ui:{notify(){},setStatus(){}}}
 let calls=0;const runtime=registerPiCompaction({on:(n,f)=>handlers.set(n,f),registerCommand(){},getSettings:()=>({}),getAllTools:()=>[],getActiveTools:()=>[]},{home:'/synthetic'},{policy:()=>p,request:async()=>{calls++;return null}})
 runtime.prepare(ctx);assert.ok(runtime.getState());await runtime.getState().promise;assert.equal(calls,1);handlers.get('session_shutdown')()
})
test('dead MCP connections reject future calls; a new generation can reconnect',async t=>{
 const f=fixture(t),script=join(f.dir,'mcp.mjs');writeFileSync(script,"import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:{ok:true}}));setTimeout(()=>process.exit(0),20)}")
 const client=piMcpClient({node:process.execPath,script,home:f.store.dir,timeoutMs:1000});t.after(()=>client.close())
 assert.deepEqual(await client.call('ping',{}),{ok:true});if(client.alive)await new Promise(resolve=>client.proc.once('exit',resolve))
 await assert.rejects(client.call('ping',{}),/disconnected/)
 const newer=piMcpClient({node:process.execPath,script,home:f.store.dir,timeoutMs:1000});t.after(()=>newer.close());assert.deepEqual(await newer.call('ping',{}),{ok:true})
})

test('unsupported standalone visual compaction hands control to the native host',async()=>{
 const handlers=new Map(),message={role:'user',content:[{type:'image',data:'synthetic',mimeType:'image/png'}]},rows=[{sourceEntry:{type:'message',id:'image'},messages:[message]}]
 const p={enabled:true,summaryEnabled:true,summaryMode:'api',ratio:.8,keep:5000},ctx={model:{contextWindow:100000,maxTokens:1000},getContextUsage:()=>({tokens:95000}),getSystemPrompt:()=>'',isIdle:()=>true,sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'visual',getSessionFile:()=>'/synthetic',getLeafId:()=> 'image'},ui:{notify(){},setStatus(){}}}
 registerPiCompaction({on:(name,fn)=>handlers.set(name,fn),registerCommand(){},getSettings:()=>({})},{home:'/synthetic'},{policy:()=>p,request:async()=>{throw Error('must not summarize unseen image')}})
 assert.equal(await handlers.get('session_before_compact')({reason:'manual'},ctx),undefined)
 assert.equal(await handlers.get('input')({text:'Continue'},ctx),undefined)
 handlers.get('session_shutdown')()
})

test('background native forks retry a transient spawn failure and then publish once',async t=>{
 const {generateMainFork}=await import('../src/main-fork.js'),f=fixture(t)
 ingest(f,[{role:'user',content:'Inspect this synthetic project.'},{role:'assistant',content:'Inspection remains pending.'}]);f.store.setMetadata('s',{harness:'codex',externalId:'synthetic'})
 t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0
 const pending=generateMainFork(f.store,'s',{explicit:true,retry:true,summarize:async(_tool,_id,prompt)=>{
  if(++calls===1)throw Object.assign(Error('Synthetic temporarily unavailable process'),{summaryKind:'spawn'})
  const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
  return {text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# State\nInspection is pending.'}))}),model:'offline',usage:{}}
 }})
 for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve))
 assert.equal(calls,1);t.mock.timers.tick(30000)
 const result=await pending;assert.equal(calls,2);assert.equal(result.calls,2);assert.ok(result.created>0)
})
