// The integrated plugin reads the same per-tool setting as the web console.
import {defaultRecentKeep} from '../src/recent-retention.js'
import {DatabaseSync} from 'node:sqlite'
import {existsSync,readFileSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {forkHash} from './fork-summary.js'
export function sharedSummary(home){
  const file=join(home,'lcm.sqlite')
  if(!existsSync(file))return {mode:null,tuning:{target_tokens:20000,fanout:4},integration:true}
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='harness_summary_settings'").get())return {mode:null,tuning:{target_tokens:20000,fanout:4},integration:true}
    const own=db.prepare("SELECT * FROM harness_summary_settings WHERE harness='dsh'").get(),global=db.prepare('SELECT * FROM global_summary_settings WHERE id=1').get()
    const integration=db.prepare("SELECT enabled FROM integrations WHERE harness='dsh'").get()?.enabled!==0
    const tuning=db.prepare('SELECT * FROM summary_tuning WHERE id=1').get()||{target_tokens:20000,fanout:4}
    const setting=own||global||{mode:'main-fork'},mode=setting.mode==='agent'?'main-fork':setting.mode
    return {mode:integration?mode:'off',setting,tuning,integration}
  }finally{db.close()}
}
export function readSettings(home){
  const summary=sharedSummary(home),file=join(home,'dsh-compression.json')
  const controls=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null,config=controls?.config||{}
  return {revision:forkHash([summary,controls]),settings:{summaryEnabled:summary.mode==='main-fork',summaryMode:'main-fork',takeover:!!config.auto&&summary.mode==='main-fork',
    forkModelOverride:config.forkModelOverride===true,summaryProvider:config.summarizationProvider||'',summaryModel:config.summarizationModel||'',summaryAdapter:config.summaryAdapter||null,chunkTokens:summary.tuning.target_tokens||Math.floor((summary.tuning.target_chars||80000)/4),fanout:summary.tuning.fanout||4,compressionRatio:config.switchRatio||.8}}
}
export function sharedControls(file,document){
  const summary=sharedSummary(dirname(file)),mode=summary.mode===null?(document.config.summaryMode||'api'):summary.mode==='main-fork'?'main-fork':'api'
  const config={...document.config,summaryMode:mode}
  // The Settings page is the sole authority for chunk size and tree fanout.
  if(summary.mode!==null){
    if(config.keepRecentTokens===undefined&&config.budgetMode!=='tokens')config.keepRecentTokens=defaultRecentKeep
    config.foldBatchTokens=summary.tuning.target_tokens||Math.floor((summary.tuning.target_chars||80000)/4)
    config.pressureFoldTokens=Math.min(config.pressureFoldTokens??config.foldBatchTokens,config.foldBatchTokens)
    config.condensedMinFanout=summary.tuning.fanout||4
  }
  if(summary.mode==='off'||mode==='api'&&(!config.summarizationProvider||!config.summarizationModel||!config.summaryAdapter?.plugin))config.auto=false
  return {...document,revision:summary.mode===null?document.revision:document.revision+':'+forkHash(summary).slice(0,16),config}
}
