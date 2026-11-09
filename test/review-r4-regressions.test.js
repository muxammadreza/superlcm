import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {chmodSync,existsSync,mkdirSync,mkdtempSync,rmdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {ClaudeStore,nodeId} from '../src/store.js'
import {summaryWork} from '../src/summarize.js'
import {planMainFork} from '../src/main-fork.js'
import {coveredThrough,frontier} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'
import {liveMessage} from '../src/claude-live-messages.js'
import {retainHostDraft} from '../src/claude-host-drafts.js'
import {captureLegacyDshSource} from '../src/dsh-legacy.js'
import {hasUnrepresentedContent} from '../src/source-completeness.js'
import {SUMMARY_POLICY_VERSION} from '../src/summary-policy.js'
import {saveApiKey,readApiKey,stageApiKey,bindApiKey,cleanupApiCredential,apiCredentialCleanupPending} from '../src/api-credentials.js'
import {fixture} from './fixtures/claude-rescue-harness.mjs'

const addWork=(store,session,work,summary)=>store.addNode({session,id:work.batch_id,level:work.level,first:work.first,last:work.last,children:work.children,summary,digest:work.digest,model:'synthetic',sourceComplete:!work.reducedSources})

test('a rescue interleaving cannot certify a parent spanning a child coverage gap',async()=>{
 const rows=[]
 for(let i=0;i<10;i++){
  rows.push({type:'user',origin:{kind:'human'},message:{content:i===1?'SECRET_GAP_DECISION: never deploy':'Synthetic request '+i}})
  rows.push({type:'assistant',message:{content:'Synthetic reply '+i}})
 }
 const h=fixture({rows,tokens:50000,window:300000}),setup=h.open()
 setup.setTuning({target_tokens:2000,batch_size:8,fanout:2});setup.close()
 const dto=h.messages.map(m=>({...liveMessage(m),toolResults:m.toolResults?.length?1:0}))
 const prepared=await h.cli('compact-rescue-prepare',{messages:dto,tokens:h.tokens,window:h.window,model:'synthetic'})
 assert.ok(prepared.work,JSON.stringify(prepared))
 const w=prepared.work,s=h.open(),p=JSON.parse(s.db.prepare('SELECT preparation FROM claude_compaction_rescues WHERE session=? AND node_id=?').get(h.id,w.node_id).preparation)
 const early=summaryWork(s,h.id,{batchSize:2,leafOnly:true});assert.deepEqual([early.first,early.last],[0,1])
 addWork(s,h.id,early,'# Early\n'+'early history '.repeat(200));s.close()
 const saved=await h.cli('compact-rescue-save',{node_id:w.node_id,claim_id:w.claim_id,input_hash:w.input_hash,isAnswered:true,summary:'# Checkpoint\nSECRET_GAP_DECISION: never deploy. Synthetic task pending.',model:'synthetic'})
 assert.equal(saved.use,true,JSON.stringify(saved))
 const x=h.open(),late=summaryWork(x,h.id,{batchSize:2,leafOnly:true})
 assert.deepEqual([late.first,late.last],[p.through+1,p.through+2]);addWork(x,h.id,late,'# Late\n'+'later history '.repeat(200))
 let tail;while((tail=summaryWork(x,h.id,{batchSize:2,leafOnly:true})))addWork(x,h.id,tail,'# Tail\nRecent synthetic exchange remains pending.')
 const next=summaryWork(x,h.id,{batchSize:2})
 assert.ok(!next||next.children.join(',')!==[early.batch_id,late.batch_id].join(','))
 const broken={session:h.id,id:'synthetic-old-gap',level:1,first:0,last:late.last,children:[early.batch_id,late.batch_id],summary:'# Missing\nEarlier and later task.',digest:'bad',model:'old'}
 assert.throws(()=>x.addNode(broken),/children do not cover/)
 // Existing databases may already contain a falsely certified parent.
 x.db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(h.id,broken.id,broken.level,broken.first,broken.last,JSON.stringify(broken.children),broken.summary,broken.digest,broken.model)
 x.db.prepare('INSERT INTO summary_node_quality VALUES(?,?,1)').run(h.id,broken.id)
 x.db.prepare('INSERT INTO claude_node_coverage_v3 VALUES(?,?)').run(h.id,broken.id)
 assert.equal(x.nodeSourceIncomplete(h.id,broken),true)
 const nodes=claudeCompactionNodes(x,h.id),through=coveredThrough(nodes)
 assert.ok(frontier(nodes,through).every(node=>node.id!==broken.id));x.close()
 const compact=await h.cli('compact-packet',{messages:dto,tokens:h.tokens,window:h.window,trigger:'auto'})
 assert.equal(compact.use,true,JSON.stringify(compact));assert.match(compact.packet,/SECRET_GAP_DECISION/)
})

test('legacy untrusted Claude leaves are rebuilt from the first missing record and survive restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-legacy-rebuild-')),file=join(dir,'history.jsonl'),dbdir=join(dir,'store')
 const rows=Array.from({length:16},(_,i)=>({type:i%2?'assistant':'user',message:{content:'Synthetic '+i+' '+'details '.repeat(500)}}))
 writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n')
 let store=new ClaudeStore(dbdir);t.after(()=>store.close())
 store.ingest('legacy',file);store.setMetadata('legacy',{harness:'claude-code',externalId:'legacy'})
 store.setTuning({target_tokens:20000,batch_size:2,fanout:2})
 const fresh=summaryWork(store,'legacy',{batchSize:2,leafOnly:true}),digests=store.eventRows('legacy').slice(0,2).map(e=>e.digest)
 const oldDigest=createHash('sha256').update(JSON.stringify([SUMMARY_POLICY_VERSION,fresh.language.code,...digests])).digest('hex')
 const oldId=nodeId('legacy',0,0,1,oldDigest)
 store.db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run('legacy',oldId,0,0,1,'[]','# Old\nLegacy navigation only.',oldDigest,'old')
 store.db.prepare('INSERT INTO summary_node_quality VALUES(?,?,1)').run('legacy',oldId)
 assert.equal(coveredThrough(claudeCompactionNodes(store,'legacy')),-1)
 assert.equal(summaryWork(store,'legacy',{batchSize:2,leafOnly:true}).first,0)
 assert.notEqual(summaryWork(store,'legacy',{batchSize:2,leafOnly:true}).batch_id,oldId)
 assert.equal(planMainFork(store,'legacy',{force:true,keepTokens:10})?.leaves[0].firstMessage,0)
 let work,count=0
 while((work=summaryWork(store,'legacy',{batchSize:2,leafOnly:true}))){
  assert.ok(++count<=rows.length)
  addWork(store,'legacy',work,'# Rebuilt\nSynthetic record details and constraints retained.')
 }
 assert.equal(coveredThrough(claudeCompactionNodes(store,'legacy')),rows.length-1)
 store.close();store=new ClaudeStore(dbdir)
 assert.equal(coveredThrough(claudeCompactionNodes(store,'legacy')),rows.length-1)
 assert.equal(store.nodeSourceIncomplete('legacy',store.node('legacy',oldId)),true)
 assert.equal(summaryWork(store,'legacy',{batchSize:2,leafOnly:true}),null)
})

test('deleting a Claude conversation removes draft and rescue text and fences late writes',async()=>{
 const h=fixture();await h.seed(1)
 const s=h.open(),original=readFileSync(h.file,'utf8')
 try{
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM claude_host_drafts WHERE session=?').get(h.id).n,1)
  s.db.exec('CREATE TABLE IF NOT EXISTS claude_compaction_rescues(session TEXT,node_id TEXT,claim_id TEXT,state TEXT,deadline_ms INTEGER,revision TEXT,preparation TEXT,summary TEXT,failed_until INTEGER,PRIMARY KEY(session,node_id))')
  s.db.prepare('INSERT INTO claude_compaction_rescues VALUES(?,?,?,?,?,?,?,?,?)').run(h.id,'r','c','ready',0,'v','{}','SYNTHETIC RESCUE SECRET',0)
  s.deleteSession(h.id)
  for(const table of ['claude_host_drafts','claude_compaction_rescues','host_summary_claims','nodes','events','summary_runs'])
   assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE session=?`).get(h.id).n,0,table)
  assert.equal(readFileSync(h.file,'utf8'),original,'native host transcript remains intact')
  assert.deepEqual(s.ingest(h.id,h.file,'jsonl',{automatic:true}),{session:h.id,skipped:'deleted'})
  assert.throws(()=>retainHostDraft(s,h.id,{batch_id:'late',level:0,first:0,last:0,children:[],digest:'x'},{revision:'v',claim_id:'c'},{model:'fixture'},'# Late secret'),/deleted/)
  assert.throws(()=>s.addNode({session:h.id,id:'late',level:0,first:0,last:0,children:[],summary:'late secret',digest:'x',model:'fixture'}),/deleted/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM claude_host_drafts WHERE session=?').get(h.id).n,0)
  assert.ok(s.ingest(h.id,h.file).added>0,'explicit re-import still revives the archive')
 }finally{s.close()}
})

test('deleting a historical DSH conversation removes its legacy original blob',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-delete-old-dsh-')),file=join(dir,'session.jsonl'),store=new ClaudeStore(join(dir,'store'))
 t.after(()=>store.close())
 const physical={type:'session',version:0,id:'historical',createdAt:1,cwd:'/fixture',delegationDepth:0}
 const header={version:4,id:'historical',createdAt:1,cwd:'/fixture',isSeeded:false,delegationDepth:0}
 const events=[0,1].map(i=>({seq:i,time:i+1,type:'user/message',surfaceOp:'append',data:{role:'user',content:[{type:'text',text:'synthetic private record '+i}]}}))
 const bytes=Buffer.from([physical,...events].map(JSON.stringify).join('\n')+'\n');writeFileSync(file,bytes)
 const source={path:file,compressed:false,sha256:createHash('sha256').update(bytes).digest('hex'),header}
 const saved=await captureLegacyDshSource(store,source);assert.equal(saved.session,'dsh-historical')
 store.deleteSession(saved.session)
 assert.equal(store.db.prepare('SELECT bytes FROM dsh_legacy_sources WHERE session=?').get(saved.session),undefined)
 assert.deepEqual(await captureLegacyDshSource(store,source),{session:saved.session,skipped:'deleted'})
 assert.deepEqual(readFileSync(file),bytes,'native legacy transcript remains untouched')
})

test('delayed archive cleanup cannot remove an explicitly reimported conversation',t=>{
 const h=fixture(),s=h.open();t.after(()=>s.close())
 const raw=readFileSync(h.file,'utf8');s.deleteSession(h.id)
 assert.ok(s.ingest(h.id,h.file).added>0)
 const archive=s.archivePath(h.id);assert.equal(readFileSync(archive,'utf8'),raw)
 // Represents a cleanup delayed behind the explicit reimport.
 s.db.prepare('INSERT INTO deleted_session_files VALUES(?,?)').run(h.id,archive)
 s.cleanupDeletedFiles(h.id)
 assert.ok(existsSync(archive));assert.equal(s.exact(h.id,0),raw.split('\n')[0]+'\n')
 assert.equal(s.db.prepare('SELECT count(*) n FROM deleted_session_files WHERE session=?').get(h.id).n,0)
})

test('failed archive file cleanup remains queued and retries after restart',t=>{
 const h=fixture(),s=h.open();s.deleteSession(h.id)
 const blocked=join(s.dir,'synthetic-unlink-failure');mkdirSync(blocked)
 s.db.prepare('INSERT INTO deleted_session_files VALUES(?,?)').run(h.id,blocked)
 assert.equal(s.cleanupDeletedFiles(h.id),1);s.close()
 rmdirSync(blocked)
 const reopened=new ClaudeStore(h.home);t.after(()=>reopened.close())
 assert.equal(reopened.db.prepare('SELECT count(*) n FROM deleted_session_files WHERE session=?').get(h.id).n,0)
})

test('unknown and nested non-text blocks cannot prove Claude coverage',async()=>{
 const raw=blocks=>JSON.stringify({type:'user',message:{content:blocks}})
 for(const block of [{type:'input_file',file_id:'SYNTHETIC_FILE_ID'},{type:'future_attachment',data:'secret'},
   {type:'tool_result',tool_use_id:'t',content:[{type:'future_attachment',data:'secret'}]},
   {type:'tool_result',tool_use_id:'t',content:{wrapper:{type:'image',data:'not-visible'}}},
   {type:'tool_result',tool_use_id:'t',content:{wrapper:{type:'future_attachment',data:'not-visible'}}}])
  assert.equal(hasUnrepresentedContent(raw([{type:'text',text:'inspect'},block])),true)
 assert.equal(hasUnrepresentedContent(raw([{type:'text',text:'inspect'},{type:'thinking',thinking:'private reasoning'}])),false)
 assert.equal(hasUnrepresentedContent('a plain text import','text'),false)
 const rows=[]
 for(let i=0;i<5;i++)rows.push({type:'user',message:{content:i===0?[{type:'text',text:'inspect'},{type:'input_file',file_id:'SYNTHETIC_FILE_ID'}]:'request '+i}},{type:'assistant',message:{content:'response '+i}})
 const h=fixture({rows,tokens:50000,window:300000}),s=h.open()
 try{
  const work=summaryWork(s,h.id,{batchSize:2,leafOnly:true});assert.equal(work.reducedSources,true)
  s.addNode({session:h.id,id:'forged-complete',level:0,first:0,last:5,children:[],summary:'# State\nSynthetic work pending.',digest:'d',model:'fixture',sourceComplete:true})
  assert.equal(s.nodeSourceIncomplete(h.id,s.node(h.id,'forged-complete')),true)
 }finally{s.close()}
 const dto=h.messages.map(m=>({...liveMessage(m),toolResults:m.toolResults?.length?1:0}))
 const packet=await h.cli('compact-packet',{messages:dto,tokens:h.tokens,window:h.window,trigger:'auto'})
 assert.equal(packet.use,false)
 const rescue=await h.cli('compact-rescue-prepare',{messages:dto,tokens:h.tokens,window:h.window,model:'synthetic'})
 assert.equal(rescue.use,false)
})

test('Claude main fork stops at opaque source and plans verified recovery after compaction',t=>{
 const rows=[{type:'user',message:{content:'first request'}},{type:'assistant',message:{content:'first answer'}},
  {type:'user',message:{content:[{type:'text',text:'inspect'},{type:'input_file',file_id:'fixture'}]}},
  {type:'assistant',message:{content:'second answer'}},{type:'user',message:{content:'continue'}}]
 const h=fixture({rows}),s=h.open();t.after(()=>s.close())
 const plan=planMainFork(s,h.id,{keepTokens:0,force:true,env:{}})
 assert.ok(plan);assert.equal(plan.originals.at(-1).ordinal,1)
 s.addNode({session:h.id,id:'verified-first',level:0,first:0,last:1,children:[],summary:'# First task\nFirst request answered.',digest:plan.digest,model:'fixture',sourceComplete:true})
 assert.equal(planMainFork(s,h.id,{keepTokens:0,force:true,env:{}}),null)
 const h2=fixture({rows:rows.map((r,i)=>i===2?{type:'user',message:{content:'ordinary'}}:r)}),s2=h2.open();t.after(()=>s2.close())
 s2.markCompaction(h2.id,3)
 assert.ok(planMainFork(s2,h2.id,{keepTokens:0,force:true,env:{}}))
})

test('model deletion rolls back model and binding together when unbinding fails',t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-model-delete-')),s=new ClaudeStore(dir);t.after(()=>s.close())
 const m=s.saveApiModel({provider:'openai',model:'synthetic',url:'https://example.test/v1'}),scope='model:'+m.id
 saveApiKey(dir,scope,'synthetic-key-value',m.url)
 s.db.exec("CREATE TRIGGER binding_failure BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
 assert.throws(()=>s.deleteApiModel(m.id),/injected failure/)
 assert.ok(s.apiModel(m.id));assert.equal(readApiKey(dir,scope,m.url),'synthetic-key-value')
 assert.equal(apiCredentialCleanupPending(s.db,scope),false)
})

test('model deletion clears historical keys and legacy JSON while retaining an in-flight revision',t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-key-purge-')),s=new ClaudeStore(dir);t.after(()=>s.close())
 const m=s.saveApiModel({provider:'openai',model:'synthetic',url:'https://example.test/v1'}),scope='model:'+m.id
 saveApiKey(dir,scope,'synthetic-old-key',m.url);saveApiKey(dir,scope,'synthetic-new-key',m.url)
 const inFlight=stageApiKey(dir,scope,'synthetic-pending-key',m.url)
 writeFileSync(join(dir,'api-credentials.json'),JSON.stringify({[scope]:'synthetic-legacy-key',global:'unrelated-synthetic-key'}),{mode:0o600})
 assert.equal(s.deleteApiModel(m.id),true);assert.equal(readApiKey(dir,scope),null)
 assert.equal(apiCredentialCleanupPending(s.db,scope),true)
 assert.throws(()=>bindApiKey(s.db,scope,inFlight),/model was deleted/)
 const secret=new DatabaseSync(join(dir,'api-credentials.sqlite'))
 try{
  const versions=secret.prepare('SELECT revision,value FROM credential_versions WHERE scope=?').all(scope)
  assert.deepEqual(versions.map(x=>x.revision),[inFlight])
  assert.equal(secret.prepare('SELECT value FROM credentials WHERE scope=?').get(scope),undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'api-credentials.json'),'utf8')),{global:'unrelated-synthetic-key'})
  // A writer that never publishes eventually becomes eligible for cleanup.
  secret.prepare('UPDATE credential_staging SET created_ms=0 WHERE revision=?').run(inFlight)
 }finally{secret.close()}
 assert.equal(cleanupApiCredential(s.db,dir,scope),true)
 assert.equal(apiCredentialCleanupPending(s.db,scope),false)
 assert.throws(()=>bindApiKey(s.db,scope,inFlight),/model was deleted/)
 const final=new DatabaseSync(join(dir,'api-credentials.sqlite'),{readOnly:true})
 try{assert.equal(final.prepare('SELECT count(*) n FROM credential_versions WHERE scope=?').get(scope).n,0)}finally{final.close()}
})

test('failed credential cleanup stays visible and is retried after reopening',t=>{
 if(process.platform==='win32')return t.skip('POSIX file permissions required')
 const dir=mkdtempSync(join(tmpdir(),'superlcm-key-retry-')),s=new ClaudeStore(dir)
 const m=s.saveApiModel({provider:'openai',model:'synthetic',url:'https://example.test/v1'}),scope='model:'+m.id
 saveApiKey(dir,scope,'synthetic-test-key',m.url)
 chmodSync(join(dir,'api-credentials.json'),0o644)
 assert.equal(s.deleteApiModel(m.id),true);assert.equal(apiCredentialCleanupPending(s.db,scope),true)
 s.close();chmodSync(join(dir,'api-credentials.json'),0o600)
 const reopened=new ClaudeStore(dir);t.after(()=>reopened.close())
 assert.equal(apiCredentialCleanupPending(reopened.db,scope),false);assert.equal(readApiKey(dir,scope),null)
 const secret=new DatabaseSync(join(dir,'api-credentials.sqlite'),{readOnly:true})
 try{assert.equal(secret.prepare('SELECT count(*) n FROM credential_versions WHERE scope=?').get(scope).n,0)}finally{secret.close()}
})
