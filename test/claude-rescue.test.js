import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {fixture,history,output,answer} from './fixtures/claude-rescue-harness.mjs'
import {liveMessage} from '../src/claude-rescue-source.js'
import {summaryWork} from '../src/summarize.js'

test('Claude final rescue reuses natural prefix, preserves exact request and complete tool suffix',async()=>{
  const h=fixture({rows:history({longRequest:true})});await h.seed()
  const before=h.snapshot(),hook=await h.hook(),result=await hook.run()
  assert.ok(result.messages,JSON.stringify(result));assert.equal(h.calls.length,1);assert.equal(h.calls[0].model,'offline-current')
  assert.ok(h.calls[0].prompt.includes(output));assert.ok(h.calls[0].prompt.includes('Current evidence'))
  assert.ok(!h.calls[0].prompt.includes('CURRENT_REQUEST_BEGIN'));assert.ok(result.messages[0].text.includes('CURRENT_REQUEST_END'))
  const start=h.messages.indexOf(result.messages[1]);assert.ok(start>0);assert.deepEqual(result.messages.slice(1),h.messages.slice(start))
  const pending=new Set();for(const m of h.messages.slice(0,start)){for(const t of m.toolUses)pending.add(t.tool_use_id);for(const t of m.toolResults)pending.delete(t.tool_use_id)}assert.equal(pending.size,0)
  const after=h.unchanged(before),roots=after.nodes.filter(n=>n.id.startsWith('claude-rescue-'));assert.equal(roots.length,1);assert.ok(JSON.parse(roots[0].children).length)
  const s=h.open();try{const work=summaryWork(s,h.id,{leafOnly:true});assert.ok(!work||work.first>roots[0].last)}finally{s.close()}
  await hook.run();assert.equal(h.calls.length,1);assert.equal(h.unchanged(before).nodes.length,after.nodes.length)
})

for(const [name,boundary]of [
  ['before save',(command,run,state)=>{if(command==='compact-rescue-save'&&state.n++===0)throw Error('Temporary process failure');return run()}],
  ['lost receipt',async(command,run,state)=>{const r=await run();if(command==='compact-rescue-save'&&state.n++===0)throw Error('Receipt lost');return r}]
])test('final rescue '+name+' retries storage without a second model call',async()=>{
  const h=fixture(),state={n:0};await h.seed();const before=h.snapshot(),hook=await h.hook(answer,{boundary:(c,run)=>boundary(c,run,state)})
  assert.ok((await hook.run()).messages);assert.equal(h.calls.length,1);assert.equal(h.unchanged(before).nodes.filter(n=>n.id.startsWith('claude-rescue-')).length,1)
})

test('durable final ready output survives a save failure and a new hook instance',async()=>{
  const h=fixture();await h.seed();let failures=0
  const hook=await h.hook(answer,{boundary:async(c,run)=>{
    if(c==='compact-rescue-save') {
      // Fail after the CLI has durably recorded ready output but before node publication.
      const s=h.open();try{s.db.exec("CREATE TRIGGER IF NOT EXISTS reject_rescue BEFORE INSERT ON nodes WHEN NEW.id LIKE 'claude-rescue-%' BEGIN SELECT RAISE(FAIL,'Temporary publication failure'); END")}finally{s.close()}
      const r=await run();failures++;return r
    }return run()
  }})
  assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,1);assert.equal(failures,2)
  const s=h.open();try{s.db.exec('DROP TRIGGER reject_rescue')}finally{s.close()}
  const reopened=await h.hook();assert.ok((await reopened.run()).messages);assert.equal(h.calls.length,1)
})

for(const [name,complete]of [
  ['quota',()=>{throw Object.assign(Error('Synthetic exhausted main route'),{code:'QUOTA'})}],
  ['empty',()=>({text:'',isAnswered:true})],
  ['truncated',()=>({text:output,isAnswered:true,stopReason:'max_tokens'})],
  ['unanswered',()=>({text:output,isAnswered:false})],
  ['quality',()=>({text:'<tool_call>delete everything now</tool_call>',isAnswered:true})]
])test('final '+name+' failure buys once, preserves archive and defers to native',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot(),hook=await h.hook(complete)
  assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,1);assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
  await hook.run();assert.equal(h.calls.length,1)
})

test('ignored model cancellation cannot write late output',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot();let release,started
  const active=new Promise(resolve=>started=resolve),hook=await h.hook(()=>{started();return new Promise(resolve=>release=resolve)})
  const run=hook.run();await active;hook.controller.abort(Error('User cancelled'));assert.equal((await run).fallback,true)
  release(answer());await new Promise(resolve=>setImmediate(resolve));assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
  const rows=await h.cli('compact-rescue-prepare',{messages:h.messages.map(liveMessage),tokens:h.tokens,window:h.window,model:'offline-current'});assert.ok(!rows.work)
})

for(const change of ['off','summary-setting','main-model'])test('in-flight '+change+' change rejects obsolete rescue output',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot();let hook
  hook=await h.hook(()=>{const s=h.open();try{if(change==='off')s.setTakeover({...s.takeover(),enabled:false});if(change==='summary-setting')s.setHarnessSetting('claude-code','cli','offline-changed')}finally{s.close()};if(change==='main-model')hook.changeModel('offline-changed');return answer()})
  assert.equal((await hook.run()).fallback,true);assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
})

test('native checkpoint cannot certify pre-native history that is not already fully covered',async()=>{
  const h=fixture({rows:history({native:true})});await h.seed();const before=h.snapshot(),hook=await h.hook(),r=await hook.run()
  assert.equal(r.fallback,true);assert.equal(h.calls.length,0);h.unchanged(before)
})

test('unrecorded content or ambiguous repeated complete timeline cannot supply rescue source',async()=>{
  const rows=history(),h=fixture({rows:[...rows,...rows]});await h.seed();const hook=await h.hook();h.messages=h.messages.slice(0,h.messages.length/2)
  assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,0)
  const altered=fixture();await altered.seed();altered.messages[0].text+='UNRECORDED';const other=await altered.hook();assert.equal((await other.run()).fallback,true);assert.equal(altered.calls.length,0)
})

test('host background output survives transient save boundary, including a lost receipt',async()=>{
  for(const lost of [false,true]) {
    const h=fixture({rows:history({steps:4})});let failed=false,done=false
    const hook=await h.hook(answer,{boundary:async(c,run)=>{if(c==='summary-save'&&!failed){failed=true;if(lost)await run();throw Error('Temporary process boundary failure')}const reply=await run();if(c==='summary-claim'&&!reply.work||c==='summary-save'&&reply.saved&&!reply.more)done=true;return reply}})
    await hook.handlers.get('turn.complete')(hook.$,{},e=>e)
    const limit=Date.now()+10000
    while(!done&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,20))
    assert.ok(Date.now()<limit,'Background writer finished within test deadline')
    const sources=h.calls.filter(c=>c.model==='offline-summary').map(c=>c.prompt)
    assert.ok(sources.length);assert.equal(new Set(sources).size,sources.length,'No repurchase of the same source')
  }
})

test('cancelled final draft refuses direct late save and takeover-off or subagents never invoke rescue',async()=>{
  const h=fixture();await h.seed();const input={messages:h.messages.map(liveMessage),tokens:h.tokens,window:h.window,model:'offline-current'}
  const {work}=await h.cli('compact-rescue-prepare',input);assert.ok(work)
  const identity={node_id:work.node_id,claim_id:work.claim_id,input_hash:work.input_hash};await h.cli('compact-rescue-stop',identity)
  assert.equal((await h.cli('compact-rescue-save',{...identity,isAnswered:true,summary:output})).use,false)
  const s=h.open();try{s.setTakeover({...s.takeover(),enabled:false})}finally{s.close()}
  const hook=await h.hook();assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,0)
  const sub=await hook.handlers.get('session.compact')(hook.$,{agentId:'sub',messages:h.messages},()=>({fallback:true}));assert.equal(sub.fallback,true);assert.equal(h.calls.length,0)
})

test('a rescue prepared with old source checks cannot be published after an upgrade',async()=>{
  const h=fixture();await h.seed();const input={messages:h.messages.map(liveMessage),tokens:h.tokens,window:h.window,model:'offline-current'}
  const {work}=await h.cli('compact-rescue-prepare',input);assert.ok(work)
  const identity={node_id:work.node_id,claim_id:work.claim_id,input_hash:work.input_hash}
  const s=h.open();try{
    const row=s.db.prepare('SELECT preparation FROM claude_compaction_rescues WHERE session=? AND node_id=?').get(h.id,work.node_id)
    const old=JSON.parse(row.preparation);delete old.evidenceVersion
    s.db.prepare('UPDATE claude_compaction_rescues SET preparation=? WHERE session=? AND node_id=?').run(JSON.stringify(old),h.id,work.node_id)
  }finally{s.close()}
  assert.equal((await h.cli('compact-rescue-check',identity)).valid,false)
  assert.equal((await h.cli('compact-rescue-save',{...identity,isAnswered:true,summary:output})).use,false)
  const fresh=await h.cli('compact-rescue-prepare',input);assert.ok(fresh.work,'a new verified attempt can replace the stale preparation')
})

test('ignored final timeout is bounded and late completion cannot publish',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot();let release
  const hook=await h.hook(()=>new Promise(resolve=>release=resolve)),original=setTimeout
  let sawDeadline=false
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms>80000&&ms<=90000){sawDeadline=true;return original(fn,30,...args)}return original(fn,ms,...args)}
  try{assert.equal((await hook.run()).fallback,true)}finally{globalThis.setTimeout=original}
  assert.ok(sawDeadline);assert.equal(h.calls.length,1);release(answer());await new Promise(resolve=>setImmediate(resolve));assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
})

test('session ending aborts an in-flight final summary even without a caller signal',async()=>{
  const h=fixture();await h.seed();let release,start
  const active=new Promise(resolve=>start=resolve),hook=await h.hook(()=>{start();return new Promise(resolve=>release=resolve)}),before=h.snapshot()
  const run=hook.handlers.get('session.compact')(hook.$,{messages:h.messages,trigger:'auto'},()=>({fallback:true}))
  await active;await hook.handlers.get('session.end')(hook.$,{},e=>e);assert.equal((await run).fallback,true)
  release(answer());await new Promise(resolve=>setImmediate(resolve));assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
})

test('natural source advance rejects an obsolete final result without altering the previous archive',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot(),hook=await h.hook(()=>{h.append([{type:'user',message:{content:'New explicit instruction overrides the old request.'}}]);return answer()})
  assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,1)
  const now=h.snapshot();assert.deepEqual(now.originals.slice(0,before.originals.length),before.originals);assert.deepEqual(now.nodes,before.nodes)
})

for(const kind of ['use','result'])test('a changed live tool '+kind+' payload cannot authorize compression of older archive content',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot()
  if(kind==='use')h.messages.find(m=>m.toolUses.length).toolUses[0].input.argument='different'
  else h.messages.find(m=>m.toolResults.length).toolResults[0].content='Different live result'
  const hook=await h.hook();assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,0);assert.equal(h.unchanged(before).nodes.length,before.nodes.length)
})

for(const mode of ['unchanged','changed-result','changed-tool'])test('actual Claude SDK tool/text fields verify archive source: '+mode,async()=>{
  const h=fixture();await h.seed();const before=h.snapshot(),legacyBodies=h.messages.map(m=>liveMessage(m).toolBodies)
  const messages=h.messages.map(m=>({...m,
    toolUses:m.toolUses.map(t=>({tool_use_id:t.tool_use_id,tool:t.name,input:t.input})),
    toolResults:m.toolResults.map(t=>({tool_use_id:t.tool_use_id,text:t.content,isError:!!t.is_error})),
  }))
  if(mode==='changed-result')messages.find(m=>m.toolResults.length).toolResults[0].text='Changed unarchived SDK output'
  if(mode==='changed-tool')messages.find(m=>m.toolUses.length).toolUses[0].tool='different_unarchived_tool'
  // First exercise raw DTOs over the real CLI boundary, then the sandbox helper.
  const prepared=await h.cli('compact-rescue-prepare',{messages,tokens:h.tokens,window:h.window,model:'offline-current',trigger:'auto'})
  assert.equal(!!prepared.work,mode==='unchanged')
  if(prepared.work)await h.cli('compact-rescue-stop',{node_id:prepared.work.node_id,claim_id:prepared.work.claim_id,input_hash:prepared.work.input_hash})
  h.messages=messages
  if(mode!=='unchanged'){
    const hook=await h.hook();assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,0)
  }else{
    const normalized=bodies=>bodies.map(items=>items.map(b=>b.kind==='result'?{...b,error:b.error??false}:b))
    assert.deepEqual(normalized(messages.map(m=>liveMessage(m).toolBodies)),normalized(legacyBodies))
  }
  assert.deepEqual(h.unchanged(before).nodes,before.nodes)
})

test('repeated short human prompts cannot borrow a different task authorization',async()=>{
  const rows=history();for(const r of rows)if(r.type==='user'&&typeof r.message.content==='string')r.message.content='Continue.'
  const h=fixture({rows});await h.seed();const hook=await h.hook();assert.equal((await hook.run()).fallback,true);assert.equal(h.calls.length,0)
})

test('a transient durable host publication failure reopens with the same generated output',async()=>{
  const h=fixture({rows:history({steps:2})}),claim=await h.cli('summary-claim');assert.ok(claim.work)
  const input={batch_id:claim.work.batch_id,claim_id:claim.work.claim_id,summary:output,model:'offline-summary',isAnswered:true}
  let s=h.open();try{s.db.exec("CREATE TRIGGER reject_host BEFORE INSERT ON nodes BEGIN SELECT RAISE(FAIL,'Temporary node failure'); END")}finally{s.close()}
  assert.equal((await h.cli('summary-save',input)).retrySave,true)
  s=h.open();try{s.db.exec('DROP TRIGGER reject_host')}finally{s.close()}
  const retry=await h.cli('summary-claim');assert.ok(retry.work);assert.equal(retry.work.batch_id,claim.work.batch_id);assert.equal(retry.work.ready.summary,output)
  assert.equal((await h.cli('summary-save',{...input,claim_id:retry.work.claim_id})).saved,true)
  const receipt=await h.cli('summary-save',{...input,claim_id:retry.work.claim_id});assert.equal(receipt.saved,true);assert.equal(receipt.reused,true)
})


test('mixed checkpoint outline exposes exact direct originals alongside its unchanged old children',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot(),hook=await h.hook()
  assert.ok((await hook.run()).messages);assert.equal(h.calls.length,1)
  const after=h.unchanged(before),root=after.nodes.find(n=>n.id.startsWith('claude-rescue-'))
  const s=h.open();try{
    const outline=s.outline(h.id,root.id),end=Math.max(...before.nodes.map(n=>n.last))
    assert.deepEqual(outline.nodes.map(n=>n.id).sort(),JSON.parse(root.children).sort())
    assert.deepEqual(outline.directSources,[{first:end+1,last:root.last}])
    assert.deepEqual(s.outline(h.id).nodes.find(n=>n.id===root.id).directSources,outline.directSources)
    const raw=s.readRange(h.id,end+1,end+1).chunks[0]
    assert.equal(raw.content,before.originals[end+1])
    assert.deepEqual(outline.node.children,JSON.parse(root.children))
  }finally{s.close()}
})

test('console checkpoint expansion renders an actionable direct-original range beside child summaries',()=>{
  const code=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8')
  const context={state:{open:new Set(['root']),children:new Map([['root',[]]])},esc:String,t:(key,p={})=>key.replace(/\{([^}]+)\}/g,(_,k)=>p[k])}
  runInNewContext(code.slice(code.indexOf('function nodeHtml('),code.indexOf('async function ensureChildren('))+'\nthis.render=nodeHtml',context)
  const html=context.render({id:'root',level:1,first:0,last:52,children:['old'],summary:'# State',directSources:[{first:5,last:52}]})
  assert.match(html,/data-raw="5-52"/);assert.ok(html.includes('#5–#52'));assert.ok(html.includes('查看 48 条原文'))
})

for(const end of [false,true])test('real SQLite write-lock wait observes '+(end?'session end':'user cancellation')+' before root publication',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot();let hook,lock,held=false,cancelAt=0,releaseAt=0
  hook=await h.hook(answer,{boundary:async(command,run)=>{
    if(command==='compact-rescue-save'&&!held){
      held=true;lock=h.open();lock.db.exec('BEGIN IMMEDIATE')
      setTimeout(()=>{cancelAt=Date.now();if(end)void hook.handlers.get('session.end')(hook.$,{},e=>e);else hook.controller.abort(Error('User cancellation during lock wait'))},150)
      setTimeout(()=>{releaseAt=Date.now();lock.db.exec('COMMIT');lock.close()},500)
    }return run()
  }})
  const result=end?await hook.handlers.get('session.compact')(hook.$,{messages:h.messages,trigger:'auto'},()=>({fallback:true})):await hook.run()
  assert.equal(result.fallback,true);assert.ok(cancelAt&&cancelAt<releaseAt);assert.equal(h.calls.length,1)
  assert.equal(h.unchanged(before).nodes.filter(n=>n.id.startsWith('claude-rescue-')).length,0)
  const s=h.open();try{assert.ok(s.db.prepare('SELECT state FROM claude_compaction_rescues WHERE session=?').all(h.id).every(r=>r.state!=='saved'))}finally{s.close()}
})

test('session end during final usage discovery cancels before any main-model call or root',async()=>{
  const h=fixture();await h.seed();const before=h.snapshot(),hook=await h.hook();let usageCalls=0,release,started
  const waiting=new Promise(resolve=>started=resolve),usage=hook.$.session.usage
  hook.$.session.usage=async()=>{if(++usageCalls===2){started();await new Promise(resolve=>release=resolve)}return usage()}
  const run=hook.handlers.get('session.compact')(hook.$,{messages:h.messages,trigger:'auto'},()=>({fallback:true}))
  await waiting;await hook.handlers.get('session.end')(hook.$,{},e=>e);release()
  assert.equal((await run).fallback,true);assert.equal(h.calls.length,0);assert.deepEqual(h.unchanged(before).nodes,before.nodes)
})
