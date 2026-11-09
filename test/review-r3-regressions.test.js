import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {ClaudeStore} from '../src/store.js'
import {coveredThrough,frontier,planCompaction,turnTail} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'
import {verifiedCompactionInput} from '../src/claude-compaction-input.js'
import {verifiedActiveMessages,verifiedCompactionCut,liveMessage} from '../src/claude-rescue-source.js'
import {saveForkTree} from '../src/main-fork.js'
import {saveApiKey,readApiKey,stageApiKey,bindApiKey} from '../src/api-credentials.js'
import {startWeb} from '../src/web.js'
import {fixture,history,messages} from './fixtures/claude-rescue-harness.mjs'

const n=(id,first,last,summary='summary')=>({id,level:0,first,last,summary})
const context=(nodes,last)=>{
  const events=Array.from({length:last+1},(_,i)=>({ordinal:i,preview:(i%2?'assistant: ':'user: ')+i}))
  const live=events.map(e=>({role:e.preview.startsWith('user')?'user':'assistant',text:String(e.ordinal),size:1000}))
  return {meta:{code:'fixture'},events,nodes,messages:live,tokens:20000,window:300000,keepTokens:0}
}
const archive=(t,rows)=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-review-r3-')),file=join(dir,'source.jsonl'),store=new ClaudeStore(join(dir,'store'))
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file);t.after(()=>store.close())
  return {dir,store}
}

test('crossing summaries cannot authorize a partially covered replacement',()=>{
  const nodes=[n('first',0,3),{...n('rescue',0,1),checkpoint:true,level:1},n('overlap',2,5)]
  assert.equal(coveredThrough(nodes),5)
  assert.deepEqual(frontier(nodes,5).map(x=>x.id),['rescue','overlap'])
  const missing=[nodes[0],nodes[2]]
  assert.equal(coveredThrough(missing),5);assert.deepEqual(frontier(missing,5),[])
  assert.equal(planCompaction(context(missing,9)).use,false)
  assert.deepEqual(frontier(nodes.slice(0,2),3).map(x=>x.id),['first'])
})

test('the cheapest full coverage is selected globally rather than one piece at a time',()=>{
  const nodes=[n('cheap-first',0,1,'x'),n('expensive-tail',2,5,'x'.repeat(3000)),n('alternative-first',0,2,'x'.repeat(100)),n('alternative-tail',3,5,'x'.repeat(100))]
  assert.deepEqual(frontier(nodes,5).map(x=>x.id),['alternative-first','alternative-tail'])
})

test('frontier weighs estimated tokens rather than choosing the shortest CJK text',()=>{
  const nodes=[n('leaf-a',0,0,'x'.repeat(400)),n('leaf-b',1,1,'x'.repeat(400)),{...n('root',0,1,'中'.repeat(350)),level:1}]
  assert.deepEqual(frontier(nodes,1).map(x=>x.id),['leaf-a','leaf-b'])
  assert.deepEqual(frontier(nodes,1,'chars').map(x=>x.id),['root'])
})

test('a character-limited packet can fall back to a complete smaller frontier',()=>{
  const nodes=[n('long-ascii',0,3,'x'.repeat(130000)),{...n('compact-chars',0,3,'中'.repeat(30000)),level:1}]
  assert.deepEqual(frontier(nodes,3).map(x=>x.id),['long-ascii'])
  const plan=planCompaction(context(nodes,9))
  assert.equal(plan.use,true)
  assert.ok(plan.packet.includes('compact-chars'))
})

test('frontier fallback finds a middle choice satisfying both character and token limits',()=>{
  const nodes=[n('too-many-chars',0,3,'x'.repeat(150000)),
    {...n('too-many-tokens',0,3,'中'.repeat(30000)),level:1},
    {...n('fits-both',0,3,'x'.repeat(40000)+'中'.repeat(20000)),level:1}]
  assert.equal(frontier(nodes,3)[0].id,'too-many-chars')
  assert.equal(frontier(nodes,3,'chars')[0].id,'too-many-tokens')
  const plan=planCompaction({...context(nodes,9),tokens:1000,window:120000})
  assert.equal(plan.use,true,plan.reason)
  assert.ok(plan.packet.includes('fits-both'))
})

test('legacy unknown summaries remain untrusted after changing the budget or reinserting an existing id',t=>{
  const {store}=archive(t,[{type:'user',message:{content:'Legacy source '+ 'x'.repeat(8000)}}])
  const old={session:'s',id:'old',level:0,first:0,last:0,children:[],summary:'Old summary',digest:'old',model:'old'}
  store.db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(old.session,old.id,old.level,old.first,old.last,'[]',old.summary,old.digest,old.model)
  assert.equal(store.nodeSourceIncomplete('s',old),true)
  store.setTuning({target_tokens:64000,fanout:4})
  assert.equal(claudeCompactionNodes(store,'s')[0].sourceIncomplete,true)
  store.addNode({...old,sourceComplete:true})
  assert.equal(store.nodeSourceIncomplete('s',old),true)
})

test('a formerly complete Claude node is not certified by a pre-fix quality flag',t=>{
  const {store}=archive(t,[{type:'user',message:{content:'Older image or checkpoint'}}])
  store.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  const old={session:'s',id:'old-quality',level:0,first:0,last:0,children:[],summary:'Old summary',digest:'old',model:'old'}
  store.addNode(old);assert.equal(store.nodeSourceIncomplete('s',old),false)
  store.db.prepare('DELETE FROM claude_node_coverage_v3 WHERE session=? AND id=?').run('s',old.id)
  assert.equal(store.nodeSourceIncomplete('s',old),true)
  store.addNode({...old,sourceComplete:true})
  assert.equal(store.nodeSourceIncomplete('s',old),true,'reinserting the old id cannot upgrade its evidence')
  const originals=store.eventRows('s').map(e=>({ordinal:e.ordinal,digest:e.digest}))
  saveForkTree(store,'s',{digest:'fixture',originals},[{index:0,archiveId:old.id,level:0,firstMessage:0,lastMessage:0,children:[],summary:'Different new summary'}],{model:'offline'})
  assert.equal(store.nodeSourceIncomplete('s',old),true,'replaying a fork cannot certify the previously stored node')
})

test('deleting a synthetic session also removes summary quality and alternate text',t=>{
  const {store}=archive(t,[{type:'user',message:{content:'Synthetic only'}}])
  store.addNode({session:'s',id:'n',level:0,first:0,last:0,children:[],summary:'Synthetic',digest:'x',model:'offline'})
  store.db.exec('CREATE TABLE fork_parent_variants(session TEXT,id TEXT,summary TEXT,PRIMARY KEY(session,id))')
  store.db.prepare('INSERT INTO fork_parent_variants VALUES(?,?,?)').run('s','n','Synthetic alternate')
  store.deleteSession('s')
  for(const table of ['summary_node_quality','claude_node_coverage_v2','claude_node_coverage_v3','fork_parent_variants'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session=?`).get('s').n,0)
})

test('an uncertified old node cannot mark a native checkpoint as covered',t=>{
  const native='This session is being continued from a previous conversation. The original constraint remains important.'
  const {store}=archive(t,[{type:'user',message:{content:'Earlier request'}},{type:'user',isCompactSummary:true,message:{content:native}}])
  store.addNode({session:'s',id:'trusted',level:0,first:0,last:0,children:[],summary:'Earlier request.',digest:'a',model:'offline'})
  store.db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run('s','legacy',0,1,1,'[]','Unverified old node.','b','old')
  const checked=verifiedCompactionInput(store,'s',[{role:'user',text:native,toolUses:[],toolResults:[]}])
  assert.equal(checked.messages[0].nativeSummary,false)
  assert.ok(checked.events[1].exactRaw.includes(native))
})

for(const kind of ['native-boundary','late-compaction','image'])test('Claude fork after '+kind+' cannot certify unseen historical source',t=>{
  const rows=[{type:'user',message:{content:kind==='image'?[{type:'text',text:'Inspect'},{type:'image',source:{type:'base64',data:'synthetic'}}]:'Inspect'}},
    {type:'assistant',message:{content:'Previous answer'}},
    ...(kind==='native-boundary'?[{type:'system',subtype:'compact_boundary'},{type:'user',isCompactSummary:true,message:{content:'Native checkpoint'}}]:[]),
    {type:'user',message:{content:'Continue'}}]
  const {store}=archive(t,rows);store.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  if(kind==='late-compaction')store.markCompaction('s',rows.length)
  const originals=store.eventRows('s').map(e=>({ordinal:e.ordinal,digest:e.digest}))
  const tree=[{index:0,level:0,firstMessage:0,lastMessage:rows.length-1,children:[],summary:'# Current state\nThe task continues.'}]
  const [id]=saveForkTree(store,'s',{digest:'fixture',originals},tree,{model:'offline'})
  assert.equal(store.nodeSourceIncomplete('s',store.node('s',id)),true)
  assert.equal(claudeCompactionNodes(store,'s').find(n=>n.id===id).sourceIncomplete,true)
})

test('a prior native checkpoint preserves the full verified human request, not a notification or preview',t=>{
  const human='Inspect this project. '+ 'Full original constraint. '.repeat(1000)
  const native='This session is being continued from a previous conversation. Work is pending.'
  const rows=[{type:'user',origin:{kind:'human'},message:{content:human}},
    {type:'user',origin:{kind:'task-notification'},message:{content:'Background task notification'}},
    {type:'user',isCompactSummary:true,message:{content:native}},
    {type:'assistant',message:{content:'Later work'}},{type:'assistant',message:{content:'More work'}}]
  const {store}=archive(t,rows)
  store.addNode({session:'s',id:'trusted',level:0,first:0,last:2,children:[],summary:'Work is pending.',digest:'a',model:'offline'})
  const live=[{role:'user',text:native,size:1000},{role:'assistant',text:'Later work',size:1000},{role:'assistant',text:'More work',size:1000}]
  const checked=verifiedCompactionInput(store,'s',live)
  assert.equal(checked.messages[0].nativeSummary,true)
  const tail=turnTail({messages:checked.messages,events:checked.events,cut:3,tokens:3000,total:3000,size:m=>m.size,keepTokens:1,window:100000,force:true})
  assert.equal(tail.request.ordinal,0)
  assert.equal(tail.request.text,human)
})

test('ordinary takeover compares complete active tool payloads, not just repeated text',async()=>{
  const rows=[]
  for(const word of ['alpha','beta','gamma','delta'])rows.push({type:'user',message:{content:word}},{type:'assistant',message:{content:word+' answer'}})
  const h=fixture({rows,tokens:50000,window:300000})
  const s=h.open();try{s.addNode({session:h.id,id:'covered',level:0,first:0,last:5,children:[],summary:'# State\nThree tasks finished.',digest:'d',model:'offline',sourceComplete:true})}finally{s.close()}
  const dto=items=>items.map(m=>({...liveMessage(m),toolResults:m.toolResults?.length?1:0}))
  const good=await h.cli('compact-packet',{messages:dto(h.messages),tokens:h.tokens,window:h.window,trigger:'auto'})
  assert.equal(good.use,true,JSON.stringify(good))
  const live=[...h.messages.slice(0,4),
    {role:'assistant',text:'',toolUses:[{tool_use_id:'late',name:'inspect',input:{x:1}}],toolResults:[]},
    {role:'user',text:'',toolUses:[],toolResults:[{tool_use_id:'late',content:'unarchived result'}]},...h.messages.slice(4)]
  const s2=h.open();try{assert.equal(verifiedActiveMessages(s2,h.id,live,{requireLatest:false}),null)}finally{s2.close()}
  const denied=await h.cli('compact-packet',{messages:dto(live),tokens:h.tokens,window:h.window,trigger:'auto'})
  assert.equal(denied.use,false);assert.match(denied.reason,/not fully verified/)
})

test('an incomplete live tool DTO cannot prove the archived tool payload',t=>{
  const rows=history({steps:2}),{store}=archive(t,rows),live=messages(rows)
  assert.ok(verifiedActiveMessages(store,'s',live))
  const incomplete=structuredClone(live);incomplete.find(m=>m.toolUses.length).toolUses[0]={tool_use_id:'past-0-0'}
  assert.equal(verifiedActiveMessages(store,'s',incomplete),null)
})

test('a live tool result cannot silently drop an archived error flag',t=>{
  const rows=history({steps:2}),block=rows.find(row=>Array.isArray(row.message?.content)&&row.message.content.some(b=>b.type==='tool_result')).message.content[0]
  block.is_error=true
  const {store}=archive(t,rows),live=messages(rows)
  assert.ok(verifiedActiveMessages(store,'s',live))
  delete live.find(m=>m.toolResults.length).toolResults[0].is_error
  assert.equal(verifiedActiveMessages(store,'s',live),null)
})

test('a live message with changed boundary whitespace cannot match archived text',t=>{
  const rows=history({steps:2}),{store}=archive(t,rows),live=messages(rows)
  assert.ok(verifiedActiveMessages(store,'s',live))
  const changed=structuredClone(live);changed[0].text=' '+changed[0].text
  assert.equal(verifiedActiveMessages(store,'s',changed),null)
})

test('even a uniquely matched active sequence cannot drop a message past summary coverage',()=>{
  const active=[{ordinal:1},{ordinal:3},{ordinal:6},{ordinal:7}]
  assert.equal(verifiedCompactionCut(active,{start:2,through:4}),true)
  assert.equal(verifiedCompactionCut(active,{start:3,through:4}),false)
  assert.equal(verifiedCompactionCut(active,{start:2,through:8}),false)
  assert.equal(verifiedCompactionCut([{ordinal:1,nonText:true},{ordinal:2}],{start:1,through:1}),false)
})

test('a Claude rescue refuses an image that its text-only source cannot represent',async()=>{
  const rows=history({steps:10}),old=rows[0].message.content
  rows[0].message.content=[{type:'text',text:old},{type:'image',source:{type:'base64',media_type:'image/png',data:'synthetic'}}]
  const h=fixture({rows});await h.seed(2)
  const result=await h.cli('compact-rescue-prepare',{messages:h.messages,tokens:h.tokens,window:h.window,model:'offline-current'})
  assert.equal(result.work,undefined)
})

test('Claude rescue cannot claim unseen originals merely because the live session starts with a native checkpoint',async()=>{
  const h=fixture({rows:history({native:true,steps:6})})
  const store=h.open();try{assert.ok(verifiedActiveMessages(store,h.id,h.messages))}finally{store.close()}
  const result=await h.cli('compact-rescue-prepare',{messages:h.messages.map(liveMessage),tokens:h.tokens,window:h.window,model:'offline-current'})
  assert.equal(result.use,false)
  assert.equal(result.work,undefined)
})

test('ordinary Claude takeover does not discard a live image hidden by the text-only hook DTO',async()=>{
  const rows=[]
  for(const word of ['alpha','beta','gamma','delta'])rows.push({type:'user',message:{content:word}},{type:'assistant',message:{content:word+' answer'}})
  rows[0].message.content=[{type:'text',text:'alpha'},{type:'image',source:{type:'base64',media_type:'image/png',data:'synthetic'}}]
  const h=fixture({rows,tokens:50000,window:300000}),s=h.open()
  try{s.addNode({session:h.id,id:'covered',level:0,first:0,last:5,children:[],summary:'# State\nThree tasks finished.',digest:'d',model:'offline',sourceComplete:true})}finally{s.close()}
  const live=h.messages.map(m=>({...liveMessage(m),toolResults:m.toolResults?.length?1:0}))
  const denied=await h.cli('compact-packet',{messages:live,tokens:h.tokens,window:h.window,trigger:'auto'})
  assert.equal(denied.use,false);assert.match(denied.reason,/not fully verified|incomplete-source/)
})

test('verification does not retain every previously summarized original',t=>{
  const rows=Array.from({length:12},(_,i)=>({type:'user',message:{content:'old-'+i+' '+ 'x'.repeat(250000)}}))
  rows.push({type:'user',message:{content:'current'}})
  const {store}=archive(t,rows)
  store.addNode({session:'s',id:'old',level:0,first:0,last:11,children:[],summary:'old history',digest:'d',model:'offline',sourceComplete:true})
  const result=verifiedCompactionInput(store,'s',[{role:'user',text:'current'}])
  assert.ok(JSON.stringify(result.events).length<300000)
  assert.ok(result.events.slice(0,12).every(e=>e.exactRaw===undefined&&e.text===undefined))
})

test('long historical prompts sharing a live prefix are not all retained',t=>{
  const prefix='repeated prefix '.repeat(50)
  const rows=Array.from({length:10},(_,i)=>({type:'user',message:{content:prefix+i+' '+ 'x'.repeat(250000)}}))
  rows.push({type:'user',message:{content:prefix+'current'}})
  const {store}=archive(t,rows)
  store.addNode({session:'s',id:'old',level:0,first:0,last:9,children:[],summary:'old history',digest:'d',model:'offline'})
  const result=verifiedCompactionInput(store,'s',[{role:'user',text:prefix+'current'}])
  assert.ok(result.events.slice(0,10).every(e=>e.text===undefined))
  assert.ok(JSON.stringify(result.events).length<300000)
})

test('older assembled parent variants are visible in outline and searchable',t=>{
  const {store}=archive(t,[{role:'user',content:'First original'},{role:'assistant',content:'Second original'}])
  const originals=store.eventRows('s').map(e=>({ordinal:e.ordinal,digest:e.digest}))
  const tree=[
    {index:0,level:0,firstMessage:0,lastMessage:0,children:[],summary:'# First\nOriginal decision.'},
    {index:1,level:0,firstMessage:1,lastMessage:1,children:[],summary:'# Second\nOriginal result.'},
    {index:2,level:1,firstMessage:0,lastMessage:1,children:[0,1],summary:'# First\nOriginal decision.\n\n# Second\nOriginal result.',modelSummary:'# Parent\nUNIQUE_PARENT_CONSTRAINT must be preserved.'}
  ]
  const ids=saveForkTree(store,'s',{digest:'test',originals},tree,{model:'offline'})
  assert.equal(store.outline('s',ids[2]).node.model_variant,tree[2].modelSummary)
  assert.equal(store.outline('s').alternate_summaries[0].id,ids[2])
  const found=store.find('UNIQUE_PARENT_CONSTRAINT',{session:'s'})
  assert.equal(found.summaries[0].id,ids[2]);assert.match(found.summaries[0].summary,/UNIQUE_PARENT_CONSTRAINT/)
})

test('search page continues through the original-record cursor and retains earlier hits',async()=>{
  const source=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8')
  const elements=new Map(['#rows','#listCount','#more'].map(k=>[k,{innerHTML:'',hidden:true,querySelectorAll:()=>[]}]))
  const calls=[],c={session:'s',name:'Synthetic',harness:'pi'},state={query:'needle',h:''}
  const context={state,$:k=>elements.get(k),q:encodeURIComponent,esc:String,mark:()=>'',t:(key,p={})=>key.replace(/\{([^}]+)\}/g,(_,k)=>p[k]),renderList(){},select(){},act:fn=>fn(),revealNode(){},openRaw(){},api:async path=>{
    calls.push(path)
    return calls.length===1?{conversations:[],summaries:[],events:[{conversation:c,ordinal:1,snippet:'needle first'}],search_complete:false,next_cursor:71}
      :{conversations:[],summaries:[],events:[{conversation:c,ordinal:2,snippet:'needle second'}],search_complete:true,next_cursor:null}
  }}
  runInNewContext(source.slice(source.indexOf('async function runSearch('),source.indexOf('/* ---------- conversation detail ---------- */'))+'\nthis.search=runSearch',context)
  await context.search();assert.equal(elements.get('#more').hidden,false)
  await context.search(true);assert.match(calls[1],/cursor=71/);assert.equal(elements.get('#more').hidden,true)
  assert.match(elements.get('#rows').innerHTML,/first/);assert.match(elements.get('#rows').innerHTML,/second/)
})

test('a staged credential never replaces the selected key until its setting transaction commits',t=>{
  const {dir,store}=archive(t,[{role:'user',content:'Synthetic'}]),old='https://old.example.test/v1',next='https://new.example.test/v1'
  saveApiKey(store.dir,'global','old-synthetic-key',old)
  store.setGlobalSetting('api','old-model','openai',old)
  const revision=stageApiKey(store.dir,'global','new-synthetic-key',next)
  assert.equal(readApiKey(store.dir,'global',old),'old-synthetic-key')
  store.db.exec('BEGIN IMMEDIATE')
  store.setGlobalSetting('api','new-model','openai',next);bindApiKey(store.db,'global',revision)
  store.db.exec('ROLLBACK')
  assert.equal(store.globalSetting().model,'old-model')
  assert.equal(readApiKey(store.dir,'global',old),'old-synthetic-key')
  assert.equal(readApiKey(store.dir,'global',next),null)
  const reopened=new ClaudeStore(store.dir);try{assert.equal(readApiKey(reopened.dir,'global',old),'old-synthetic-key');assert.equal(reopened.globalSetting().model,'old-model')}finally{reopened.close()}
  assert.equal(readFileSync(join(dir,'store','lcm.sqlite')).includes('new-synthetic-key'),false)
})

test('a failed legacy settings commit leaves its former endpoint and credential together',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-setting-transaction-')),store=new ClaudeStore(join(dir,'store')),web=await startWeb({store,port:0})
  const post=body=>fetch(web.url+'api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  try{
    const old={scope:'global',mode:'api',api_provider:'openai',api_url:'https://old.example.test/v1',model:'model-a',api_key:'old-synthetic-key'}
    assert.equal((await post(old)).status,200);const previous=store.globalSetting()
    store.db.exec("CREATE TRIGGER synthetic_setting_binding_failure BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END")
    const response=await post({...old,api_url:'https://new.example.test/v1',api_key:'new-synthetic-key'})
    assert.equal(response.status,400);assert.equal(store.globalSetting().api_url,previous.api_url)
    assert.equal(readApiKey(store.dir,'global',previous.api_url),'old-synthetic-key')
  }finally{await web.close()}
})

test('a failed model settings commit leaves its former endpoint and credential together',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-credential-transaction-')),store=new ClaudeStore(join(dir,'store')),web=await startWeb({store,port:0})
  const post=body=>fetch(web.url+'api/api-models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  try{
    const old={api_provider:'openai',api_url:'https://old.example.test/v1',model:'model-a',api_key:'old-synthetic-key',skip_test:true}
    const first=await post(old);assert.equal(first.status,200);const model=await first.json(),scope='model:'+model.id
    store.db.exec("CREATE TRIGGER synthetic_binding_failure BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT, 'synthetic binding failure'); END")
    const response=await post({...old,id:model.id,api_url:'https://new.example.test/v1',api_key:'new-synthetic-key'})
    assert.equal(response.status,400)
    assert.equal(store.apiModel(model.id).url,model.url)
    assert.equal(readApiKey(store.dir,scope,model.url),'old-synthetic-key')
    assert.equal(readApiKey(store.dir,scope,'https://new.example.test/v1/chat/completions'),null)
  }finally{await web.close()}
})

test('concurrent model edits commit a matching endpoint and key after a delayed probe',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-setting-race-')),store=new ClaudeStore(join(dir,'store'))
  let beginProbe,finishProbe
  const started=new Promise(resolve=>beginProbe=resolve),gate=new Promise(resolve=>finishProbe=resolve)
  const web=await startWeb({store,port:0,probeModel:async()=>{beginProbe();await gate;return '# Ready'}})
  const post=body=>fetch(web.url+'api/api-models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  try{
    const old={api_provider:'openai',api_url:'https://old.example.test/v1',model:'model-a'}
    const initial=await (await post({...old,api_key:'old-synthetic-key',skip_test:true})).json()
    const delayed=post({...old,id:initial.id});await started
    const concurrent=await post({...old,id:initial.id,api_url:'https://new.example.test/v1',api_key:'new-synthetic-key',skip_test:true})
    assert.equal(concurrent.status,200);finishProbe();assert.equal((await delayed).status,200)
    assert.equal(store.apiModel(initial.id).url,initial.url)
    assert.equal(readApiKey(store.dir,'model:'+initial.id,initial.url),'old-synthetic-key')
  }finally{finishProbe();await web.close()}
})

test('a slow model edit with a blank key does not restore an older key for the same endpoint',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-setting-key-race-')),store=new ClaudeStore(join(dir,'store'))
  let beginProbe,finishProbe
  const started=new Promise(resolve=>beginProbe=resolve),gate=new Promise(resolve=>finishProbe=resolve)
  const web=await startWeb({store,port:0,probeModel:async()=>{beginProbe();await gate;return '# Ready'}})
  const post=body=>fetch(web.url+'api/api-models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  try{
    const model={api_provider:'openai',api_url:'https://example.test/v1',model:'model-a'}
    const initial=await (await post({...model,api_key:'old-synthetic-key',skip_test:true})).json()
    const delayed=post({...model,id:initial.id,model:'model-b'});await started
    assert.equal((await post({...model,id:initial.id,api_key:'new-synthetic-key',skip_test:true})).status,200)
    finishProbe()
    const result=await delayed,output=await result.json()
    assert.equal(result.status,200);assert.equal(output.tested,false)
    assert.equal(store.apiModel(initial.id).model,'model-b')
    assert.equal(readApiKey(store.dir,'model:'+initial.id,initial.url),'new-synthetic-key')
  }finally{finishProbe();await web.close()}
})
