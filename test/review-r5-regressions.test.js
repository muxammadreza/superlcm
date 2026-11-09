import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {appendFileSync,chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore,importFile} from '../src/store.js'
import {detectSummaryLanguage} from '../src/summary-language.js'
import {summaryWork,buildHierarchy} from '../src/summarize.js'
import {planMainFork,generateMainFork} from '../src/main-fork.js'
import {coveredThrough} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'
import {enqueueSummary} from '../src/summary-scheduler.js'
import {reserveSummaryRun} from '../src/summary-runs.js'
import {runSummaryWorker} from '../src/summary-worker.js'

test('deleting imported originals works when an index parent is a symlink',t=>{
 if(process.platform==='win32')return t.skip('POSIX directory symlinks required')
 const root=realpathSync(mkdtempSync(join(tmpdir(),'slcm-linked-parent-'))),actual=join(root,'real'),alias=join(root,'alias'),external=join(root,'external.txt')
 mkdirSync(actual);symlinkSync(actual,alias,'dir');writeFileSync(external,'Synthetic source kept outside the archive.')
 const s=new ClaudeStore(join(alias,'store'));t.after(()=>s.close())
 importFile(s,external,'linked')
 const saved=s.source('linked').path;assert.ok(saved.startsWith(join(actual,'store')+'/'))
 const result=s.deleteSession('linked')
 assert.equal(result.file_cleanup_pending,undefined);assert.equal(existsSync(saved),false)
 assert.equal(readFileSync(external,'utf8'),'Synthetic source kept outside the archive.')
})

test('reimport preserves the new archive while old failed cleanup remains queued',t=>{
 if(process.platform==='win32'||typeof process.getuid==='function'&&process.getuid()===0)return t.skip('requires POSIX permissions for a non-root user')
 const root=realpathSync(mkdtempSync(join(tmpdir(),'slcm-cleanup-reimport-'))),home=join(root,'store'),folder=join(home,'imports'),old=join(folder,'old.jsonl'),fresh=join(root,'fresh.jsonl')
 mkdirSync(folder,{recursive:true});writeFileSync(old,JSON.stringify({type:'user',message:{content:'Old synthetic record'}})+'\n')
 writeFileSync(fresh,JSON.stringify({type:'user',message:{content:'New synthetic record'}})+'\n')
 const s=new ClaudeStore(home);t.after(()=>{chmodSync(folder,0o700);s.close()})
 s.ingest('s',old);s.setMetadata('s',{harness:'claude-code',externalId:'s'});chmodSync(folder,0o500)
 assert.equal(s.deleteSession('s').file_cleanup_pending,true)
 s.ingest('s',fresh);assert.equal(s.cleanupDeletedFiles('s'),1)
 assert.ok(existsSync(old));assert.match(s.exact('s',0),/New synthetic record/)
 chmodSync(folder,0o700);assert.equal(s.cleanupDeletedFiles('s'),0)
 assert.equal(existsSync(old),false);assert.match(s.exact('s',0),/New synthetic record/)
})

test('failed explicit reimport retains deletion fence and rejects automatic capture',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'slcm-failed-reimport-'))),file=join(root,'source.jsonl'),bad=join(root,'bad.jsonl'),partial=join(root,'partial.jsonl')
 writeFileSync(file,JSON.stringify({type:'user',message:{content:'Synthetic old message'}})+'\n');mkdirSync(bad);writeFileSync(partial,'{"incomplete":')
 const s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 s.ingest('s',file);s.setMetadata('s',{harness:'claude-code',externalId:'s'});s.deleteSession('s')
 for(const path of [bad,partial]){
  assert.throws(()=>s.ingest('s',path),/not a regular file|no complete records/i)
  assert.equal(s.isDeleted('s'),true);assert.equal(s.source('s'),undefined)
  assert.deepEqual(s.ingest('s',file,'jsonl',{automatic:true}),{session:'s',skipped:'deleted'})
 }
 assert.ok(s.ingest('s',file).added>0);assert.equal(s.isDeleted('s'),false)
})

test('common Urdu text is not confidently labeled Persian or rejected when summarized',async t=>{
 const root=mkdtempSync(join(tmpdir(),'slcm-urdu-confidence-')),file=join(root,'source.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 const input='یہ ایک عام اردو سوال ہے۔ پاکستان کی حکومت کیا ہماری حالت کی بہتری کا کام کرے گی؟'
 const output='# خلاصہ\nیہ منصوبہ ابھی مکمل نہیں ہوا ہے۔ ہم نے فائل پڑھی ہے اور خرابی دیکھ لی ہے۔ براہ کرم بعد میں نتائج بتائیں۔'
 writeFileSync(file,[{type:'user',message:{content:input}},{type:'assistant',message:{content:'Synthetic response'}}].map(JSON.stringify).join('\n')+'\n')
 s.ingest('s',file);s.setMetadata('s',{harness:'claude-code',externalId:'s'})
 assert.notEqual(detectSummaryLanguage([input]).code,'fa')
 assert.notEqual(summaryWork(s,'s',{batchSize:2}).language.code,'fa')
 let calls=0
 const result=await buildHierarchy(s,'s',{batchSize:2,model:'fixture',apiKey:'fixture-key',apiProvider:'openai',baseURL:'http://127.0.0.1:9',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:output},finish_reason:'stop'}]}))}})
 assert.equal(result.created,1);assert.equal(calls,1);assert.equal(s.nodeRows('s',0).length,1)
 assert.equal(detectSummaryLanguage(['کککک ییے']).code,'arab','a little Urdu evidence is not Persian')
})

function compactedClaude(t,{oversize=false,size=50,count=8,boundary=4}={}){
 const root=mkdtempSync(join(tmpdir(),'slcm-claude-recovery-')),file=join(root,'source.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 const rows=Array.from({length:count},(_,i)=>({type:i%2?'assistant':'user',message:{content:'SYNTHETIC RECORD '+i+' '+(oversize&&i===2?'evidence '.repeat(4000):'details '.repeat(size))}}))
 writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file)
 s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'});s.setGlobalSetting('main-fork')
 s.addNode({session:'s',id:'covered',level:0,first:0,last:1,children:[],summary:'# Previous\nSynthetic task.',digest:'old',model:'offline',sourceComplete:true})
 s.markCompaction('s',boundary)
 return s
}

test('Claude after native compaction supplements verified originals before certifying recovery',async t=>{
 const s=compactedClaude(t),plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}})
 assert.equal(plan.originals[0].ordinal,2);let prompt=''
 const result=await generateMainFork(s,'s',{env:{},queuedPlan:plan,explicit:true,summarize:async(_h,_id,text)=>{
  prompt=text;return {model:'synthetic',text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nSynthetic task and constraints remain active.'}))})}
 }})
 assert.equal(result.calls,1);assert.match(prompt,/Verified original archive excerpts/)
 assert.match(prompt,/SYNTHETIC RECORD 2/);assert.match(prompt,/SYNTHETIC RECORD 3/)
 const json=prompt.split('\n').find(line=>line.startsWith('[{"ordinal":'))
 assert.deepEqual(JSON.parse(json).map(row=>row.ordinal),[2,3])
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),7)
 assert.ok(s.nodeRows('s',0).filter(n=>n.id!=='covered').every(n=>!s.nodeSourceIncomplete('s',n)))
})

test('a concurrent Claude compaction cannot certify an outdated recovery branch',async t=>{
 const s=compactedClaude(t),plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}})
 await assert.rejects(generateMainFork(s,'s',{env:{},queuedPlan:plan,explicit:true,summarize:async()=>{
  s.markCompaction('s',7)
  return {model:'synthetic',text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nSynthetic task remains active.'}))})}
 }}),/摘要准备时发生压缩/)
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),1)
 assert.deepEqual(s.nodeRows('s',0).map(n=>n.id),['covered'])
})

test('a newly archived Claude compact boundary invalidates a frozen branch before its hook runs',async t=>{
 const s=compactedClaude(t),plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}}),file=s.source('s').path
 await assert.rejects(generateMainFork(s,'s',{env:{},queuedPlan:plan,explicit:true,summarize:async()=>{
  appendFileSync(file,JSON.stringify({type:'system',subtype:'compact_boundary'})+'\n');s.ingest('s',file)
  return {model:'synthetic',text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nSynthetic task remains active.'}))})}
 }}),/摘要准备时发生压缩/)
 assert.equal(s.lastCompaction('s'),4,'PostCompact has not fired yet')
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),1)
})

test('an oversized missing Claude record is never truncated and certified',t=>{
 const s=compactedClaude(t,{oversize:true})
 assert.equal(planMainFork(s,'s',{keepTokens:0,force:true,env:{}}),null)
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),1)
})

test('bounded Claude recovery automatically queues the next uncovered batch',async t=>{
 const s=compactedClaude(t,{size:750,count:12,boundary:10}),queued=enqueueSummary(s,'s',{origin:'manual',env:{}})
 let id=queued.run.id,calls=0
 while(id){
  assert.ok(++calls<=10,'coverage must advance rather than repeatedly queue the same batch')
  const plan=JSON.parse(s.db.prepare('SELECT plan FROM fork_summary_plans WHERE run_id=?').get(id).plan)
  assert.ok(reserveSummaryRun(s,{id,limit:1}))
  const result=await runSummaryWorker(s,'s',{runId:id,env:{},nativeSummarize:async()=>({model:'synthetic',text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nSynthetic constraints and pending work.'}))})})})
  const next=s.db.prepare("SELECT id FROM summary_runs WHERE session=? AND state='queued'").get('s')
  if(result.recoveryPending)assert.equal(result.recoveryQueued,true)
  id=next?.id
 }
 assert.ok(calls>1);assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=9)
})
