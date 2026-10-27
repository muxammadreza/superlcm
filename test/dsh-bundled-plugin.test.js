import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {linkUi,uiManifest} from '../src/dsh-ui-install.js'

const repositories=[
  'git+https://github.com/ygc3817922006-sketch/SuperLcm-Lossless-Context.git',
  'git+https://github.com/yu381792/dsh-superlcm.git'
]
for(const repository of repositories)test('bundled registration migrates known standalone identity: '+repository,()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-plugin-migrate-')),profile={name:'web',dir:join(dir,'web')},stage=join(dir,'package'),backup=join(dir,'backup')
  const old=join(profile.dir,'node_modules/superlcm');mkdirSync(old,{recursive:true});mkdirSync(join(stage,'dsh/ui'),{recursive:true});mkdirSync(backup)
  const metadata=JSON.stringify({name:'SuperLcm',repository:{url:repository}})
  writeFileSync(join(old,'package.json'),metadata);writeFileSync(join(old,'archive.sqlite'),'old archive preserved')
  const link=linkUi(profile,stage,backup)
  assert.equal(realpathSync(old),realpathSync(join(stage,'dsh/ui')))
  assert.equal(readFileSync(join(backup,'web-ui-link.before/archive.sqlite'),'utf8'),'old archive preserved')
  link.restore()
  assert.equal(readFileSync(join(old,'package.json'),'utf8'),metadata)
  assert.equal(readFileSync(join(old,'archive.sqlite'),'utf8'),'old archive preserved')
})
test('same-name foreign plugin is preserved and refused',()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-plugin-foreign-')),profile={name:'web',dir},old=join(dir,'node_modules/superlcm')
  mkdirSync(old,{recursive:true});const raw=JSON.stringify({name:'SuperLcm',repository:{url:'https://example.com/unrelated.git'}});writeFileSync(join(old,'package.json'),raw)
  assert.throws(()=>linkUi(profile,join(dir,'stage'),join(dir,'backup')),/已有同名/)
  assert.equal(readFileSync(join(old,'package.json'),'utf8'),raw)
})
test('registration replaces old bundle aliases once and preserves unrelated fields',()=>{
  const profile={manifest:JSON.stringify({name:'profile',dsh:{profile:{bundles:['base','SuperLcm','superlcm-mcp','superlcm'],other:true}},dependencies:{SuperLcm:'old','superlcm-mcp':'old',unrelated:'keep'},devDependencies:{SuperLcm:'old',dev:'keep'}})}
  const result=uiManifest(profile,'/bundled-superlcm')
  assert.deepEqual(result.dsh.profile.bundles,['base','superlcm'])
  assert.equal(result.dependencies.superlcm,'file:/bundled-superlcm/dsh/ui')
  assert.equal(result.dependencies.unrelated,'keep');assert.equal(result.devDependencies.dev,'keep');assert.equal(result.dsh.profile.other,true)
  assert.equal(result.dependencies.SuperLcm,undefined);assert.equal(result.dependencies['superlcm-mcp'],undefined)
})

test('real DSH manager lists one bundled plugin after migration and reconnect, then none after disconnect',async t=>{
  const {dshHost,dshEntries,inspectDshTree}=await import('../src/dsh-connection.js')
  const {dshSetupPreview,applyDshSetup}=await import('../src/dsh-setup.js')
  const {dshConfiguration}=await import('../src/dsh-catalog.js')
  const {disconnectPreview,applyDisconnect}=await import('../src/disconnect.js')
  const {ClaudeStore}=await import('../src/store.js')
  const {pathToFileURL}=await import('node:url')
  const {dirname}=await import('node:path')
  const {findCli}=await import('../src/runtime.js')
  if(!findCli('dsh'))return t.skip('Real DSH host is not installed')
  const dir=mkdtempSync(join(tmpdir(),'superlcm-bundled-host-')),env={...process.env,DSH_HOME:join(dir,'dsh')},store=new ClaudeStore(join(dir,'archive'))
  t.after(()=>store.close())
  for(const name of ['web','acp']){
    const profile=join(env.DSH_HOME,'profiles',name),old=join(profile,'node_modules/superlcm')
    mkdirSync(old,{recursive:true})
    writeFileSync(join(old,'package.json'),JSON.stringify({name:'SuperLcm',version:'0.5.37',repository:{url:repositories[1]},dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
    writeFileSync(join(old,'cordis.patch.yml'),'[]\n');writeFileSync(join(old,'archive.sqlite'),'legacy archive '+name)
    writeFileSync(join(profile,'package.json'),JSON.stringify({name:'fixture-'+name,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','superlcm']}},dependencies:{superlcm:'file:'+old}}))
    writeFileSync(join(profile,'cordis.patch.yml'),'- id: agent-default-model\n  config:\n    provider: fixture\n    model: unchanged-main-model\n')
  }
  const host=dshHost(env),{PluginManager}=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-plugin-manager')).href)
  const list=async dir=>{
    // Exercise the installed host's actual inventory reader with an empty live
    // loader: listing bundles does not require starting agents or model calls.
    const manager={profile:{dir,installAnchor:join(dirname(dirname(realpathSync(host.bin))),'package.json')},ctx:{loader:{entries:()=>[]},get:()=>undefined},managementBundles:new Set()}
    for(const key of ['listBundles','bundleRows','protectsManager','declaredRows'])manager[key]=PluginManager.prototype[key]
    return (await manager.listBundles()).filter(row=>/superlcm/i.test(row.name))
  }
  const beforePaths=[join(env.DSH_HOME,'cordis.patch.yml'),...['web','acp'].flatMap(n=>['package.json','cordis.patch.yml'].map(file=>join(env.DSH_HOME,'profiles',n,file)))]
  const before=new Map(beforePaths.map(file=>[file,existsSync(file)?readFileSync(file,'utf8'):null]))
  const {runCommand}=await import('../src/runtime.js');let dumps=0
  const failed=await dshSetupPreview(store,{env})
  await assert.rejects(applyDshSetup(store,failed.revision,{env,runCommand:async(...args)=>args[1].includes('--dump-config')&&++dumps>2?{stdout:'[]'}:runCommand(...args)}),/已恢复原配置/)
  for(const [file,raw] of before)assert.equal(existsSync(file)?readFileSync(file,'utf8'):null,raw)
  for(const name of ['web','acp'])assert.equal(readFileSync(join(env.DSH_HOME,'profiles',name,'node_modules/superlcm/archive.sqlite'),'utf8'),'legacy archive '+name)
  for(let pass=0;pass<2;pass++){
    const plan=await dshSetupPreview(store,{env}),result=await applyDshSetup(store,plan.revision,{env})
    assert.deepEqual(result.plugin,{name:'superlcm',bundled:true,registered:true})
    const config=await dshConfiguration({env})
    for(const profile of config.profiles){
      const rows=await list(profile.dir);assert.equal(rows.length,1);assert.equal(rows[0].name,'superlcm');assert.equal(rows[0].enabled,true);assert.equal(rows[0].installed,true);assert.equal(rows[0].error,undefined)
      assert.equal(rows[0].meta.title.zh,'SuperLcm');assert.equal(rows[0].meta.title.en,'SuperLcm')
      assert.equal(inspectDshTree(profile.tree).archive_only,true)
      assert.equal(dshEntries(profile.tree).filter(e=>e.id==='superlcm-global').length,1)
      assert.equal(dshEntries(profile.tree).filter(e=>e.name==='@deepseek-ai/dsh-compaction-basic').length,1)
      assert.equal(dshEntries(profile.tree).find(e=>e.id==='agent-default-model').config.model,'unchanged-main-model')
      if(pass===0)assert.equal(readFileSync(join(result.backup,profile.name+'-ui-link.before/archive.sqlite'),'utf8'),'legacy archive '+profile.name)
    }
  }
  const off=await disconnectPreview(store,'dsh',{env}),result=await applyDisconnect(store,'dsh',off.revision,{env})
  assert.deepEqual(result.plugin,{name:'superlcm',bundled:true,registered:false})
  for(const profile of (await dshConfiguration({env})).profiles){assert.deepEqual(await list(profile.dir),[]);assert.equal(dshEntries(profile.tree).filter(e=>e.name==='@deepseek-ai/dsh-compaction-basic').length,1)}
})
