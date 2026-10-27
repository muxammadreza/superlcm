import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ClaudeStore} from '../src/store.js'
import {definitions,configFiles,harnessConnections} from '../src/harness.js'
import {compressionCapabilities} from '../src/compression-status.js'
import {setupPreview} from '../src/setup.js'
import {localConversations,indexLocalConversation} from '../src/local-conversations.js'
import {modelCatalog} from '../src/model-catalog.js'
import {writerTool,summarizeWith} from '../src/cli-writers.js'
import {enqueueSummary} from '../src/summary-scheduler.js'
import {startWeb} from '../src/web.js'
import {page} from '../src/web-page.js'
import {listTools} from '../src/mcp.js'
const script=fileURLToPath(new URL('../src/cli.js',import.meta.url))
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-retired-')),store=new ClaudeStore(join(dir,'store'))
 const env={HOME:dir,USERPROFILE:dir,PATH:'',...Object.fromEntries(['CLAUDE_CLI','CODEX_CLI','PI','DSH','HERMES'].map(h=>['SUPERLCM_'+h+'_BIN',join(dir,'not-installed')]))}
 t.after(()=>store.close());return {dir,store,env}
}
function oldArchive(f,id,harness){
 const file=join(f.dir,id+'.jsonl'),raw=Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'Shared evidence '+i})+'\n').join('')
 writeFileSync(file,raw);f.store.ingest(id,file);f.store.setMetadata(id,{harness,externalId:id,name:'Shared '+id,nameSource:'manual'});return raw
}
test('retired Hermes has no discoverable card, writer, model catalog or setup/import adapter',async t=>{
 const f=fixture(t)
 f.store.db.prepare("INSERT INTO harness_summary_settings(harness,mode) VALUES('hermes','agent')").run()
 f.store.setGlobalSetting('off');assert.ok(!listTools(f.store).some(t=>t.name==='lcm_summary_task'))
 assert.ok(!definitions.some(x=>x.id==='hermes'));assert.equal(compressionCapabilities.hermes,undefined)
 assert.ok(!(await harnessConnections(f.store,{env:f.env})).some(x=>x.harness==='hermes'),'legacy settings cannot recreate a card')
 assert.throws(()=>configFiles('hermes',f.env),/Unsupported/)
 assert.throws(()=>localConversations(f.store,'hermes',{env:f.env}),/Unsupported/)
 assert.throws(()=>indexLocalConversation(f.store,'hermes','a'.repeat(64),{env:f.env}),/Unsupported/)
 await assert.rejects(setupPreview(f.store,'hermes',{env:f.env}),/暂未实现/)
 await assert.rejects(modelCatalog('hermes',{env:f.env}),/Unknown/)
 assert.equal(writerTool('hermes',{...f.env,SUPERLCM_PI_BIN:process.execPath}),null,'a retired origin cannot fall back to Pi')
 assert.throws(()=>summarizeWith('hermes','source',{env:f.env}),/No tool/)
})
test('retirement disables an older persisted integration once and preserves original bytes',t=>{
 const f=fixture(t),raw=oldArchive(f,'old','hermes')
 f.store.db.prepare("UPDATE integrations SET enabled=1,revision=7 WHERE harness='hermes'").run()
 const opened=new ClaudeStore(f.store.dir)
 try{
  assert.equal(opened.integrationRevision('hermes').enabled,0);assert.equal(opened.integrationRevision('hermes').revision,8)
  assert.equal(opened.effectiveSetting('old').mode,'off');assert.equal(opened.apiConfig('old'),null)
  assert.equal(opened.eventRows('old').map(x=>opened.exact('old',x.ordinal)).join(''),raw)
  assert.throws(()=>opened.setIntegrationEnabled('hermes',true),/Unsupported/)
  assert.throws(()=>opened.setHarnessSetting('hermes','cli'),/Unsupported/)
  assert.throws(()=>enqueueSummary(opened,'old',{backend:'cli',env:f.env}),/Unsupported/)
 }finally{opened.close()}
 const again=new ClaudeStore(f.store.dir);try{assert.equal(again.integrationRevision('hermes').revision,8)}finally{again.close()}
})
test('retired hooks acknowledge old host calls without opening an index or reading native stores',t=>{
 const f=fixture(t),home=join(f.dir,'never-opened')
 const child=spawnSync(process.execPath,['--no-warnings',script,'hermes-hook','--home',home],{env:f.env,input:JSON.stringify({session_id:'old',hook_event_name:'on_session_end'}),encoding:'utf8',timeout:5000})
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'{}');assert.equal(child.stderr,'');assert.equal(existsSync(home),false)
})
test('an API model used only by a retired setting can be removed; active tool references still protect it',t=>{
 const f=fixture(t),model=f.store.saveApiModel({provider:'openai',url:'http://127.0.0.1:4444/v1',model:'fixture'})
 f.store.db.prepare("INSERT INTO harness_summary_settings(harness,mode,api_ref) VALUES('hermes','api',?)").run(model.id)
 f.store.setHarnessSetting('codex','api',null,null,null,model.id)
 assert.throws(()=>f.store.deleteApiModel(model.id),/Still used by codex/)
 f.store.clearHarnessSetting('codex');assert.equal(f.store.deleteApiModel(model.id),true)
 assert.equal(f.store.harnessSetting('hermes').api_ref,null)
})
test('page assets do not advertise or display Hermes',()=>{
 const html=page('fixture');assert.doesNotMatch(html,/hermes/i)
 for(const p of ['README.md','README.zh-CN.md','docs/SETUP.md','docs/CONSOLE.md'])assert.doesNotMatch(readFileSync(new URL('../'+p,import.meta.url),'utf8'),/hermes/i,p)
})
test('console excludes retired archives before pagination, totals, search and settings while preserving recall',async t=>{
 const f=fixture(t);f.store.setGlobalSetting('off')
 f.store.db.prepare("INSERT INTO harness_summary_settings(harness,mode) VALUES('hermes','agent')").run()
 for(let i=0;i<53;i++){oldArchive(f,'old-'+i,'hermes');f.store.setStatus('old-'+i,'summary_error')}
 const original=oldArchive(f,'current','codex')
 const web=await startWeb({store:new ClaudeStore(f.store.dir),env:f.env,discovery:async()=>[{harness:'codex',supported:true},{harness:'hermes',supported:true}]})
 t.after(()=>web.close())
 const get=async path=>{const r=await fetch(new URL(path,web.url));return {status:r.status,body:await r.json()}}
 const list=await get('/api/conversations')
 assert.equal(list.status,200);assert.equal(list.body.total,1);assert.equal(list.body.sessions.length,1);assert.equal(list.body.next_offset,null)
 assert.deepEqual(list.body.groups.map(g=>g.harness),['codex']);assert.equal(list.body.attention_count,0)
 assert.equal((await get('/api/conversations?harness=hermes')).body.total,0)
 const search=(await get('/api/search?q=Shared')).body
 assert.ok(search.conversations.every(x=>x.harness!=='hermes'));assert.ok(search.events.every(x=>x.conversation.harness!=='hermes'))
 assert.deepEqual((await get('/api/harnesses')).body.harnesses.map(x=>x.harness),['codex'])
 assert.ok((await get('/api/settings')).body.settings.every(x=>x.harness!=='hermes'))
 assert.equal((await get('/api/conversation?session=old-0')).status,400)
 const retired=await fetch(new URL('/api/settings',web.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'harness',harness:'hermes',mode:'cli'})})
 assert.equal(retired.status,400)
 assert.equal(f.store.eventRows('current').map(x=>f.store.exact('current',x.ordinal)).join(''),original)
 assert.equal(f.store.stats('old-0').records,8,'old archives remain available for exact recall')
})
