import { applyTakeover } from './takeover.js'

export function enableSummaryOnly(store,harness,env=process.env) {
  if(harness==='claude-code')applyTakeover(store,{enabled:false},env)
  const existing=store.harnessSetting(harness)
  if(!existing&&!store.globalSetting())store.setHarnessSetting(harness,'main-fork')
  store.setIntegrationEnabled(harness,true)
}
