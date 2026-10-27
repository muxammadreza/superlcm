import test from 'node:test'
import assert from 'node:assert/strict'
import {lab,history,send,close,count} from './reliability/lab.mjs'
import {MainArchiveFork} from '../dsh/main-archive-fork.js'
import {forkScope} from '../dsh/fork-scope.js'
import {captureDshPacket,projectDshEvent,dshSessionKey} from '../src/dsh.js'
import {ClaudeStore} from '../src/store.js'
test('integrated DSH archives a complete native fork tree with takeover off',async()=>{
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks
 try{
  store.setGlobalSetting('main-fork');forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message))
  history(h,.72);const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
   yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical constraints\nKeep the original request; deployment is forbidden. Inspection remains pending.'}))})}
   yield {type:'usage',usage:{cacheReadTokens:30000}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'Never deploy. Continue inspection.')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  const surface=h.agent.session.surface.nodes.slice();forks.afterCapture(h.id,true)
  await Promise.all([...forks.jobs.values()].map(j=>j.promise))
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(count(h,'compaction/summary'),0)
  assert.deepEqual(h.agent.session.surface.nodes,surface)
  const id=dshSessionKey(h.id),roots=store.roots(id)
  assert.equal(roots.length,1,h.warnings.join('\n'));assert.ok(roots[0].children.length>1);assert.ok(roots[0].source_records.length)
  assert.equal(JSON.parse(store.db.prepare('SELECT usage FROM fork_summary_receipts WHERE session=?').get(id).usage).cacheReadTokens,30000)
  const before=store.db.prepare('SELECT count(*) n FROM nodes WHERE session=?').get(id).n;forks.mirror(h.id)
  assert.equal(store.db.prepare('SELECT count(*) n FROM nodes WHERE session=?').get(id).n,before)
 }finally{await forks?.close();store.close();await close(h)}
})

test('DSH passive branch honors the native model override and 40% preparation with takeover off',async()=>{
 const {writeFileSync}=await import('node:fs'),{join}=await import('node:path')
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks
 try{
  store.setGlobalSetting('main-fork')
  writeFileSync(join(h.dir,'dsh-compression.json'),JSON.stringify({format:1,revision:'chosen',config:{auto:false,switchRatio:.5,forkModelOverride:true,summarizationProvider:'lab-main',summarizationModel:'summary-alternate'}}))
  forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message))
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
   yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nKeep the original constraints; inspection remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  history(h,.42);await send(h,'PASSIVE_SELECTED_MODEL')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  const surface=h.agent.session.surface.nodes.slice();forks.afterCapture(h.id,true)
  await Promise.all([...forks.jobs.values()].map(j=>j.promise))
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(branches[0].model,'summary-alternate')
  assert.equal(h.agent.options.model,'main-64000')
  assert.equal(count(h,'compaction/summary'),0);assert.deepEqual(h.agent.session.surface.nodes,surface)
  assert.equal(store.db.prepare('SELECT model FROM fork_summary_receipts WHERE session=?').get(dshSessionKey(h.id)).model,'summary-alternate')
 }finally{await forks?.close();store.close();await close(h)}
})
