import {cappedRecentKeep} from './recent-retention.js'
import { createHash } from 'node:crypto'
import { estimateSummaryTokens } from './summary-tokens.js'

export const piDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Keep complete text and tool failure evidence. Binary content remains archived.
export function serializePiMessages(messages) {
  const blocks = content => typeof content === 'string' ? content : (content || []).map(block => {
    if (block.type === 'text') return block.text || ''
    if (block.type === 'toolCall') return `[Tool call ${block.name}; id=${block.id}; requested, not completed]\n${JSON.stringify(block.arguments)}`
    if (['thinking', 'redactedThinking'].includes(block.type)) return ''
    return `[${block.type || 'non-text'} block preserved in original archive]`
  }).filter(Boolean).join('\n')
  return messages.map((m, i) => `[Pi message ${i}; ${m.role}; ${m.isError ? 'ERROR / failed' : 'read result for outcome'}${m.toolCallId ? '; toolCallId=' + m.toolCallId : ''}]\n${m.summary || blocks(m.content)}`).join('\n\n')
}
const view = entries => entries.map(e => ({ id: e.sourceEntry.id, messages: e.messages }))
export const snapshotPrefix = (entries, index) => piDigest(view(entries.slice(0, index)))
export function piSignature(ctx, policy, settings = {}) {
  return piDigest([policy, ctx.model?.provider, ctx.model?.id, ctx.model?.contextWindow, ctx.model?.maxTokens, ctx.model?.api, ctx.model?.baseUrl, settings.thinkingLevel, settings.compaction])
}
export function snapshotMatches(snapshot, entries, signature) {
  const cut = entries.findIndex(e => e.sourceEntry.id === snapshot.firstKeptEntryId)
  return snapshot.signature === signature && cut > 0 && snapshotPrefix(entries, cut) === snapshot.prefixDigest
}
// Only cut before a user/assistant message with no pending tool results. This
// also supports a long autonomous turn without splitting an invocation/result pair.
export function makePiSnapshot(ctx, policy, settings = {}) {
  const entries = ctx.sessionManager.buildSessionProjection().entries
  const sizes = entries.map(e => estimateSummaryTokens(serializePiMessages(e.messages)))
  const keep = policy.keep === undefined ? Math.max(512, settings.compaction?.keepRecentTokens ?? 20000) : cappedRecentKeep(policy.keep, sizes.reduce((a,b)=>a+b,0))
  let retain = 0, desired = entries.length
  for (let i = entries.length - 1; i >= 0; i--) { retain += sizes[i]; if (retain >= keep) { desired = i; break } }
  if (desired === entries.length) return null
  const pending = new Set(); let cut = -1
  for (let i = 0; i <= desired; i++) {
    const e = entries[i], first = e.messages[0]
    if (i > 0 && !pending.size && e.sourceEntry.type !== 'compaction' && ['user', 'assistant'].includes(first?.role)) cut = i
    for (const message of e.messages) {
      if (message.role === 'assistant') for (const block of message.content || []) if (block.type === 'toolCall') pending.add(block.id)
      if (message.role === 'toolResult') pending.delete(message.toolCallId)
    }
  }
  if (cut <= 0) return null
  const messages = entries.slice(0, cut).flatMap(e => e.messages)
  if (!messages.some(m => !['compactionSummary', 'branchSummary'].includes(m.role))) return null
  const source = serializePiMessages(messages)
  if (!source.trim()) return null
  // A split autonomous turn keeps its latest complete human request verbatim.
  const latestUser = entries.findLastIndex(e => e.messages.some(m => m.role === 'user'))
  const protectedRequest = latestUser >= 0 && latestUser < cut ? serializePiMessages(entries[latestUser].messages.filter(m => m.role === 'user')) : ''
  const snapshot = {
    session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(), firstKeptEntryId: entries[cut].sourceEntry.id,
    tokensBefore: ctx.getContextUsage()?.tokens || sizes.reduce((a, b) => a + b, 0), source, protectedRequest,
    ...(policy.summaryMode === "main-fork" ? {summaryModel:policy.summaryModel||null,sourceMessages: messages,sourceEntryIds:entries.slice(0,cut).flatMap(e=>e.messages.map(()=>e.sourceEntry.id)),summaryTuning:{targetTokens:policy.targetTokens||20000,fanout:policy.fanout||4}} : {}),
    prefixDigest: snapshotPrefix(entries, cut), signature: piSignature(ctx, policy, settings),
  }
  snapshot.draftKey = piDigest([snapshot.session_id, snapshot.firstKeptEntryId, snapshot.prefixDigest, snapshot.signature])
  return snapshot
}
