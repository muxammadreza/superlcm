import {defaultRecentKeep, recentKeep} from './recent-retention.js'
import {DatabaseSync} from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const piPolicyPath = home => join(home, 'pi-compaction.json')
function legacyPiPolicy(home) {
  const file = piPolicyPath(home)
  if (!existsSync(file)) return { enabled: false, ratio: 0.8, keep: defaultRecentKeep }
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof value.enabled !== 'boolean' || !Number.isFinite(value.ratio) || value.ratio < 0.11 || value.ratio > 0.99) throw Error('Pi 压缩设置无效')
  if (value.summaryMode !== undefined && !['api', 'main-fork'].includes(value.summaryMode)) throw Error('Pi 摘要方式无效')
  return { enabled: value.enabled, ratio: value.ratio, keep: recentKeep(value.keep), ...(value.summaryMode ? {summaryMode:value.summaryMode} : {}) }
}
// Summary routing has one authority: the shared per-tool setting. The legacy
// file carries takeover/ratio/retention compatibility for already installed hosts.
export function readPiPolicy(home, suppliedDB) {
  const policy=legacyPiPolicy(home),file=join(home,'lcm.sqlite')
  if(!existsSync(file))return {...policy,summaryEnabled:policy.enabled,summaryMode:policy.summaryMode||'main-fork'}
  const db=suppliedDB||new DatabaseSync(file,{readOnly:true})
  try {
    const own=db.prepare("SELECT mode,model FROM harness_summary_settings WHERE harness='pi'").get()
    const global=db.prepare('SELECT mode FROM global_summary_settings WHERE id=1').get()
    const connected=db.prepare("SELECT enabled FROM integrations WHERE harness='pi'").get()?.enabled!==0
    const mode=connected?((own||global)?.mode||'main-fork'):'off'
    const tuning=db.prepare('SELECT target_chars,target_tokens,fanout FROM summary_tuning WHERE id=1').get()||{target_tokens:20000,fanout:4}
    return {...policy,enabled:policy.enabled&&mode!=='off',summaryEnabled:mode!=='off',summaryMode:mode==='api'?'api':'main-fork',targetTokens:tuning.target_tokens||Math.floor((tuning.target_chars||80000)/4),fanout:tuning.fanout,...(own?.mode==='main-fork'&&own.model?{summaryModel:own.model}:{})}
  }finally{if(!suppliedDB)db.close()}
}
export function savePiPolicy(store, value) {
  if (typeof value.enabled !== 'boolean' || !Number.isFinite(value.ratio) || value.ratio < 0.11 || value.ratio > 0.99) throw Error('Pi 压缩设置无效')
  if (value.summaryMode !== undefined && !['api', 'main-fork'].includes(value.summaryMode)) throw Error('Pi 摘要方式无效')
  const keep=recentKeep(value.keep===undefined?readPiPolicy(store.dir,store.db).keep:value.keep)
  const mode=value.summaryMode||readPiPolicy(store.dir,store.db).summaryMode
  if (value.enabled && mode !== 'main-fork' && (store.harnessSetting('pi')||store.globalSetting())?.mode !== 'api') throw Error('请先选择 Pi 的摘要 API 模型')
  if(value.summaryMode==='main-fork'&&store.harnessSetting('pi')?.mode!=='main-fork')store.setHarnessSetting('pi','main-fork')
  const file = piPolicyPath(store.dir), temp = file + '.' + randomUUID()
  writeFileSync(temp, JSON.stringify({ enabled: value.enabled, ratio: value.ratio, keep, ...(value.summaryMode ? {summaryMode:value.summaryMode} : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temp, file)
  return readPiPolicy(store.dir,store.db)
}
