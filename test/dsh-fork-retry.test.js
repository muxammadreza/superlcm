import test from 'node:test'
import assert from 'node:assert/strict'
import {lab,history,send,close,count,until,tick,message} from './reliability/lab.mjs'
import {forkScope,captureMainRequest} from '../dsh/main-fork.js'
import {compressionSnapshot} from '../src/compression-status.js'
import {DatabaseSync} from 'node:sqlite'

function tree(options) {
 const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
 const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
 return JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve original constraints, source references and pending work.'}))})
}

test('Persian DSH fork retries Arabic output before replacing the active context',async t=>{
 const fa='لطفا این فایل را بخوان و بگو چرا خطا می‌دهد. می‌خواهم که پلاگین را نصب کنی و گزارش بدهی'
 const ar='من فضلك اقرأ هذا الملف وأخبرني لماذا يظهر الخطأ. أريد أن تثبت الإضافة وتكتب لي تقريرا'
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),prompts=[];let pending
 try{
  while(h.ctx.tokenMeter.measure(h.agent.session).totalTokens<64000*.9){
   if(h.agent.session.snapshotEvents().length>200)throw Error('Persian fixture did not reach the intended pressure')
   h.agent.session.append('user/message',message(fa.repeat(60)),{surfaceOp:'append'})
  }
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('');prompts.push(prompt)
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   const text=prompts.length===1?'# ملخص\n'+ar:'# وضعیت\n'+fa
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:text}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout','Date']})
  pending=send(h,'KEEP THE NEW REQUEST EXACTLY',{timeout:10000000})
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  const state=h.engine.backgroundFolds.get(h.agent)
  assert.match(prompts[0],/Use Persian/)
  assert.equal(count(h,'compaction/summary'),0);assert.equal(h.main.length,0)
  t.mock.timers.tick(state.retryAt-Date.now())
  await pending
  assert.equal(prompts.length,2);assert.match(prompts[1],/previous attempt failed output validation/)
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main[0].content.includes('KEEP THE NEW REQUEST EXACTLY'))
  assert.ok(h.agent.session.snapshotEvents().some(event=>JSON.stringify(event).includes(fa)))
 }finally{
  h.agent.cancel({kind:'user'},{keepInbox:true});t.mock.timers.reset()
  await pending;await close(h)
 }
})

test('a native fork can run past ten minutes while real output continues',async t=>{
 const h=await lab({capacity:500000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),gates=[];let branches=0,pending
 try{
  history(h,.91)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   for(let i=0;i<3;i++){
    await new Promise(resolve=>gates.push(resolve))
    yield {type:'reasoning-delta',index:0,text:'ongoing model output'}
   }
   yield {type:'text-delta',index:1,text:tree(options)}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout','Date']})
  pending=send(h,'PRESERVE INPUT WHILE SUMMARY IS STREAMING',{timeout:10000000})
  await until(()=>gates.length===1)
  for(let i=0;i<3;i++){
   t.mock.timers.tick(540000)
   assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'summarizing')
   gates.shift()()
   if(i<2)await until(()=>gates.length===1)
  }
  await pending
  assert.equal(branches,1,'progress must not restart a healthy stream')
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main[0].content.includes('PRESERVE INPUT WHILE SUMMARY IS STREAMING'))
 }finally{
  h.agent.cancel({kind:'user'},{keepInbox:true});for(const release of gates)release();t.mock.timers.reset()
  await pending;await close(h)
 }
})

test('empty stream activity cannot keep an unproductive native fork alive',async t=>{
 const h=await lab({capacity:500000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let release,pending,started=false,emitted=false
 try{
  history(h,.91)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   started=true;await new Promise(resolve=>release=resolve)
   yield {type:'reasoning-delta',index:0,text:'   '}
   yield {type:'usage',usage:{inputTokens:1}}
   emitted=true;await new Promise(()=>{})
  })()
  t.mock.timers.enable({apis:['setTimeout','Date']})
  pending=send(h,'PRESERVE INPUT ACROSS AN IDLE FORK',{timeout:10000000})
  await until(()=>started)
  t.mock.timers.tick(540000);release();await until(()=>emitted)
  t.mock.timers.tick(60001)
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  const state=h.engine.backgroundFolds.get(h.agent)
  assert.equal(state.errorKind,'timeout');assert.equal(state.failures,1)
  assert.equal(count(h,'compaction/summary'),0);assert.equal(h.main.length,0)
 }finally{
  h.agent.cancel({kind:'user'},{keepInbox:true});release?.();t.mock.timers.reset()
  await pending;await close(h)
 }
})

test('native fork retries beyond ten total minutes and five failures while the admitted request stays paused',async t=>{
 const h=await lab({capacity:500000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 let release,pending,settled=false
 const barrier=new Promise(resolve=>release=resolve)
 try{
  history(h,.91)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   const attempt=branches.length
   branches.push(options)
   if(attempt<5)await barrier // Deliberately ignore cancellation; late output must be fenced.
   if(attempt===5)throw Object.assign(Error('Synthetic provider quota failure'),{code:'ACCOUNT_QUOTA'})
   yield {type:'text-delta',index:0,text:attempt===6?'malformed JSON':tree(options)}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout','Date']})
  pending=send(h,'KEEP THE ADMITTED INPUT EXACTLY',{timeout:10000000}).then(()=>{settled=true})
  await until(()=>branches.length===1)
  const frozen=h.engine.mainRequests.get(h.agent)
  // Simulate a later captured request without changing the selected source.
  // Every retry must continue to use the original frozen wire prefix.
  captureMainRequest(h.engine,h.agent,{...frozen.request,messages:[...frozen.request.messages,{role:'user',content:[{type:'text',text:'NEWER REQUEST MUST NOT LEAK INTO RETRIES'}]}]})
  for(let attempt=1;attempt<=7;attempt++){
   if(attempt<=5)t.mock.timers.tick(600001)
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   const state=h.engine.backgroundFolds.get(h.agent)
   assert.equal(state.attempt,attempt)
   assert.equal(state.failures,attempt)
   assert.equal(settled,false,'foreground has no overall ten-minute deadline')
   assert.equal(h.main.length,0,'capacity guard must remain closed during all retries')
   const db=new DatabaseSync(h.engine.superLcmStore.path,{readOnly:true})
   let job;try{job=compressionSnapshot({db}).jobs.find(j=>j.session===h.id)}finally{db.close()}
   assert.equal(job.phase,'retrying');assert.equal(job.attempt,attempt)
   assert.equal(job.error_kind,attempt<=5?'timeout':attempt===6?'quota':'invalid_json')
   t.mock.timers.tick(state.retryAt-Date.now())
   await until(()=>branches.length===attempt+1)
  }
  await pending
  assert.equal(branches.length,8)
  assert.equal(count(h,'compaction/summary'),1)
  assert.equal(h.main.length,1)
  assert.ok(h.main[0].content.includes('KEEP THE ADMITTED INPUT EXACTLY'))
  for(const options of branches){
   assert.deepEqual(options.messages.slice(0,-1),frozen.request.messages)
   assert.equal(options.provider,frozen.request.provider)
   assert.equal(options.model,frozen.request.model)
  }
  assert.ok(branches.slice(0,5).every(o=>o.signal.aborted))
  assert.ok(branches[7].messages.at(-1).content[0].text.includes('previous attempt failed output validation'))
  release();await tick()
  assert.equal(count(h,'compaction/summary'),1,'late aborted attempts must never replace again')
 }finally{
  h.agent.cancel({kind:'user'},{keepInbox:true});release?.();t.mock.timers.reset()
  await pending;await close(h)
 }
})

test('an idle conversation retries in the background without another user request',async t=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   if(branches===1)throw Object.assign(Error('Synthetic transport failure'),{code:'TRANSPORT'})
   yield {type:'text-delta',index:0,text:tree(options)}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout']})
  await send(h,'ALLOW ORDINARY WORK WHILE PREPARING')
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  assert.equal(h.main.length,1)
  t.mock.timers.tick(1000)
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches,2)
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready')
  assert.equal(h.main.length,1,'background retry did not buy a foreground turn')
  await send(h,'LATER INPUT '+ 'x'.repeat(30000))
  assert.equal(branches,2);assert.equal(count(h,'compaction/summary'),1)
 }finally{t.mock.timers.reset();await close(h)}
})

for(const cancellation of ['user','settings','model','source','dispose'])test('native fork stops retrying on '+cancellation,async t=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:600000,summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm)
 let branches=0,pending
 try{
  history(h,.91)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){branches++;throw Error('Synthetic transport failure')})()
  t.mock.timers.enable({apis:['setTimeout']})
  pending=send(h,'CURRENT INPUT SURVIVES CANCELLATION',{timeout:10000000})
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  assert.equal(branches,1);assert.equal(h.main.length,0)
  if(cancellation==='user')h.agent.cancel({kind:'user'},{keepInbox:true})
  else if(cancellation==='settings')h.engine.applyRuntimeConfig({...h.engine.rollingConfig,summarizationProvider:'lab-primary',summarizationModel:'summary'})
  else if(cancellation==='model'){
   const header=structuredClone(h.agent.session.requestHeader())
   header.config.model='main-128000'
   h.agent.session.append('request/header',{header,reason:'model-changed'})
   t.mock.timers.tick(1000)
  }
  else if(cancellation==='source'){
   const state=h.engine.backgroundFolds.get(h.agent)
   const seq=state.prepared.start,text=h.agent.session.eventAt(seq).data.content[0].text
   h.agent.session.append('user/message',message('SOURCE CHANGED '+ 'x'.repeat(text.length)),{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]})
   t.mock.timers.tick(1000)
  }
  else{
   // The real owner's retirement aborts every task before disposing its store.
   for(const controller of h.engine.backgroundControllers)controller.abort(Error('SuperLcm disposed'))
   await h.engine.settleBackgroundFold(h.agent)
   h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await pending
  await h.engine.settleBackgroundFold(h.agent)
  t.mock.timers.tick(1000000);await tick()
  assert.equal(branches,1)
  assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes('CURRENT INPUT SURVIVES CANCELLATION')))
 }finally{h.agent.cancel({kind:'user'},{keepInbox:true});t.mock.timers.reset();await pending;await close(h)}
})
