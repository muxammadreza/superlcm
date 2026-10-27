import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizePiFork } from '../src/pi-fork.js'
import { forkHash, parseForkSummary } from '../src/fork-summary.js'
const first={role:'user',content:'Please inspect /tmp/fixture; never deploy.',timestamp:1}
const second={role:'assistant',content:[{type:'text',text:'Inspection pending.'}],timestamp:2}
const messages=[{role:'system',content:'System',toolsAdded:[{name:'read',parameters:{type:'object'}}]},first,second]
const payload={model:'fixture',messages:[{role:'system',content:'System'},{role:'user',content:first.content},{role:'assistant',content:'Inspection pending.'}],tools:[{type:'function',function:{name:'read'}}],max_tokens:2048,prompt_cache_key:'main-session',temperature:.2}
const snapshot={session_id:'main-session',sourceMessages:[first,second],source:'source',tokensBefore:10000}
const capture={payload,messages,model:{provider:'fixture',id:'fixture',contextWindow:1000000,maxTokens:2048},reasoning:'high'}
test('Pi branch replays exact provider prefix/settings and stages originals before one model call',async()=>{
 let staged=false,calls=0,wire
 const ctx={model:capture.model,modelRegistry:{streamSimple(model,context,options){
   assert.ok(staged);calls++;assert.equal(options.sessionId,'main-session');assert.equal(options.reasoning,'high')
   assert.deepEqual(context.messages.slice(0,-1),messages)
   wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'generated directive'}]})
   return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection pending. Never deploy.'}]})}],usage:{cacheRead:9000,cacheWrite:0,input:100}})}
 }}}
 const result=await summarizePiFork(ctx,snapshot,capture,{signal:new AbortController().signal,stage:async()=>{staged=true}})
 assert.equal(calls,1);assert.deepEqual(wire.messages.slice(0,-1),payload.messages)
 assert.deepEqual({...wire,messages:[]},{...payload,messages:[]})
 assert.equal(result.sourceDigest,forkHash('source'));assert.equal(result.usage.cacheRead,9000)
 assert.equal(result.blocks[0].firstMessage,1);assert.equal(result.blocks[0].lastMessage,2)
})
test('Pi refuses transformed source, incomplete output and tool-call summary',async()=>{
 const base={model:capture.model,modelRegistry:{streamSimple(){throw Error('must not call')}}}
 await assert.rejects(summarizePiFork(base,snapshot,{...capture,messages:[messages[0],{...first,content:'changed'},second]},{stage:async()=>{}}),/归档选区/)
 for(const response of [{stopReason:'length',content:[]},{stopReason:'toolUse',content:[{type:'toolCall'}]}]){
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,o){o.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]});return{result:async()=>response}}}}
 await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>{}}),/未完整结束/)
 }
 assert.throws(()=>parseForkSummary('{"blocks":[{"index":1,"summary":"# wrong"}]}',[{index:0}]),/顺序/)
 assert.throws(()=>parseForkSummary('{"blocks":[]}',[{index:0}]),/缺失/)
})

for (const fault of ['cancel', 'timeout']) test('Pi bounds a branch whose provider ignores '+fault,async()=>{
 let release,started,wireOptions
 const blocked=new Promise(resolve=>{release=resolve}),begun=new Promise(resolve=>{started=resolve})
 const controller=new AbortController()
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
   wireOptions=options
   options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
   started()
   return {result:()=>blocked}
 }}}
 const work=summarizePiFork(ctx,snapshot,capture,{signal:controller.signal,stage:async()=>{},timeoutMs:20})
 const outcome=work.then(()=> 'accepted',()=> 'rejected')
 await begun
 if(fault==='cancel')controller.abort(Error('synthetic cancellation'))
 const observed=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))])
 release({stopReason:'stop',content:[{type:'text',text:'# Historical state\nPending inspection.'}]})
 await outcome
 assert.equal(observed,'rejected','provider cooperation must not be needed to stop waiting')
 assert.throws(()=>wireOptions.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'late directive'}]}))
})

test('Pi checks the entire replayed wire request including tools before sending a summary', async () => {
 const native={...payload,tools:[{description:'中'.repeat(40000)}]}
 const captured={...capture,payload:native,model:{...capture.model,contextWindow:32000,maxTokens:2048}}
 let dispatches=0
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){
   options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
   dispatches++
   return {result:async()=>({})}
 }}}
 await assert.rejects(summarizePiFork(ctx,snapshot,captured,{stage:async()=>{}}),/最终请求/)
 assert.equal(dispatches,0)
})
