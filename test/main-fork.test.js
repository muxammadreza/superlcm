import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {DatabaseSync} from 'node:sqlite'
import {forkTreePlan,parseForkTree} from '../src/fork-summary.js'
import {summarizeClaudeFork,summarizeCodexFork} from '../src/native-fork.js'
import {migrateSummaryModes} from '../src/summary-migration.js'
const env={...process.env,SUPERLCM_CLAUDE_CLI_BIN:process.execPath,SUPERLCM_CODEX_CLI_BIN:process.execPath}
function fake(handler){return (bin,args,options)=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null})
  child.kill=()=>{if(child.exitCode===null){child.exitCode=0;queueMicrotask(()=>child.emit('close',0))}return true}
  handler(child,args,options);return child
}}
const emit=(child,item)=>child.stdout.write(JSON.stringify(item)+'\n')
test('one response must supply a bounded complete summary tree',()=>{
 const leaves=Array.from({length:9},(_,index)=>({index,firstMessage:index*2,lastMessage:index*2+1}))
 const plan=forkTreePlan(leaves,4);assert.equal(plan.length,12);assert.equal(plan.at(-1).level,2)
 const blocks=plan.map(n=>({index:n.index,summary:'# Historical constraints\nPending inspection; verify the originals.'}))
 const tree=parseForkTree(JSON.stringify({blocks}),leaves,undefined,{fanout:4,targetTokens:1000})
 assert.deepEqual(tree.at(-1).children,[9,10,8]);assert.equal(tree.at(-1).lastMessage,17)
 assert.throws(()=>parseForkTree(JSON.stringify({blocks:blocks.slice(0,9)}),leaves),/层级缺失/)
 assert.throws(()=>parseForkTree(JSON.stringify({blocks}),leaves,undefined,{targetTokens:1}),/预算/)
})
test('migration converts host and CLI writers and preserves API settings',()=>{
 const db=new DatabaseSync(':memory:')
 for(const name of ['summary_policies','summary_preferences','global_summary_settings','harness_summary_settings']){
   db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,mode TEXT CHECK(mode IN ('agent','cli','api','off'))${name==='summary_policies'?'':',model TEXT,api_ref TEXT'})`)
   if(name==='summary_policies')db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run('one','agent')
   else{db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?)`).run('one','cli','old-model',null);db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?)`).run('api','api','fixture-luna','saved-api')}
 }
 migrateSummaryModes(db);migrateSummaryModes(db)
 for(const name of ['summary_policies','summary_preferences','global_summary_settings','harness_summary_settings']){
   assert.equal(db.prepare(`SELECT mode FROM ${name} WHERE id='one'`).get().mode,'main-fork')
   if(name!=='summary_policies')assert.deepEqual({...db.prepare(`SELECT mode,model,api_ref FROM ${name} WHERE id='api'`).get()},{mode:'api',model:'fixture-luna',api_ref:'saved-api'})
 }
 db.close()
})
test('Claude resumes a native fork, inherits settings and records real usage',async()=>{
 let seen
 const result=await summarizeClaudeFork('original-session','SUMMARY DIRECTIVE',{env,spawnProcess:fake((child,args,options)=>{
   seen={args,options};child.stdin.on('finish',()=>{emit(child,{type:'result',subtype:'success',result:'# Summary\nHistorical inspection.',session_id:'fork-session',usage:{cache_read_input_tokens:300000},stop_reason:'end_turn'});child.kill()})
 })})
 assert.equal(result.branchId,'fork-session');assert.equal(result.usage.cache_read_input_tokens,300000)
 assert.ok(seen.args.includes('--fork-session'));assert.ok(seen.args.includes('original-session'))
 assert.ok(!seen.args.some(a=>['--system-prompt','--model','--tools'].includes(a)))
 assert.equal(seen.options.env.SUPERLCM_CLI_WORKER,'1');assert.match(seen.args.at(-1),/PreToolUse/)
})
for(const fault of ['tool','truncated','missing'])test('Claude rejects '+fault+' without saving',async()=>{
 await assert.rejects(summarizeClaudeFork('source','summary',{env,spawnProcess:fake(child=>child.stdin.on('finish',()=>{
   if(fault==='tool')emit(child,{type:'assistant',message:{content:[{type:'tool_use',id:'bad',name:'Bash'}]}})
   else if(fault==='truncated')emit(child,{type:'result',result:'# Incomplete',stop_reason:'max_tokens'})
   child.kill()
 }))}),/工具|截断|回执/)
})
function rpcSpawn(requests,{tool=false,silent=false}={}){return fake(child=>{
 let input='';child.stdin.on('data',data=>{input+=data.toString();for(let index;(index=input.indexOf('\n'))>=0;){const line=input.slice(0,index);input=input.slice(index+1);const msg=JSON.parse(line);requests.push(msg);if(!msg.id||silent)continue
  if(msg.method==='initialize')emit(child,{id:msg.id,result:{}})
  if(msg.method==='thread/fork')emit(child,{id:msg.id,result:{thread:{id:'branch'},model:'same-model'}})
  if(msg.method==='turn/start'){
   emit(child,{id:msg.id,result:{turn:{id:'turn'}}})
   if(tool){emit(child,{id:99,method:'item/commandExecution/requestApproval',params:{threadId:'branch'}});continue}
   emit(child,{method:'thread/tokenUsage/updated',params:{threadId:'branch',tokenUsage:{last:{inputTokens:300001,cachedInputTokens:300000}}}})
   emit(child,{method:'item/completed',params:{threadId:'branch',item:{type:'agentMessage',text:'# Summary\nHistorical inspection.'}}})
   emit(child,{method:'turn/completed',params:{threadId:'branch',turn:{id:'turn',status:'completed'}}})
  }
 }})
})}
test('Codex creates one ephemeral native fork and inherits model and reasoning',async()=>{
 const requests=[],result=await summarizeCodexFork('main-thread','summary',{env,spawnProcess:rpcSpawn(requests)})
 assert.equal(result.usage.cachedInputTokens,300000);assert.equal(result.model,'same-model')
 const fork=requests.find(r=>r.method==='thread/fork').params,start=requests.find(r=>r.method==='turn/start').params
 assert.equal(fork.threadId,'main-thread');assert.equal(fork.ephemeral,true);assert.ok(fork.config.hooks.PreToolUse)
 assert.equal(fork.model,undefined);assert.equal(fork.baseInstructions,undefined)
 assert.deepEqual(start,{threadId:'branch',input:[{type:'text',text:'summary',text_elements:[]}]})
})
test('Codex denies tool approval and cancels a stuck startup',async()=>{
 await assert.rejects(summarizeCodexFork('main','summary',{env,spawnProcess:rpcSpawn([],{tool:true})}),/工具或授权/)
 await assert.rejects(summarizeCodexFork('main','summary',{env,timeoutMs:20,spawnProcess:rpcSpawn([],{silent:true})}),/超时/)
})
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {planMainFork,generateMainFork} from '../src/main-fork.js'
import {enqueueSummary,scheduleSummary} from '../src/summary-scheduler.js'
function archive(t,{count=4,size=100}={}){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-native-fork-')),store=new ClaudeStore(join(dir,'index')),file=join(dir,'history.jsonl')
 const row=i=>JSON.stringify({type:i%2?'assistant':'user',uuid:'entry-'+i,message:{content:[{type:'text',text:'Original evidence '+i+' '+'.'.repeat(size)}]}})+'\n'
 writeFileSync(file,Array.from({length:count},(_,i)=>row(i)).join(''));store.ingest('session',file)
 store.setMetadata('session',{harness:'claude-code',externalId:'native-source'});store.setGlobalSetting('main-fork')
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return {store,file,row}
}
const treeAnswer=plan=>JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# Historical evidence\nThe user constraints remain active. Inspection is pending; verify original records.'}))})
test('queued fork freezes source, saves all levels atomically, and keeps appended originals',async t=>{
 const {store,file,row}=archive(t),queued=enqueueSummary(store,'session',{env:{}})
 const plan=JSON.parse(store.db.prepare('SELECT plan FROM fork_summary_plans WHERE run_id=?').get(queued.run.id).plan)
 appendFileSync(file,row(4));store.ingest('session',file);let calls=0
 const result=await generateMainFork(store,'session',{env:{},queuedPlan:plan,summarize:async()=>{calls++;return {text:treeAnswer(plan),model:'current-model',usage:{cacheRead:300000}}}})
 assert.equal(calls,1);assert.equal(result.created,plan.tree.length)
 assert.ok(store.nodeRows('session',0).every(n=>n.last<4));assert.match(store.exact('session',4),/Original evidence 4/)
 assert.equal(JSON.parse(store.db.prepare('SELECT usage FROM fork_summary_receipts').get().usage).cacheRead,300000)
})
test('setting changes and missing source cannot publish a partial fork tree',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}})
 await assert.rejects(generateMainFork(store,'session',{env:{},summarize:async()=>{store.setGlobalSetting('off');return {text:treeAnswer(plan),model:'obsolete'}}}),/已变化/)
 assert.equal(store.nodeRows('session',0).length,0);assert.equal(store.summarizing('session'),false)
 store.setGlobalSetting('main-fork')
 await assert.rejects(generateMainFork(store,'session',{env:{},summarize:async()=>({text:'{"error":"missing_source"}',model:'current'})}),/缺失/)
 assert.equal(store.nodeRows('session',0).length,0)
})
test('native automatic branches require known 70% usage and deduplicate a live session',t=>{
 const {store}=archive(t,{count:24,size:16000});let spawns=0
 const options={env:{},window:100000,spawnProcess:()=>{spawns++;return Object.assign(new EventEmitter(),{pid:process.pid,unref(){}})}}
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:69000}),false)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:0,window:0}),false)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:70000}),true)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:71000}),false)
 assert.equal(spawns,1)
})

test('Claude replacement cannot initiate a synchronous rescue in background-branch mode',async()=>{
 const {prepareClaudeRescue}=await import('../src/claude-rescue-store.js')
 const store={effectiveSetting:()=>({mode:'main-fork'}),get db(){throw Error('replacement must not create generation work')}}
 const result=prepareClaudeRescue(store,'fixture',{})
 assert.equal(result.use,false);assert.equal(result.work,undefined)
})

test('Claude preparation precedes a separately configured replacement threshold',async()=>{
 const {forkPreparationThreshold}=await import('../src/main-fork.js')
 const store={takeover:()=>({enabled:true,window:300000}),metadata:()=>({harness:'claude-code'})}
 assert.equal(forkPreparationThreshold(store,'s',1000000),262500)
 assert.equal(forkPreparationThreshold(store,'s',200000),140000)
 store.metadata=()=>({harness:'codex'});assert.equal(forkPreparationThreshold(store,'s',1000000),700000)
})

 test('Claude optional summary model is passed only to the fork invocation',async()=>{
  let selected
  const spawnProcess=fake((child,args)=>{selected=args;child.stdin.on('finish',()=>{emit(child,{type:'result',subtype:'success',result:'complete summary',model:'chosen'});child.exitCode=0;child.emit('close',0)})})
  const result=await summarizeClaudeFork('source','summary directive',{env,model:'chosen',spawnProcess})
  assert.ok(selected.includes('--fork-session'));assert.equal(selected[selected.indexOf('--model')+1],'chosen');assert.equal(result.model,'chosen')
 })
