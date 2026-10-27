// Native models belong to the harness's registry/account. This setting only
// changes the auxiliary branch and never switches the conversation model.
import {summaryMode} from './mode.js'
export async function saveForkModel(store,input,{catalog,env}={}) {
  if(!['claude-code','pi'].includes(input.harness))throw Error('不支持的后台分支工具')
  const current=()=>{
    const own=store.harnessSetting(input.harness)
    return {mode:own?.mode||store.globalSetting()?.mode||summaryMode(env),model:own?.mode==='main-fork'?own.model:null}
  }
  const check=()=>{
    const value=current()
    if(value.mode!=='main-fork'||value.mode!==input.expected?.mode||value.model!==input.expected?.model)throw Error('摘要设置已变化，请重新读取')
  }
  check()
  if(input.model!==null){
    if(typeof input.model!=='string'||!input.model)throw Error('请选择摘要模型')
    const list=await catalog(input.harness,{env})
    if(!list.models.some(model=>model.id===input.model))throw Error('所选模型不在本工具的模型列表中，请重新读取')
  }
  // The final check and write also serialize with other CLI/web processes.
  store.db.exec('BEGIN IMMEDIATE')
  try{
    check() // A catalog lookup can outlive a concurrent setting change.
    const saved=store.setHarnessSetting(input.harness,'main-fork',input.model)
    store.db.exec('COMMIT');return saved
  }catch(error){try{store.db.exec('ROLLBACK')}catch{};throw error}
}
