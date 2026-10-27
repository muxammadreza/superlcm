// A dedicated destination, with independent controls and deep links per tool.
function compressionSection(tool,updateHash=true) {
  tool=['dsh','pi'].includes(tool)?tool:'claude-code';state.compressionTool=tool
  for(const button of document.querySelectorAll('[data-compression-tool]')) {
    const selected=button.dataset.compressionTool===tool
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1
  }
  for(const panel of document.querySelectorAll('[data-compression]'))panel.hidden=panel.dataset.compression!==tool
  if(updateHash)history.replaceState(null,'','#compression/'+tool)
  if(tool==='dsh') {
    if(!dshControls.value&&!dshControls.loading)act(loadDshControls)
    else renderDshControls()
  }
  if(tool==='pi') {
    if(!piControls.value&&!piControls.loading)act(loadPiControls)
    else renderPiControls()
  }
}
for(const button of document.querySelectorAll('[data-compression-tool]')) {
  button.onclick=()=>compressionSection(button.dataset.compressionTool)
  button.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const tools=Array.from(document.querySelectorAll('[data-compression-tool]'),b=>b.dataset.compressionTool)
    const index=tools.indexOf(state.compressionTool),offset=event.key==='ArrowLeft'?-1:1
    const tool=event.key==='Home'?tools[0]:event.key==='End'?tools.at(-1):tools[(index+offset+tools.length)%tools.length]
    compressionSection(tool);document.querySelector('[data-compression-tool="'+tool+'"]').focus()
  }
}
function renderCompressionOwner(id,enabled,pending=false) {
  const badge=$(id);if(!badge)return
  badge.hidden=!enabled&&!pending
  badge.className='state '+(pending?'warn':enabled?'warn':'on')
  badge.textContent=t(pending?'等待应用':enabled?'SuperLcm 接管':id==='#claudeCompressionOwner'?'Claude 原生压缩':id==='#piCompressionOwner'?'Pi 原生压缩':'DSH 原生压缩')
}

const nativeForkModels=new Map()
function renderForkModelPicker(harness) {
  const root=$(harness==='pi'?'#piForkModelSettings':'#claudeForkModelSettings')
  if(!root||!admin.settings)return
  const own=admin.settings.settings.find(s=>s.harness===harness)
  const current={mode:own?.mode||admin.settings.global.mode||'main-fork',model:own?.mode==='main-fork'?own.model:null}
  let draft=nativeForkModels.get(harness)
  if(draft&&!draft.dirty&&!draft.busy&&(draft.expected.mode!==current.mode||draft.expected.model!==current.model)){nativeForkModels.delete(harness);draft=null}
  if(!draft){draft={expected:current,other:!!current.model,model:current.model,dirty:false,loading:false,busy:false,error:''};nativeForkModels.set(harness,draft)}
  const controlBusy=harness==='pi'&&piControls.busy
  const disabled=current.mode!=='main-fork'||draft.busy||controlBusy
  const models=admin.catalog[harness]?.models||[]
  const provider=m=>harness==='pi'?m.id.slice(0,m.id.indexOf('/')):'Claude Code'
  const providers=[...new Set(models.map(provider))]
  const selectedProvider=draft.provider||(draft.model?provider({id:draft.model}):providers[0])||''
  const selected=models.filter(m=>provider(m)===selectedProvider)
  root.innerHTML='<h3>'+t('后台摘要模型')+'</h3><label class="toggle-row"><span><b>'+t('允许其他模型')+'</b><span>'+t('默认跟随当前对话模型；也可选择本工具已配置的其他模型。')+'</span></span><span class="switch"><input type="checkbox" data-fork-other'+(draft.other?' checked':'')+(disabled?' disabled':'')+'><i></i></span></label>'+
    (current.mode==='main-fork'?'':'<p class="desc">'+t('请先在「工具」页选择主模型后台分支。')+'</p>')+
    (draft.other?'<div class="fields"><label class="field">'+t('摘要模型供应商')+'<select data-fork-provider'+(disabled||draft.loading?' disabled':'')+'><option value="">'+t('选择供应商')+'</option>'+providers.map(p=>'<option value="'+esc(p)+'"'+(selectedProvider===p?' selected':'')+'>'+esc(p)+'</option>').join('')+'</select></label><label class="field">'+t('摘要模型')+'<select data-fork-model'+(disabled||draft.loading?' disabled':'')+'><option value="">'+t('选择模型')+'</option>'+selected.map(m=>'<option value="'+esc(m.id)+'"'+(draft.model===m.id?' selected':'')+'>'+esc(harness==='pi'&&m.label===m.id?m.id.slice(m.id.indexOf('/')+1):m.label)+'</option>').join('')+'</select></label></div><p class="desc">'+t('使用本工具已配置的模型和账号，只改变后台摘要模型。')+'</p>':'')+
    (draft.loading?'<p role="status">'+t('正在读取模型列表…')+'</p>':'')+(draft.error?'<p role="alert">'+esc(draft.error)+'</p>':'')+
    '<div class="actions"><button type="button" class="btn" data-fork-save'+(disabled||draft.loading||!draft.dirty?' disabled':'')+'>'+t('保存摘要模型')+'</button><button type="button" class="link" data-fork-read'+(draft.busy||draft.loading||controlBusy?' disabled':'')+'>'+t('重新读取模型')+'</button><span class="saved">'+(draft.dirty?t('有未保存的修改'):'')+'</span></div>'
  const dirty=()=>{draft.dirty=true;renderForkModelPicker(harness)}
  root.querySelector('[data-fork-other]').onchange=e=>{draft.other=e.target.checked;dirty();if(draft.other&&!admin.catalog[harness])act(()=>loadForkModels(harness))}
  root.querySelector('[data-fork-provider]')?.addEventListener('change',e=>{draft.provider=e.target.value;draft.model='';dirty()})
  root.querySelector('[data-fork-model]')?.addEventListener('change',e=>{draft.model=e.target.value;dirty()})
  root.querySelector('[data-fork-read]').onclick=()=>act(()=>loadForkModels(harness,true))
  root.querySelector('[data-fork-save]').onclick=()=>act(async()=>{
    if(draft.other&&!models.some(m=>m.id===draft.model)){draft.error=t('请选择本工具列表中的模型');renderForkModelPicker(harness);return}
    draft.busy=true;draft.error='';renderForkModelPicker(harness)
    try{await api('/api/fork-model',{harness,model:draft.other?draft.model:null,expected:draft.expected});nativeForkModels.delete(harness);if(harness==='pi')await refreshPiAfterModelChange();await loadSettings();toast(t('摘要模型已保存'))}
    catch(error){draft.error=error.message}
    finally{draft.busy=false;renderForkModelPicker(harness)}
  })
  if(draft.other&&!admin.catalog[harness]&&!draft.loading&&!draft.error)act(()=>loadForkModels(harness))
}
async function loadForkModels(harness,refresh=false) {
  const draft=nativeForkModels.get(harness);if(!draft||draft.loading)return
  draft.loading=true;draft.error='';renderForkModelPicker(harness)
  try {
    admin.catalog[harness]=await api('/api/models?backend='+q(harness))
    if(!admin.catalog[harness].models.length)draft.error=t('未能读取本工具的模型列表，请确认工具已安装并配置账号。')
    // An explicit reload also refreshes the revision used for the eventual save.
    if(refresh){nativeForkModels.delete(harness);await loadSettings();const fresh=nativeForkModels.get(harness);if(fresh)fresh.error=draft.error}
  }catch(error){draft.error=error.message}
  finally{draft.loading=false;renderForkModelPicker(harness)}
}
