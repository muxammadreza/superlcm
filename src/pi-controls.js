import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { readPiPolicy, savePiPolicy, piPolicyPath } from './pi-compaction-policy.js'

export function piCompressionSettings(store) {
  const policy = readPiPolicy(store.dir,store.db), setting = store.harnessSetting('pi')
  const models = store.apiModels()
  const revision = createHash('sha256').update(JSON.stringify([policy, setting, models])).digest('hex')
  return { ...policy, prepare_ratio: Math.round((policy.ratio-.1)*1e12)/1e12, api_ref: setting?.mode === 'api' ? setting.api_ref : null,
    revision, models, summary: setting?.mode === 'api' ? { model: setting.model, effort: setting.api_effort || null } : null }
}

export function savePiCompression(store, input) {
  const file = piPolicyPath(store.dir)
  let original, written = false, intended
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const before = piCompressionSettings(store)
    if (input.revision !== before.revision) throw Error('Pi 压缩设置已变化，请重新读取')
    if (typeof input.enabled !== 'boolean' || !Number.isFinite(input.ratio) || input.ratio < .11 || input.ratio > .99) throw Error('Pi 压缩比例必须在11%到99%之间')
    const apiRef=input.api_ref===undefined?before.api_ref:input.api_ref
    if (apiRef !== null && (typeof apiRef !== 'string' || !store.apiModel(apiRef))) throw Error('请选择已保存的摘要 API 模型')
    const summaryMode = input.summaryMode ?? (input.api_ref?'api':before.summaryMode) ?? 'main-fork'
    if (!['api','main-fork'].includes(summaryMode)) throw Error('Pi 摘要方式无效')
    if (summaryMode !== 'main-fork' && !apiRef && !(before.summaryMode==='api'&&!before.api_ref)) throw Error('请先选择 Pi 的摘要 API 模型')
    const routeChanged=summaryMode!==before.summaryMode||input.api_ref!==undefined&&apiRef!==before.api_ref
    if(input.enabled&&!before.summaryEnabled&&!routeChanged)throw Error('请先在工具卡片开启后台摘要')
    original = existsSync(file) ? readFileSync(file) : null
    if (routeChanged&&summaryMode!=='main-fork'&&apiRef) store.setHarnessSetting('pi', 'api', null, null, null, apiRef)
    else if(routeChanged&&summaryMode==='main-fork')store.setHarnessSetting('pi','main-fork')
    savePiPolicy(store, { enabled: input.enabled, ratio: input.ratio, keep: input.keep===undefined?before.keep:input.keep, ...(routeChanged ? {summaryMode} : {}) }); written = true
    intended = piCompressionSettings(store)
    store.db.exec('COMMIT')
  } catch (error) {
    let rolledBack = false
    try { store.db.exec('ROLLBACK'); rolledBack = true } catch {}
    // A lost COMMIT receipt may mean both writes already succeeded. Keep that
    // consistent result rather than undoing only its file half.
    if (!rolledBack && written && !store.db.isTransaction && piCompressionSettings(store).revision === intended?.revision) return intended
    if (written) {
      if (original === null) unlinkSync(file)
      else { const temp = file + '.' + randomUUID(); writeFileSync(temp, original, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
    }
    throw error
  }
  return piCompressionSettings(store)
}
