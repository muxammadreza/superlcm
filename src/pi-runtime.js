// Background preparation and lookup-only installation through Pi public hooks.
import { spawn } from 'node:child_process'
import { summarizePiFork } from './pi-fork.js'
import { readPiPolicy } from './pi-compaction-policy.js'
import { makePiSnapshot, snapshotMatches, piSignature, serializePiMessages } from './pi-snapshot.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { abortable, summaryAttempt } from './summary-attempt.js'
import { estimatePiRequest, piOutputReserve } from './pi-request.js'
import { checkedSummary } from './summary-policy.js'
export { serializePiMessages } from './pi-snapshot.js'
export { estimatePiRequest } from './pi-request.js'

export function piCompactRequest({ node, script, home, command = 'pi-prepare' }, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Pi 后台摘要已取消')); return }
    const child = spawn(node, [script, command, '--home', home], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let output = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) } else resolve(value)
    }
    const abort = () => finish(new Error('Pi 后台摘要已取消'))
    const timer = setTimeout(() => finish(new Error('Pi 后台摘要服务超时，原文保留')), command === 'pi-ready' ? 10000 : 15 * 60 * 1000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => finish(error))
    child.stdin.on('error', error => finish(error))
    child.stdout.on('data', data => { output += data; if (output.length > 2 * 1024 * 1024) finish(new Error('Pi 摘要结果过大')) })
    child.on('close', code => {
      try { const value = JSON.parse(output); if (code !== 0 || value.error) throw Error(value.error || 'Pi 后台摘要服务失败'); finish(null, value.prepared || null) }
      catch (error) { finish(error) }
    })
    try { child.stdin.end(JSON.stringify(input)) } catch (error) { finish(error) }
  })
}

export function registerPiCompaction(pi, options, {
  request = piCompactRequest, policy = () => readPiPolicy(options.home), makeSnapshot = makePiSnapshot, guardTimeoutMs = 180000,
} = {}) {
  let state = null, swapping = null, retryAfter = 0, failures = 0, retrySignature = null, capture = null, requestMessages = null, epoch = 0, sessionController = new AbortController()
  const settings = () => ({...(pi.getSettings?.() || {}), thinkingLevel:pi.getThinkingLevel?.()})
  const entries = ctx => ctx.sessionManager.buildSessionProjection().entries
  const signature = ctx => piSignature(ctx, policy(), settings())
  const status = (ctx, text) => ctx.ui?.setStatus?.('superlcm-compaction', text)
  const notice = (ctx, text) => ctx.ui?.notify?.(text, 'warning')
  const stop = () => { state?.controller.abort(); state = null }
  const clearRetries = () => { retryAfter = 0; failures = 0; retrySignature = null }
  const failed = ctx => {
    let current
    try { current = signature(ctx) } catch { current = 'unavailable-policy' }
    failures = retrySignature === current ? failures + 1 : 1; retrySignature = current
    retryAfter = Date.now() + 60000 * 2 ** Math.min(4, failures - 1)
  }
  const clearSnapshot = () => { stop(); clearRetries(); capture = null; requestMessages = null }
  const reset = () => { epoch++; sessionController.abort(Error('Pi 会话已切换或结束')); sessionController = new AbortController(); clearSnapshot(); swapping = null }
  const valid = (ctx, current = entries(ctx)) => state && snapshotMatches(state.snapshot, current, signature(ctx))
  const usage = ctx => ({ tokens: ctx.getContextUsage()?.tokens, window: ctx.model?.contextWindow })
  const reached = (ctx, ratio) => { const u = usage(ctx); return Number.isFinite(u.tokens) && Number.isFinite(u.window) && u.window > 0 && u.tokens >= u.window * ratio }
  function capacity(ctx, current = entries(ctx)) {
    const u = usage(ctx)
    if (!Number.isFinite(u.window) || u.window <= 0) return null
    const reserve = Number.isFinite(ctx.model?.maxTokens) ? Math.max(0, ctx.model.maxTokens) : Math.min(16384, u.window * .1)
    const inputLimit = Math.max(0, u.window - reserve - Math.max(1024, u.window * .02))
    const whole = estimateSummaryTokens(serializePiMessages(current.flatMap(e => e.messages)))
    const active = pi.getActiveTools?.(), tools = (pi.getAllTools?.() || []).filter(t => !active || active.includes(t.name))
    const declared = estimateSummaryTokens(ctx.getSystemPrompt?.() || '') + estimateSummaryTokens(JSON.stringify(tools))
    // Fixed prompts/tools are not compressible. Never subtract them from the
    // summary budget or pretend that replacing old dialogue removes them.
    const fixed = Math.max(declared, (u.tokens || 0) - whole, 0)
    return { inputLimit, guard: Math.min(u.window * .9, inputLimit), fixed, estimated: fixed + whole }
  }
  const danger = (ctx, current = entries(ctx)) => {
    const c = capacity(ctx, current)
    return c && (usage(ctx).tokens >= c.guard || c.estimated >= c.inputLimit)
  }
  const pause = ctx => {
    status(ctx, 'SuperLCM：已暂停，防止上下文超限')
    notice(ctx, '后台摘要未能提供足够空间，已暂停模型请求，原文完整保留。')
    ctx.abort?.()
  }
  function prepare(ctx, force = false) {
    try {
      const p = policy()
      if (!p.enabled&&!p.summaryEnabled) { stop(); status(ctx, undefined); return }
      if (state && !valid(ctx)) stop()
      if (retrySignature && retrySignature !== signature(ctx)) clearRetries()
      if (state || Date.now() < retryAfter || (!force && !reached(ctx, Math.round((p.ratio-.1)*1e12)/1e12))) return
      if (p.summaryMode === 'main-fork' && !capture) return
      const snapshot = makeSnapshot(ctx, p, settings())
      if (!snapshot) return
      const current = { snapshot, controller: new AbortController(), ready: null, promise: null }
      state = current; status(ctx, p.summaryMode === 'main-fork' ? 'SuperLCM：主模型后台分支摘要' : 'SuperLCM：Luna 后台准备摘要')
      const work = async () => {
        if (p.summaryMode !== 'main-fork') return request({ ...options, command: 'pi-prepare' }, snapshot, current.controller.signal)
        const restored = await request({ ...options, command: 'pi-ready' }, {session_id:snapshot.session_id,draftKey:snapshot.draftKey}, current.controller.signal)
        if (restored?.compaction) return restored
        const selectedCapture = capture
        let staged
        const forkSummary = await summarizePiFork(ctx, snapshot, selectedCapture, { signal: current.controller.signal,
          stage: async () => { staged = await request({ ...options, command: 'pi-stage' }, snapshot, current.controller.signal) } })
        if (state !== current || !valid(ctx)) throw Error('Pi 后台分支已过期')
        return request({ ...options, command: 'pi-prepare' }, { ...snapshot, sourceMessages: undefined, forkSummary, forkRevision: staged.revision }, current.controller.signal)
      }
      current.promise = work().then(result => {
        if (state !== current) return
        if (!valid(ctx)) { stop(); return }
        if (!result?.compaction) throw Error('Pi 后台摘要未返回完整结果，原文保留')
        current.ready = result; clearRetries(); status(ctx, policy().enabled ? 'SuperLCM：摘要已准备，80% 时替换' : 'SuperLCM：后台摘要已保存')
        if (policy().enabled&&ctx.isIdle() && (reached(ctx, policy().ratio) || danger(ctx))) void swapIdle(ctx)
      }).catch(error => {
        if (state !== current) return
        state = null; failed(ctx)
        status(ctx, 'SuperLCM：后台准备失败，原文保留'); notice(ctx, error.message)
      }).finally(() => { current.promise = null })
    } catch (error) { stop(); notice(ctx, error.message) }
  }
  async function ready(ctx, current = entries(ctx), signal, extra = 0) {
    if (!policy().enabled || !state?.ready || !valid(ctx, current)) return null
    const selected = state
    // This command only reads a completed result and validates model settings.
    // Cache misses never generate a summary here.
    const result = await request({ ...options, command: 'pi-ready' }, {
      session_id: ctx.sessionManager.getSessionId(), draftKey: selected.snapshot.draftKey,
    }, signal)
    if (state !== selected) return null
    if (!valid(ctx, current) || !result?.compaction) { stop(); return null }
    const compaction = result.compaction
    try { checkedSummary(compaction.summary, { requireHeading: true, maxChars: null }) }
    catch { stop(); failed(ctx); return null }
    if (compaction.firstKeptEntryId !== selected.snapshot.firstKeptEntryId || estimateSummaryTokens(compaction.summary) >= estimateSummaryTokens(selected.snapshot.source)) {
      stop(); failed(ctx); return null
    }
    const c = capacity(ctx, current), cut = current.findIndex(e => e.sourceEntry.id === selected.snapshot.firstKeptEntryId)
    const tail = estimateSummaryTokens(serializePiMessages(current.slice(cut).flatMap(e => e.messages)))
    if (!c || c.fixed + tail + estimateSummaryTokens(compaction.summary) + extra >= c.inputLimit) {
      stop(); status(ctx, 'SuperLCM：旧摘要覆盖不足，后台重新准备'); return null
    }
    return { ...compaction, tokensBefore: ctx.getContextUsage()?.tokens || compaction.tokensBefore,
      details: { ...compaction.details, backgroundPrepared: true, replacementModelCalls: 0 } }
  }
  async function guardedReady(ctx, current = entries(ctx), extra = 0) {
    const c = capacity(ctx, current)
    if (!danger(ctx, current) && (!c || c.estimated + extra < c.inputLimit)) return null
    status(ctx, 'SuperLCM：预留空间不足，暂停下一轮并等待后台摘要')
    const selectedEpoch = epoch
    try {
      return await summaryAttempt(async signal => {
        const waiting = state?.promise
        if (waiting) await abortable(waiting, signal)
        signal.throwIfAborted()
        let result = await ready(ctx, current, signal, extra)
        if (!result) {
          // One total deadline includes the current job, one restage and lookup.
          // Session cancellation must never restart work on the old context.
          signal.throwIfAborted()
          prepare(ctx, true)
          const next = state?.promise
          if (next && next !== waiting) { await abortable(next, signal); signal.throwIfAborted(); result = await ready(ctx, current, signal, extra) }
        }
        return result
      }, sessionController.signal, guardTimeoutMs)
    } catch (error) { if (epoch === selectedEpoch) { if (state) failed(ctx); stop() }; throw error }
  }
  async function swapIdle(ctx, force = false) {
    if (!policy().enabled || swapping || !ctx.isIdle() || !state?.ready || (!force && !reached(ctx, policy().ratio) && !danger(ctx))) return false
    const selectedEpoch = epoch, selectedState = state, token = {}; swapping = token
    try {
      await summaryAttempt(signal => abortable(new Promise((resolve, reject) => {
        try { ctx.compact({ onComplete: () => { if (epoch === selectedEpoch && !signal.aborted) { if (state === selectedState) stop(); status(ctx, 'SuperLCM：已替换为后台摘要') }; resolve() },
          onError: reject }) }
        catch (error) { reject(error) }
      }), signal), sessionController.signal, guardTimeoutMs)
      return epoch === selectedEpoch && signature(ctx) === selectedState.snapshot.signature
    } catch (error) {
      if (epoch === selectedEpoch && state === selectedState) { failed(ctx); notice(ctx, error.message); pause(ctx) }
      return false
    } finally { if (swapping === token) swapping = null }
  }
  pi.on('session_before_compact', async (event, ctx) => {
    const selectedEpoch = epoch
    try {
      if (!policy().enabled) return
      const compaction = await ready(ctx, entries(ctx), event.signal)
      if (epoch !== selectedEpoch) return { cancel: true }
      if (compaction) return { compaction: { ...compaction, tokensBefore: event.preparation.tokensBefore } }
      status(ctx, 'SuperLCM：后台摘要尚未准备好，保留原文')
      return { cancel: true }
    } catch (error) { notice(ctx, error.message); return { cancel: true } }
  })
  pi.on('turn_end', async (event, ctx) => {
    const selectedEpoch = epoch
    try {
      if (policy().enabled && event.context?.contextEntries && reached(ctx, policy().ratio)) {
        let compaction = await ready(ctx, event.context.contextEntries)
        if (epoch !== selectedEpoch) return
        if (!compaction && danger(ctx, event.context.contextEntries)) {
          compaction = await guardedReady(ctx, event.context.contextEntries)
          if (epoch !== selectedEpoch) return
          if (!compaction) { pause(ctx); return }
        }
        if (compaction) {
          status(ctx, 'SuperLCM：直接替换后台摘要')
          return { entries: [...(event.entries || []), { type: 'compaction', summary: compaction.summary,
            firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] }
        }
      }
      if (policy().enabled && event.context?.contextEntries && danger(ctx, event.context.contextEntries)) {
        const compaction = await guardedReady(ctx, event.context.contextEntries)
        if (epoch !== selectedEpoch) return
        if (compaction) return { entries: [...(event.entries || []), { type: 'compaction', summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] }
        pause(ctx); return
      }
      prepare(ctx) // deliberately fire-and-forget; the main tool loop continues
    } catch (error) { if (epoch !== selectedEpoch) return; notice(ctx, error.message); if (danger(ctx)) pause(ctx) }
  })
  for (const name of ['agent_settled', 'model_select', 'session_start']) pi.on(name, (_event, ctx) => {
    prepare(ctx); if (state?.ready) void swapIdle(ctx)
  })
  pi.on('input', async (event, ctx) => {
    const selectedEpoch = epoch
    const pending = estimatePiRequest({ text: event.text, images: event.images })
    const unsafeInput = () => { const c = capacity(ctx); return danger(ctx) || (c && c.estimated + pending >= c.inputLimit) }
    let preserved = false
    const preserve = () => { if (!preserved) { pi.appendEntry?.('superlcm-deferred-input', { text: event.text, images: event.images, reason: 'context-capacity' }); preserved = true } }
    const defer = () => {
      preserve()
      notice(ctx, '上下文保护已拦住本次模型请求。输入已保留，后台摘要恢复后可继续。')
      return { action: 'handled' }
    }
    try {
    prepare(ctx)
    if (policy().enabled && unsafeInput()) {
      preserve() // Preserve the input before any cancellable capacity wait.
      const c = capacity(ctx)
      if (c && pending + c.fixed >= c.inputLimit) return defer()
      let result
      try { result = await guardedReady(ctx, entries(ctx), pending) } catch (error) { notice(ctx, error.message) }
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (result) await swapIdle(ctx, true)
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (!result || unsafeInput()) {
        // A handled input never reaches the provider. Keep its exact text in
        // the append-only native transcript instead of silently dropping it.
        return defer()
      }
      return
    }
    if (state?.ready && (reached(ctx, policy().ratio) || danger(ctx))) {
      preserve(); const swapped = await swapIdle(ctx)
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (!swapped) return defer()
    }
    } catch (error) { notice(ctx, error.message); return defer() }
  })
  // Final public request-time hook also sees newly expanded user input, prompt
  // sections, images and tool declarations that were absent from the input hook.
  pi.on('context_with_system', (event, ctx) => {
    try {
      if (!policy().enabled&&!policy().summaryEnabled) return
      if (policy().summaryMode === 'main-fork') requestMessages = structuredClone(event.messages)
      if(!policy().enabled)return
      const c = capacity(ctx)
      if (!c || estimatePiRequest(event.messages) >= c.inputLimit) pause(ctx)
    } catch (error) { notice(ctx, error.message); pause(ctx) }
  })
  pi.on('before_provider_request', (event, ctx) => {
    try {
      const p = policy()
      if (!p.enabled && !p.summaryEnabled) return
      if (p.enabled) {
        const c = capacity(ctx), reserve = piOutputReserve(event.payload, ctx.model)
        const limit = c && Math.min(c.inputLimit, ctx.model.contextWindow - reserve - Math.max(1024, ctx.model.contextWindow * .02))
        if (!c || estimatePiRequest(event.payload) >= limit) { pause(ctx); return }
      }
      if (p.summaryMode !== 'main-fork') return
      capture = { payload: structuredClone(event.payload), messages: requestMessages, model: structuredClone(ctx.model), reasoning: pi.getThinkingLevel?.() }
      prepare(ctx)
    } catch (error) { notice(ctx, error.message); pause(ctx) }
  })
  pi.on('session_shutdown', () => reset())
  pi.on('session_before_switch', () => reset())
  pi.on('session_compact', () => clearSnapshot())
  pi.registerCommand('compact-policy', { description: 'Show SuperLCM background compaction policy', handler: async (_args, ctx) => {
    const p = policy()
    ctx.ui?.notify?.(`SuperLCM：${p.enabled ? '开启' : '关闭'}。提前后台准备${p.summaryMode === 'main-fork' ? '主模型分支' : 'Luna'}摘要，到 ${Math.round(p.ratio * 100)}% 直接替换。当前${state?.ready ? '已准备' : state ? '准备中' : '等待准备'}。`, 'info')
  } })
  return { prepare, ready, getState: () => state }
}
