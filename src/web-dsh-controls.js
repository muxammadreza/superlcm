// Daily DSH compaction controls live beside Claude's takeover controls.
const dshControls={value:null,draft:null,busy:false,loading:false,error:''}
const dshRatioPresets=[.7,.8,.9]
function dshDraft(value){return {...value,forkModelOverride:value.forkModelOverride===true,keep:value.keep??40000,switchRatio:value.compressionRatio??value.switchRatio??.8,customRatio:!dshRatioPresets.includes(value.compressionRatio??value.switchRatio??.8)}}
const dshPct=value=>Math.round(value*1e10)/1e8
function dshRatioField(draft,disabled){
  const choices=dshRatioPresets.map(n=>'<button type="button" role="radio" data-dsh-ratio="'+n+'" aria-checked="'+(!draft.customRatio&&draft.switchRatio===n)+'"'+(disabled?' disabled':'')+'>'+n*100+'%'+(n===.8?'<small>'+t('推荐')+'</small>':'')+'</button>').join('')
  return '<div class="choice" role="radiogroup" aria-label="'+t('压缩比例')+'">'+choices+'<button type="button" role="radio" data-dsh-ratio="custom" aria-checked="'+draft.customRatio+'"'+(disabled?' disabled':'')+'>'+t('自定义')+'<small>'+(draft.customRatio&&Number.isFinite(draft.switchRatio)?esc(dshPct(draft.switchRatio))+'%':'')+'</small></button></div>'+
    '<div class="custom-size" id="dshRatioCustom"'+(draft.customRatio?'':' hidden')+'><input type="number" inputmode="numeric" id="dsh-switchRatio" aria-label="'+t('自定义压缩比例（%）')+'" data-dsh-field="switchRatio" data-scale="0.01" min="11" max="99" step="1" value="'+esc(Number.isFinite(draft.switchRatio)?dshPct(draft.switchRatio):'')+'"'+(disabled?' disabled':'')+'><span>%</span><button type="button" class="btn small" id="dshRatioSave"'+(disabled?' disabled':'')+'>'+t('保存')+'</button><span class="hint">11%–99%</span></div>'
}
function dshSettingsStatus() {
  const value=dshControls.value;if(!value)return
  const live=(admin.compression.runtimes||[]).filter(r=>r.live&&r.kind==='engine')
  const applied=value.controls_installed&&value.settings_revision&&live.length&&live.every(r=>r.settings_revision===value.settings_revision&&r.version===value.expected_version&&r.version===value.installed_version&&(admin.compression.runtimes||[]).some(a=>a.live&&a.kind==='archive'&&a.pid===r.pid&&a.profile===r.profile&&a.version===r.version))
  const acknowledged=applied&&live.every(r=>r.enabled===value.enabled&&r.route_ready!==false)
  const pending=value.archive_only?live.length>0:!acknowledged
  renderCompressionOwner('#dshCompressionOwner',value.enabled,pending)
  const badge=$('#dshCompressionOwner');if(badge)badge.hidden=!(value.enabled||live.some(r=>r.enabled))
}
function renderDshControls() {
  const root=$('#dshCompressionSettings'),value=dshControls.value,draft=dshControls.draft
  if(!value){root.innerHTML='<p class="muted">'+esc(dshControls.error||t('正在读取压缩设置…'))+'</p><button class="btn" type="button" id="dshSettingsConnect">'+t('去接入')+'</button>';root.querySelector('button').onclick=()=>show('connect');return}
  const disabled=dshControls.busy||dshControls.loading||!value.controls_installed,modelDirty=dshModelChanged(),providers=value.catalog.providers,selected=providers.find(p=>p.ref===draft.provider_ref)
  root.innerHTML='<label class="toggle-row"><span><b>'+t('由 SuperLcm 接管压缩')+'</b><span>'+t('到门槛时直接换上现成的摘要，不调用模型，几乎不用等')+'</span></span><span class="switch"><input type="checkbox" id="dshControlsOn" role="switch"'+(draft.enabled?' checked':'')+(disabled?' disabled':'')+'><i></i></span></label>'+
    '<h3>'+t('压缩比例')+'</h3><p class="desc">'+t('上下文占用达到所选比例时压缩。按当前模型的可用容量计算，默认 80%。')+'</p>'+dshRatioField(draft,disabled)+'<p class="notice calm" id="dshPreparationHint">'+esc(t('约 {prepare}% 时在后台准备，{replace}% 时直接替换已完成摘要。',{prepare:Math.round(draft.switchRatio*100)-10,replace:Math.round(draft.switchRatio*100)}))+'</p>'+
    '<h3>'+t('后台摘要模型')+'</h3><label class="toggle-row"'+(value.summaryMode==='main-fork'?'':' hidden')+'><span><b>'+t('允许其他模型')+'</b><span>'+t('默认跟随当前对话模型；也可选择本工具已配置的其他模型。')+'</span></span><span class="switch"><input type="checkbox" id="dshForkOther"'+(draft.forkModelOverride?' checked':'')+(disabled?' disabled':'')+'><i></i></span></label><div class="fields"'+(value.summaryMode==='main-fork'&&!draft.forkModelOverride?' hidden':'')+'><label class="field">'+t('摘要模型供应商')+'<select id="dshControlsProvider"'+(disabled?' disabled':'')+'><option value="">'+t('选择供应商')+'</option>'+providers.map(p=>'<option value="'+esc(p.ref)+'"'+(p.ref===draft.provider_ref?' selected':'')+(!p.models.length?' disabled':'')+'>'+esc(p.label)+'</option>').join('')+'</select></label><label class="field">'+t('摘要模型')+'<select id="dshControlsModel"'+(disabled?' disabled':'')+'><option value="">'+t('选择模型')+'</option>'+(selected?.models||[]).map(m=>'<option value="'+esc(m.id)+'"'+(m.id===draft.model?' selected':'')+'>'+esc(m.label)+'</option>').join('')+'</select></label></div>'+
    (draft.forkModelOverride?'<p class="desc">'+t('使用本工具已配置的模型和账号，只改变后台摘要模型。')+'</p>':'')+
    '<div class="actions"><button type="button" class="btn" id="dshModelSave"'+(disabled||!modelDirty?' disabled':'')+'>'+t('保存摘要模型')+'</button><button type="button" class="link" id="dshModelsRead"'+(disabled?' disabled':'')+'>'+t('重新读取模型')+'</button><span class="saved" id="dshModelDirty">'+(modelDirty?t('有未保存的修改'):'')+'</span></div>'+
    recentKeepField('dsh',draft,disabled)+
    (!value.controls_installed?'<div class="actions"><button type="button" class="btn primary" id="dshSettingsUpdate">'+t(value.configured?'更新接入':'接入')+'</button></div>':'')+
    (dshControls.error?'<p role="alert">'+esc(dshControls.error)+' <button type="button" class="link" id="dshControlsRead">'+t('重新读取')+'</button></p>':'')
  root.querySelector('#dshSettingsUpdate')?.addEventListener('click',()=>openDshSetup())
  root.querySelector('#dshControlsRead')?.addEventListener('click',()=>act(()=>loadDshControls()))
  root.querySelector('#dshModelsRead').onclick=()=>act(()=>loadDshControls(true))
  root.querySelector('#dshModelSave').onclick=()=>act(()=>saveDshControls(['provider_ref','model','forkModelOverride']))
  root.querySelector('#dshForkOther').onchange=e=>{draft.forkModelOverride=e.target.checked;renderDshControls();dirty()}
  root.querySelector('#dshControlsOn').onchange=e=>{draft.enabled=e.target.checked;return act(()=>saveDshControls(['enabled']))}
  root.querySelector('#dshControlsProvider').onchange=e=>{draft.provider_ref=e.target.value;draft.model='';renderDshControls();dirty()}
  root.querySelector('#dshControlsModel').onchange=e=>{draft.model=e.target.value;dirty()}
  for(const input of root.querySelectorAll('[data-dsh-field]'))input.oninput=()=>{
    const key=input.dataset.dshField
    draft[key]=input.value.trim()===''?NaN:input.dataset.scale==='0.01'?Number(input.value)/100:Number(input.value)*Number(input.dataset.scale)
    if(key==='switchRatio'){const badge=root.querySelector('[data-dsh-ratio="custom"] small');if(badge)badge.textContent=Number.isFinite(draft.switchRatio)?dshPct(draft.switchRatio)+'%':''}
    if(key==='switchRatio')$('#dshPreparationHint').textContent=Number.isInteger(draft.switchRatio*100)?t('约 {prepare}% 时在后台准备，{replace}% 时直接替换已完成摘要。',{prepare:Math.round(draft.switchRatio*100)-10,replace:Math.round(draft.switchRatio*100)}):''
    dirty()
  }
  for(const button of root.querySelectorAll('[data-dsh-ratio]'))button.onclick=()=>{
    draft.customRatio=button.dataset.dshRatio==='custom'
    if(!draft.customRatio)draft.switchRatio=Number(button.dataset.dshRatio)
    renderDshControls();dirty()
    if(!draft.customRatio)return act(()=>saveDshControls(['switchRatio']))
    if(draft.customRatio){root.querySelector('#dsh-switchRatio').focus?.();root.querySelector('#dsh-switchRatio').select?.()}
  }
  bindRecentKeep(root,'dsh',draft,renderDshControls,null,()=>saveDshControls(['keep']))
  root.querySelector('#dshRatioSave').onclick=()=>act(()=>saveDshControls(['switchRatio']))
  root.querySelector('#dsh-switchRatio').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();act(()=>saveDshControls(['switchRatio']))}}
  dshSettingsStatus()
}
const dshEditable=['enabled','switchRatio','keep','provider_ref','model','forkModelOverride']
function dshModelChanged(){return ['provider_ref','model','forkModelOverride'].some(k=>(dshControls.draft[k]??false)!==(dshControls.value[k]??false))}
function dirty(){
  const changed=dshModelChanged();$('#dshModelDirty').textContent=changed?t('有未保存的修改'):''
  $('#dshModelSave').disabled=dshControls.busy||!changed
}
function dshSettingsPayload(fields=null){
  const draft=fields?{...dshDraft(dshControls.value),...Object.fromEntries(fields.map(k=>[k,dshControls.draft[k]]))}:dshControls.draft
  if(!validRecentKeep(draft.keep))throw Error(t('最近原文保留量必须在 5K 到 200K 之间'))
  if((dshControls.value.summaryMode!=='main-fork'||draft.forkModelOverride)&&!dshControls.value.catalog.providers.find(p=>p.ref===draft.provider_ref)?.models.some(m=>m.id===draft.model))throw Error(t('请选择本工具列表中的模型'))
  const percent=dshPct(draft.switchRatio)
  if(!Number.isInteger(percent)||percent<11||percent>99)throw Error(t('请为{field}输入 {min} 到 {max} 之间的整数',{field:t('压缩比例'),min:11,max:99}))
  const payload={...Object.fromEntries(['revision','enabled','provider_ref','model'].map(key=>[key,draft[key]])),forkModelOverride:draft.forkModelOverride===true,budgetMode:'ratio',keep:draft.keep,compressionRatio:draft.switchRatio}
  return payload
}
async function loadDshControls(modelsOnly=false){
  if(dshControls.loading||dshControls.busy)return
  dshControls.loading=true
  if(dshControls.value)renderDshControls()
  const before=dshControls.value,pending=dshControls.draft
  try {
    const fresh=await api('/api/dsh-compression');dshControls.value=fresh;dshControls.error=''
    const merged=modelsOnly&&before?mergeControlDraft(dshDraft(before),pending,dshDraft(fresh),['provider_ref','model','forkModelOverride'],dshEditable,{switchRatio:'customRatio',keep:'customKeep'}):{draft:dshDraft(fresh)}
    dshControls.draft=merged.draft;if(merged.conflict)dshControls.error=t('压缩设置已变化，请重新读取后保存')
  }catch(e){if(!before)dshControls.value=null;dshControls.error=e.message}
  finally{dshControls.loading=false;renderDshControls()}
}
async function saveDshControls(fields=null){
  if(dshControls.busy||dshControls.loading)return
  const before=dshControls.value,pending=dshControls.draft
  try {
    const payload=dshSettingsPayload(fields);dshControls.busy=true;dshControls.error='';renderDshControls()
    const fresh=await api('/api/dsh-compression',payload);dshControls.value=fresh
    const merged=mergeControlDraft(dshDraft(before),pending,dshDraft(fresh),fields||dshEditable,dshEditable,{switchRatio:'customRatio',keep:'customKeep'})
    dshControls.draft=merged.draft;if(merged.conflict)dshControls.error=t('压缩设置已变化，请重新读取后保存')
    if(state.harnesses)renderTools();toast(t(fresh.restart_required?'接管设置已保存，请重新加载 DSH 使其生效':fields?.includes('model')?'摘要模型已保存':'压缩设置已保存'))
  }catch(e){dshControls.error=e.message}
  finally{dshControls.busy=false;renderDshControls()}
}
