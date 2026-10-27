import {saveForkTree} from './main-fork.js'
import {parseForkTree} from './fork-summary.js'
// Background-only worker. Pi persists the prepared replacement through its public
// boundary API; ready lookup never invokes the archive API or the chat model.
import { createHash } from 'node:crypto'
import { forkHash } from './fork-summary.js'
import { readPiPolicy } from './pi-compaction-policy.js'
export { readPiPolicy, savePiPolicy, piPolicyPath } from './pi-compaction-policy.js'
import { capturePi } from './pi.js'
import { summarizeWithModel, summarySettingsRevision } from './summarize.js'
import { checkedSummary, SUMMARY_POLICY_VERSION, RECALL_POLICY } from './summary-policy.js'
import { detectSummaryLanguage, userTextFromRecord } from './summary-language.js'
import { estimateSummaryTokens, takeTokenPrefix } from './summary-tokens.js'
import { isReducedSummary } from './summary-fitting.js'

const hash = value => createHash('sha256').update(value).digest('hex')
export function piSourceChunks(text, budget = 20000) {
  const chunks = []
  for (let rest = text; rest;) {
    let part = takeTokenPrefix(rest, budget)
    if (!part) throw Error('Pi 压缩分段预算不足')
    // Prefer a complete source line; a long tool result may span several pieces.
    const end = part.lastIndexOf('\n')
    if (part.length < rest.length && end > part.length / 2) part = part.slice(0, end + 1)
    chunks.push(part); rest = rest.slice(part.length)
  }
  return chunks
}
function activeBranch(store, session, leafId, keptId) {
  const entries = new Map(), rows = store.eventRows(session)
  for (const row of rows) {
    const entry = JSON.parse(store.exact(session, row.ordinal))
    if (entry.id && entry.type !== 'session') entries.set(entry.id, entry)
  }
  const branch = [], seen = new Set()
  for (let id = leafId; id != null;) {
    if (seen.has(id) || !entries.has(id)) throw Error('Pi 当前分支与已归档原文不一致')
    seen.add(id); const entry = entries.get(id); branch.unshift(entry); id = entry.parentId
  }
  if (!branch.length || !seen.has(keptId)) throw Error('Pi 原文保留边界不在当前分支')
  return { branch, last: rows.at(-1)?.ordinal ?? 0 }
}

export function piPreparationRevision(store, session, env = process.env) {
  const policy = readPiPolicy(store.dir)
  return policy.summaryMode === 'main-fork' ? forkHash(['pi-main-fork-tree-v2', policy]) : forkHash(['pi-api-preparation-v2',policy,summarySettingsRevision(store, session, env)])
}
export function stagePi(store, input, { env = process.env } = {}) {
  const policy = readPiPolicy(store.dir)
  if ((!policy.enabled && !policy.summaryEnabled) || !store.integrationEnabled('pi')) throw Error('Pi 后台摘要未启用')
  const captured = capturePi(store, input, { env, automatic: true })
  if (captured.skipped) throw Error('Pi 原文归档尚未完成')
  activeBranch(store, captured.session, input.leafId, input.firstKeptEntryId)
  return { archived: true, revision: piPreparationRevision(store, captured.session, env) }
}
export async function compactPi(store, input, { signal, summarize = summarizeWithModel, env = process.env } = {}) {
  const policy = readPiPolicy(store.dir)
  if ((!policy.enabled&&!policy.summaryEnabled) || !store.integrationEnabled('pi')) throw Error('Pi 压缩接管未启用')
  if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 64 * 1024 * 1024) throw Error('Pi 压缩原文为空或超过安全大小')
  if (!Number.isFinite(input.tokensBefore) || input.tokensBefore <= 0) throw Error('Pi 压缩缺少上下文用量')
  if (typeof input.firstKeptEntryId !== 'string' || typeof input.leafId !== 'string') throw Error('Pi 压缩缺少分支边界')
  const captured = capturePi(store, input, { env, automatic: true })
  if (captured.skipped) throw Error('Pi 原文归档尚未完成')
  const session = captured.session, { branch, last } = activeBranch(store, session, input.leafId, input.firstKeptEntryId)
  const setting = store.effectiveSetting(session, env), apiKey = store.apiCredential(session, env)
  if (policy.summaryMode !== 'main-fork' && (setting.mode !== 'api' || apiKey == null)) throw Error('Pi 压缩需要已配置的摘要 API，不使用主模型代替')
  const revision = piPreparationRevision(store, session, env)
  const valid = () => {
    signal?.throwIfAborted()
    if (JSON.stringify(readPiPolicy(store.dir)) !== JSON.stringify(policy) || piPreparationRevision(store, session, env) !== revision) throw Error('Pi 压缩设置已变化，保留原上下文')
  }
  store.db.exec('CREATE TABLE IF NOT EXISTS pi_compaction_chunks(session TEXT NOT NULL,key TEXT NOT NULL,summary TEXT NOT NULL,model TEXT NOT NULL,PRIMARY KEY(session,key))')
  const language = detectSummaryLanguage(branch.map(userTextFromRecord).filter(Boolean))
  let calls = 0, cached = 0
  const generate = async (source, level) => {
    valid()
    const key = hash(JSON.stringify([SUMMARY_POLICY_VERSION, revision, language, level, source]))
    const saved = store.db.prepare('SELECT summary FROM pi_compaction_chunks WHERE session=? AND key=?').get(session, key)
    if (saved && !isReducedSummary(saved.summary)) { cached++; return checkedSummary(saved.summary, { language, requireHeading: true }) }
    const summary = checkedSummary(await summarize(source, {
      model: setting.model, apiProvider: setting.api_provider, apiURL: setting.api_url, apiKey,
      effort: setting.api_effort, profileStore: store, signal, timeoutMs: 180000,
      shouldContinue: () => { valid(); return true },
      summaryTask: { level, language, targetTokens: 1200, requireHeading: true },
    }), { language, requireHeading: true })
    if (isReducedSummary(summary)) throw Error('Pi 摘要被机械截短，保留原上下文')
    valid(); calls++
    store.db.prepare('INSERT INTO pi_compaction_chunks VALUES(?,?,?,?) ON CONFLICT(session,key) DO UPDATE SET summary=excluded.summary,model=excluded.model').run(session, key, summary, setting.model)
    return summary
  }
  let fork = null
  if (policy.summaryMode === 'main-fork') {
    fork = input.forkSummary
    if (!fork || fork.sourceDigest !== forkHash(input.source) || !fork.model || !Array.isArray(fork.blocks) || !fork.blocks.length) throw Error('Pi 后台分支摘要或原文对应关系缺失')
    if (input.forkRevision !== revision) throw Error('Pi 压缩设置已变化，保留原上下文')
    let end = -1
    for (const [index, block] of fork.blocks.entries()) {
      if (block.index !== index || !Number.isSafeInteger(block.firstMessage) || !Number.isSafeInteger(block.lastMessage) || block.firstMessage <= end || block.lastMessage < block.firstMessage) throw Error('Pi 后台分支摘要范围无效')
      checkedSummary(block.summary, { language, requireHeading: true, maxChars: null }); end = block.lastMessage
    }
  }
  const pieces = fork ? fork.blocks : piSourceChunks(input.source), summaries = []
  for (let i = 0; i < pieces.length && !fork; i++) summaries.push(await generate(`[Pi source piece ${i + 1}; archive ${session}]\n${pieces[i]}`, 0))
  // Condense only as needed. Every generation is bounded, and completed pieces
  // survive cancellation/retry without paying for the same source again.
  if(fork?.tree){
    const validated=parseForkTree(JSON.stringify({blocks:fork.tree.map(n=>({index:n.index,summary:n.summary}))}),fork.blocks,language,fork.treeOptions||{})
    fork.tree=validated
  }
  if (fork) { summaries.push(...fork.blocks.map(block => `原文消息 ${block.firstMessage}–${block.lastMessage}\n${block.summary}`)); calls = 1 }
  const target = Math.min(20000, Math.max(2048, input.tokensBefore * 0.2))
  let nodes = fork?.tree?.length?[fork.tree.at(-1).summary]:summaries
  for (let level = 1; estimateSummaryTokens(nodes.join('\n\n')) > target && level <= 8 && !fork; level++) {
    const next = []
    for (let i = 0; i < nodes.length; i += 4) next.push(await generate(nodes.slice(i, i + 4).join('\n\n'), level))
    if (estimateSummaryTokens(next.join('\n\n')) >= estimateSummaryTokens(nodes.join('\n\n'))) throw Error('Pi 摘要未能缩短，保留原上下文')
    nodes = next
  }
  valid()
  if (estimateSummaryTokens(nodes.join('\n\n')) > target) throw Error('Pi 摘要仍超出预算，保留原上下文')
  // Check the archived bytes again after model work. No uncertain cut point is published.
  activeBranch(store, session, input.leafId, input.firstKeptEntryId)
  if(fork?.tree&&fork.blocks.every(b=>Array.isArray(b.entryIds)&&b.entryIds.length)){
    const byId=new Map(store.eventRows(session).map(row=>[JSON.parse(store.exact(session,row.ordinal)).id,row]))
    const ranges=fork.blocks.map(block=>{
      const rows=block.entryIds.map(id=>byId.get(id));if(rows.some(r=>!r))throw Error('Pi 分块原文编号已失效')
      return {first:Math.min(...rows.map(r=>r.ordinal)),last:Math.max(...rows.map(r=>r.ordinal)),rows}
    })
    const tree=fork.tree.map(n=>({...n,sourceRecords:ranges.filter((r,i)=>fork.blocks[i].firstMessage>=n.firstMessage&&fork.blocks[i].lastMessage<=n.lastMessage).flatMap(r=>r.rows.map(row=>row.ordinal)),firstMessage:n.level===0?ranges[n.index].first:Math.min(...fork.tree.filter(l=>l.level===0&&l.firstMessage>=n.firstMessage&&l.lastMessage<=n.lastMessage).map(l=>ranges[l.index].first)),lastMessage:n.level===0?ranges[n.index].last:Math.max(...fork.tree.filter(l=>l.level===0&&l.firstMessage>=n.firstMessage&&l.lastMessage<=n.lastMessage).map(l=>ranges[l.index].last))}))
    const originals=[...new Map(ranges.flatMap(r=>r.rows).map(r=>[r.ordinal,{ordinal:r.ordinal,digest:r.digest}])).values()]
    saveForkTree(store,session,{digest:fork.sourceDigest,originals},tree,{model:fork.model,usage:fork.usage,validate:()=>{valid();return true}})
  }
  const code = store.metadata(session).code
  const summary = `# SuperLcm · Pi\n\n原文已完整保存在 #${code}（当前分支 ${input.leafId}）。用 lcm_outline 定位，再用 lcm_read {"conversation":"#${code}","from":0,"to":${last}} 分页读取原文。\n${RECALL_POLICY}\n\n` + nodes.join('\n\n') + (input.protectedRequest ? '\n\n<current-user-request historical="true">\n' + input.protectedRequest + '\n</current-user-request>' : '')
  return { summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore,
    details: { superlcm: true, model: fork?.model || setting.model, summaryMode: policy.summaryMode || 'api', ...(fork ? {provider:fork.provider, providerUsage:fork.usage, prefixHash:fork.prefixHash, requestSettingsHash:fork.requestSettingsHash, sourceBlocks:fork.blocks,...(fork.tree?{summaryTree:fork.tree}:{})} : {}), ratio: policy.ratio, summaryRevision:revision, session, leafId: input.leafId, chunks: pieces.length, calls, cached,
      readFiles: input.readFiles || [], modifiedFiles: input.modifiedFiles || [] } }
}

const preparedSchema = store => store.db.exec('CREATE TABLE IF NOT EXISTS pi_prepared_compactions(session TEXT NOT NULL,draft_key TEXT NOT NULL,revision TEXT NOT NULL,snapshot TEXT NOT NULL,compaction TEXT NOT NULL,PRIMARY KEY(session,draft_key))')
export async function preparePi(store, input, options) {
  if(typeof input.draftKey!=='string'||!/^[a-f0-9]{64}$/.test(input.draftKey))throw Error('Pi 后台摘要缺少快照标识')
  preparedSchema(store)
  const old=readPreparedPi(store,input,{env:options?.env})
  if(old)return old
  const compaction=await compactPi(store,input,options),session=compaction.details.session
  preparedSchema(store)
  const {source,sourceMessages,protectedRequest,forkSummary,...snapshot}=input
  store.db.prepare('INSERT OR REPLACE INTO pi_prepared_compactions VALUES(?,?,?,?,?)').run(session,input.draftKey,compaction.details.summaryRevision,JSON.stringify(snapshot),JSON.stringify(compaction))
  // One ready prefix per session. Newer attempts replace it only after completion.
  store.db.prepare('DELETE FROM pi_prepared_compactions WHERE session=? AND draft_key<>?').run(session,input.draftKey)
  return {draftKey:input.draftKey,compaction}
}
// Lookup-only endpoint. It must never call a summarizer, even for a cache miss.
export function readPreparedPi(store,input,{env=process.env}={}) {
  if((!readPiPolicy(store.dir).enabled&&!readPiPolicy(store.dir).summaryEnabled)||!store.integrationEnabled('pi'))return null
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pi_prepared_compactions'").get())return null
  const session='pi-'+input.session_id
  const saved=store.db.prepare('SELECT * FROM pi_prepared_compactions WHERE session=? AND draft_key=?').get(session,input.draftKey)
  if(!saved||!store.source(session)||store.isDeleted(session)||piPreparationRevision(store,session,env)!==saved.revision)return null
  const snapshot=JSON.parse(saved.snapshot),compaction=JSON.parse(saved.compaction)
  if(compaction.details.ratio!==readPiPolicy(store.dir).ratio)return null
  const captured=capturePi(store,{session_id:input.session_id,session_file:snapshot.session_file},{env,automatic:true})
  if(captured.skipped)return null
  activeBranch(store,session,snapshot.leafId,snapshot.firstKeptEntryId)
  return {draftKey:input.draftKey,compaction}
}
