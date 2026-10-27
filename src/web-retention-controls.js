// Same recent-original preference and validation on every takeover page.
function recentKeepField(tool,draft,disabled) {
  const custom=draft.customKeep??![20000,40000,80000].includes(draft.keep)
  const off=disabled?' disabled':''
  return '<h3>'+t('最近原文保留')+'</h3><p class="desc">'+t('替换时最近这么多内容一字不改地留下，接着干活不丢细节；更早的才换成摘要。最多保留当前上下文的一半。')+'</p><div class="choice" role="radiogroup" aria-label="'+t('最近原文保留')+'">'+[20000,40000,80000].map(n=>'<button type="button" role="radio" data-keep-choice="'+n+'" aria-checked="'+(!custom&&draft.keep===n)+'"'+off+'>'+n/1000+'K'+(n===40000?'<small>'+t('推荐')+'</small>':'')+'</button>').join('')+'<button type="button" role="radio" data-keep-choice="custom" aria-checked="'+custom+'"'+off+'>'+t('自定义')+'<small>'+(custom&&Number.isFinite(draft.keep)?esc(draft.keep/1000)+'K':'')+'</small></button></div>'+
    '<div class="custom-size" id="'+tool+'KeepCustom"'+(custom?'':' hidden')+'><input type="number" inputmode="numeric" id="'+tool+'-keep" aria-label="'+t('自定义最近原文保留')+'" min="5" max="200" step="1" value="'+esc(Number.isFinite(draft.keep)?draft.keep/1000:'')+'"'+off+'><span>K</span><button type="button" class="btn small" id="'+tool+'KeepSave"'+off+'>'+t('保存')+'</button><span class="hint">5K–200K</span></div>'
}
function bindRecentKeep(root,tool,draft,render,dirty,save) {
  const input=root.querySelector('#'+tool+'-keep')
  input.oninput=()=>{
    draft.keep=input.value.trim()?Number(input.value)*1000:NaN;draft.customKeep=true
    for(const button of root.querySelectorAll('[data-keep-choice]'))button.setAttribute('aria-checked',String(button.dataset.keepChoice==='custom'))
    const badge=root.querySelector('[data-keep-choice="custom"] small');if(badge)badge.textContent=Number.isFinite(draft.keep)?draft.keep/1000+'K':''
    dirty?.()
  }
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();act(save)}}
  for(const button of root.querySelectorAll('[data-keep-choice]'))button.onclick=()=>{
    draft.customKeep=button.dataset.keepChoice==='custom'
    if(!draft.customKeep)draft.keep=Number(button.dataset.keepChoice)
    render();dirty?.()
    if(!draft.customKeep)return act(save)
    if(draft.customKeep)root.querySelector('#'+tool+'-keep').focus?.()
  }
  root.querySelector('#'+tool+'KeepSave').onclick=()=>act(save)
}
function validRecentKeep(value) {return Number.isSafeInteger(value)&&value>=5000&&value<=200000}

// Preserve unsaved fields after a scoped save, without accepting a concurrent
// change to those same fields under the new optimistic-lock revision.
function mergeControlDraft(before,pending,fresh,saved,keys,aliases={}) {
  const result={...fresh};let conflict=false
  for(const key of keys)if(!saved.includes(key)&&pending[key]!==before[key]) {
    if(fresh[key]!==before[key])conflict=true
    result[key]=pending[key]
  }
  for(const [key,alias] of Object.entries(aliases))if(!saved.includes(key)&&alias in pending)result[alias]=pending[alias]
  return {draft:conflict?pending:result,conflict}
}
