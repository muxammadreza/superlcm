import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

const source=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
const escape=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))

function harness(overrides={},language='zh',tool='dsh') {
  const settings={revision:'current',keep:40000,ratio:.8,enabled:false,provider_ref:'fixture-provider',model:'summary-model',controls_installed:true,archive_only:true,
    foldBatchTokens:20000,condensedMinFanout:4,summaryTimeoutMs:180000,summaryRetryCooldownMs:30000,
    softActiveTokens:160000,hardActiveTokens:220000,minRetainTokens:32000,tailCount:24,pressureFoldTokens:20000,summaryPrefixTargetTokens:0,
    catalog:{providers:[{ref:'fixture-provider',label:'Fixture provider',models:[{id:'summary-model',label:'Summary model'}]}]},...overrides}
  let nodes=[]
  const root={
    get innerHTML(){return this.html||''},
    set innerHTML(html){
      this.html=html
      nodes=[...html.matchAll(/<(input|button|select|p|span)\b([^>]*)>/g)].map(([,tag,raw])=>{
        const attrs=Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]))
        const dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]))
        return {tag,attrs,dataset,id:attrs.id,value:attrs.value||'',checked:/\schecked(?:\s|$)/.test(raw),disabled:/\sdisabled(?:\s|$)/.test(raw),
          setAttribute(key,value){this.attrs[key]=value},addEventListener(event,callback){this['on'+event]=callback}}
      })
    },
    querySelector(selector){return selector==='button'?nodes.find(node=>node.tag==='button'):nodes.find(node=>selector==='#'+node.id)||null},
    querySelectorAll(selector){return nodes.filter(node=>selector==='[data-dsh-field]'?node.dataset.dshField:selector==='[data-dsh-batch]'?node.dataset.dshBatch:selector==='[data-dsh-ratio]'?node.dataset.dshRatio:selector==='[data-keep-choice]'?node.dataset.keepChoice:selector==='[data-pi-ratio]'?node.dataset.piRatio:false)}
  }
  const calls=[],toasts=[],owners=[]
  const context={
    $:selector=>selector==='#'+tool+'CompressionSettings'?root:root.querySelector(selector),esc:escape,
    t:(text,vars={})=>text.replace(/\{(\w+)\}/g,(match,key)=>vars[key]??match),
    state:{harnesses:null},loadHarnesses:async()=>{},loadSettings:async()=>{},renderForkModelPicker:()=>{},admin:{compression:{runtimes:[]}},renderCompressionOwner:(_selector,enabled,pending)=>owners.push({enabled,pending}),
    api:async(url,body)=>{calls.push({url,body});if(body){Object.assign(settings,body);settings.revision='saved-'+calls.length;if(body.compressionRatio!==undefined)settings.switchRatio=body.compressionRatio;}return {...settings}},toast:message=>toasts.push(message),act:callback=>callback(),show(){},openDshSetup(){},
    localStorage:{getItem:()=>language},navigator:{language},document:{documentElement:{}}
  }
  runInNewContext((language==='en'?source('web-i18n.js')+'\n':'')+source('web-retention-controls.js')+source('web-'+tool+'-controls.js')+'\nthis.ui={controls:'+tool+'Controls,load:load'+(tool==='pi'?'Pi':'Dsh')+'Controls,save:save'+(tool==='pi'?'Pi':'Dsh')+'Controls}',context)
  const input=(key,value)=>{const node=root.querySelector('#'+tool+'-'+key);node.value=String(value);node.oninput()}
  return {root,context,ui:context.ui,input,calls,toasts,owners,settings}
}


for(const tool of ['pi','dsh']) {
 test(tool+' uses Claude’s retention presets and has no per-tool granularity or advanced section',async()=>{
  const {ui,root}=harness({},'zh',tool);await ui.load()
  assert.match(root.innerHTML,/最近原文保留/)
  assert.match(root.innerHTML,/最多保留当前上下文的一半/)
  assert.deepEqual(root.querySelectorAll('[data-keep-choice]').map(n=>n.dataset.keepChoice),['20000','40000','80000','custom'])
  assert.equal(root.querySelectorAll('[data-keep-choice]')[1].attrs['aria-checked'],'true')
  assert.doesNotMatch(root.innerHTML,/摘要粒度|高级压缩设置|foldBatchTokens|condensedMinFanout|summaryTimeoutMs|保存压缩设置|id="(?:pi|dsh)ControlsSave"/)
 })
 test(tool+' round-trips preset and custom retention without changing ratio, models or takeover',async()=>{
  const {ui,root,input,calls}=harness({},'zh',tool);await ui.load()
  await root.querySelectorAll('[data-keep-choice]')[2].onclick()
  assert.equal(calls[1].body.keep,80000);assert.equal(calls[1].body.enabled,false)
  await root.querySelectorAll('[data-keep-choice]')[3].onclick();input('keep',35);await root.querySelector('#'+tool+'KeepSave').onclick()
  assert.equal(calls[2].body.keep,35000)
  assert.equal(root.querySelector('#'+tool+'-keep').value,'35');assert.equal(ui.controls.error,'')
  assert.equal(calls[2].body[tool==='pi'?'ratio':'compressionRatio'],.8)
  assert.equal(Object.hasOwn(calls[2].body,'foldBatchTokens'),false)
  assert.equal(Object.hasOwn(calls[2].body,'condensedMinFanout'),false)
  if(tool==='dsh')assert.equal(calls[2].body.model,'summary-model')
 })
 test(tool+' invalid retention is rejected before sending and failed saves preserve the draft',async()=>{
  for(const value of ['', 'NaN','Infinity',0,4,201,5.0005]) {
   const {ui,root,input,calls}=harness({},'zh',tool);await ui.load();input('keep',value);await ui.save()
   assert.equal(calls.length,1,value);assert.match(root.innerHTML,/role="alert"/)
   assert.equal(ui.controls.draft.enabled,false)
  }
  const {ui,root,input,context}=harness({},'zh',tool);await ui.load();input('keep',35)
  context.api=async()=>{throw Error('save failed <retry>')};await ui.save()
  assert.match(root.innerHTML,/save failed &lt;retry&gt;/)
  assert.equal(root.querySelector('#'+tool+'-keep').value,'35');assert.equal(ui.controls.busy,false)
 })
 test(tool+' retention controls and validation are translated into English',async()=>{
  const {ui,root,input}=harness({},'en',tool);await ui.load();assert.doesNotMatch(root.innerHTML,/[一-龥]/)
  input('keep',0);await ui.save();assert.doesNotMatch(root.innerHTML,/[一-龥]/)
  assert.match(root.innerHTML,/between 5K and 200K/)
 })
}
test('DSH ratio presets/custom retain Claude layout and save only the selected threshold',async()=>{
 const {ui,root,input,calls}=harness({switchRatio:.75});await ui.load()
 assert.equal(root.querySelector('#dsh-switchRatio').value,'75')
 await root.querySelectorAll('[data-dsh-ratio]')[2].onclick()
 assert.equal(calls[1].body.compressionRatio,.9)
 root.querySelectorAll('[data-dsh-ratio]')[3].onclick();input('switchRatio',50);await root.querySelector('#dshRatioSave').onclick()
 assert.equal(calls[2].body.compressionRatio,.5);assert.equal(calls[2].body.enabled,false)
 assert.equal(Object.hasOwn(calls[2].body,'prepareRatio'),false);assert.equal(Object.hasOwn(calls[2].body,'emergencyRatio'),false)
})
test('invalid custom DSH ratios are blocked without altering the chosen model',async()=>{
 for(const value of [0,100,90.5,'','NaN']) {
  const {ui,root,input,calls}=harness();await ui.load();input('switchRatio',value);await ui.save()
  assert.equal(calls.length,1);assert.match(root.innerHTML,/role="alert"/);assert.equal(ui.controls.draft.model,'summary-model')
 }
})

for(const tool of ['pi','dsh']) {
 test(tool+' autosaves only a changed switch, retaining unfinished custom fields and model drafts',async()=>{
  const {ui,root,calls}=harness({},'zh',tool);await ui.load()
  const key=tool==='pi'?'ratio':'switchRatio'
  ui.controls.draft[key]=NaN;ui.controls.draft.customRatio=true
  ui.controls.draft.keep=35000;ui.controls.draft.customKeep=true
  if(tool==='dsh'){ui.controls.draft.model='pending-model';ui.controls.draft.forkModelOverride=true}
  await root.querySelector('#'+tool+'ControlsOn').onchange({target:{checked:true}})
  assert.equal(calls.length,2);assert.equal(calls[1].body.enabled,true)
  assert.equal(calls[1].body[tool==='pi'?'ratio':'compressionRatio'],.8)
  assert.equal(calls[1].body.keep,40000)
  assert.equal(Number.isNaN(ui.controls.draft[key]),true);assert.equal(ui.controls.draft.keep,35000)
  assert.equal(ui.controls.draft.revision,'saved-2');assert.equal(ui.controls.error,'')
  if(tool==='dsh'){assert.equal(calls[1].body.model,'summary-model');assert.equal(ui.controls.draft.model,'pending-model');assert.equal(ui.controls.draft.forkModelOverride,true)}
 })
 test(tool+' preset retention autosaves while a ratio draft remains unsaved',async()=>{
  const {ui,root,calls}=harness({},'zh',tool);await ui.load()
  const key=tool==='pi'?'ratio':'switchRatio';ui.controls.draft[key]=.5
  await root.querySelectorAll('[data-keep-choice]')[2].onclick()
  assert.equal(calls.length,2);assert.equal(calls[1].body.keep,80000)
  assert.equal(calls[1].body[tool==='pi'?'ratio':'compressionRatio'],.8)
  assert.equal(ui.controls.draft[key],.5);assert.equal(ui.controls.error,'')
 })
 test(tool+' scoped save never absorbs a concurrent change to a pending retention draft',async()=>{
  const {ui,root,context,settings}=harness({},'zh',tool);await ui.load()
  ui.controls.draft.keep=35000
  context.api=async()=>({...settings,enabled:true,keep:60000,revision:'another-writer'})
  await root.querySelector('#'+tool+'ControlsOn').onchange({target:{checked:true}})
  assert.equal(ui.controls.value.keep,60000);assert.equal(ui.controls.draft.keep,35000)
  assert.equal(ui.controls.draft.revision,'current');assert.match(root.innerHTML,/role="alert"/)
 })
}
test('DSH model save/reload matches Claude’s separate model actions and preserves unfinished compression inputs',async()=>{
 const {ui,root,settings}=harness();await ui.load()
 assert.match(root.innerHTML,/保存摘要模型/);assert.match(root.innerHTML,/重新读取模型/)
 ui.controls.draft.keep=35000;ui.controls.draft.switchRatio=NaN;ui.controls.draft.model='pending-model'
 await root.querySelector('#dshModelsRead').onclick()
 assert.equal(ui.controls.draft.keep,35000);assert.equal(Number.isNaN(ui.controls.draft.switchRatio),true)
 assert.equal(ui.controls.draft.model,settings.model);assert.equal(ui.controls.error,'')
})

test('DSH refuses an unselected native model before sending, including while takeover is off',async()=>{
 const {ui,root,calls}=harness({summaryMode:'main-fork'});await ui.load()
 root.querySelector('#dshForkOther').onchange({target:{checked:true}})
 ui.controls.draft.model=''
 await root.querySelector('#dshModelSave').onclick()
 assert.equal(calls.length,1);assert.match(root.innerHTML,/请选择本工具列表中的模型/)
 assert.equal(ui.controls.draft.enabled,false)
})
