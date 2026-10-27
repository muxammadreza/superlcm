// Faults through the installed DSH host. All model adapters are local fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import {lab,history,send,close,count,until} from './reliability/lab.mjs'
import {forkScope} from '../dsh/main-fork.js'

for (const fault of ['malformed-json','missing-node','wrong-order','oversized','quota','never-finishes','late-after-timeout']) {
  test('DSH native tree safely rejects '+fault, async () => {
    const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:80,summaryRetryCooldownMs:1000}})
    let release, branches=0
    const barrier=new Promise(resolve=>{release=resolve})
    try {
      history(h,.94)
      const original=h.ctx.llm.stream.bind(h.ctx.llm)
      h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
        branches++
        if (fault==='never-finishes'||fault==='late-after-timeout') await barrier
        const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
        const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
        let blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPending inspection; preserve the originals.'}))
        if(fault==='missing-node')blocks.pop()
        if(fault==='wrong-order')blocks[0].index=999
        if(fault==='oversized')blocks[0].summary='# Historical state\n'+ 'Pending inspection. '.repeat(10000)
        yield {type:'text-delta',index:0,text:fault==='malformed-json'?'broken JSON':JSON.stringify({blocks})}
        yield {type:'finish',reason:fault==='quota'?{kind:'error',failure:{code:'QUOTA',message:'synthetic quota'}}:{kind:'stop'}}
      })()
      const input='Keep current exact authorization: inspection only, never deploy.'
      await send(h,input)
      release(); await h.engine.settleBackgroundFold(h.agent)
      assert.equal(branches,1)
      assert.equal(h.main.length,0,'unsafe main request must not reach the adapter')
      assert.equal(count(h,'compaction/summary'),0,'no failed or late tree may replace context')
      assert.ok(h.errors.length)
      assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes(input)))
    } finally { release(); await close(h) }
  })
}

for (const giant of [false,true]) test('DSH waits for a slow native tree with '+(giant?'unshrinkable':'recoverable')+' appended input',async()=>{
  const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:1000}})
  let release,branches=0
  const barrier=new Promise(resolve=>{release=resolve})
  try {
    history(h,.72)
    const original=h.ctx.llm.stream.bind(h.ctx.llm)
    h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
      branches++;await barrier
      const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
      const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
      yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nInspection pending; retain current authorization.'}))})}
      yield {type:'finish',reason:{kind:'stop'}}
    })()
    await send(h,'Keep the first request verbatim.')
    await until(()=>branches===1)
    const input='APPENDED_INPUT_MUST_REMAIN '+ 'x'.repeat(giant?500000:150000)
    let settled=false
    const pending=send(h,input).then(()=>{settled=true})
    await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(settled,false);assert.equal(h.main.length,1,'wait before sending the enlarged request')
    release();await pending;await h.engine.settleBackgroundFold(h.agent)
    assert.equal(branches,1,'waiting and replacement must reuse the existing branch')
    if(giant){assert.equal(h.main.length,1);assert.ok(h.errors.length)}
    else {assert.equal(h.main.length,2);assert.equal(count(h,'compaction/summary'),1);assert.ok(h.main.at(-1).content.includes(input))}
    assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes(input)))
  } finally {release();await close(h)}
})
