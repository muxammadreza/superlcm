import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { compactPi, preparePi, readPreparedPi, stagePi, piSourceChunks, readPiPolicy, savePiPolicy } from '../src/pi-compaction.js'
import { registerPiCompaction, serializePiMessages, piCompactRequest } from '../src/pi-runtime.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
import { makePiSnapshot, snapshotMatches } from '../src/pi-snapshot.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-pi-compact-')), store = new ClaudeStore(join(dir, 'archive'))
  t.after(() => store.close())
  const root = join(dir, 'pi'), sessions = join(root, 'sessions'); mkdirSync(sessions, { recursive: true })
  const session_id = 'pi-test', session_file = join(sessions, 'test.jsonl')
  const entries = [{ type: 'session', id: session_id },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'Please inspect the project, preserving every original.' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Inspection is unfinished.' }] } },
    { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: 'Keep the newest request exactly.' } }]
  writeFileSync(session_file, entries.map(JSON.stringify).join('\n') + '\n')
  const m = store.saveApiModel({ provider: 'openai', model: 'fixture-luna', url: 'http://127.0.0.1:9/v1', effort: 'high' })
  store.setHarnessSetting('pi', 'api', null, null, null, m.id); store.setIntegrationEnabled('pi', true)
  savePiPolicy(store, { enabled: true, ratio: 0.8 })
  const input = { session_id, session_file, leafId: 'c', firstKeptEntryId: 'c', tokensBefore: 100000, source: 'user:\nPlease inspect the project, preserving every original.\nassistant:\nInspection is unfinished.' }
  return { dir, store, input, entries, env: { ...process.env, PI_CODING_AGENT_DIR: root } }
}
const summary = '# Current state\nThe inspection is unfinished. All source records remain available.\n\n## Recall for details\nRead the original tool outputs before using exact values.'

test('Pi takeover archives exact bytes, uses the selected Luna API, and preserves Pi cut point', async t => {
  const f = fixture(t), original = readFileSync(f.input.session_file, 'utf8'); let options
  const result = await compactPi(f.store, f.input, { env: f.env, summarize: async (_text, opt) => { options = opt; return summary } })
  assert.equal(result.firstKeptEntryId, 'c'); assert.equal(result.tokensBefore, 100000)
  assert.equal(options.model, 'fixture-luna'); assert.equal(options.effort, 'high'); assert.equal(options.apiProvider, 'openai')
  assert.match(result.summary, /lcm_read/); assert.equal(result.details.calls, 1)
  assert.equal(f.store.eventRows('pi-pi-test').map(row => f.store.exact('pi-pi-test', row.ordinal)).join(''), original)
  assert.equal(readFileSync(f.input.session_file, 'utf8'), original)
})
test('completed Pi pieces are reused on retries but not after model settings change', async t => {
  const f = fixture(t); let calls = 0
  const run = () => compactPi(f.store, f.input, { env: f.env, summarize: async () => { calls++; return summary } })
  await run(); const retry = await run(); assert.equal(calls, 1); assert.equal(retry.details.cached, 1)
  const m = f.store.saveApiModel({ provider: 'openai', model: 'fixture-new-luna', url: 'http://127.0.0.1:9/v1' })
  f.store.setHarnessSetting('pi', 'api', null, null, null, m.id)
  await run(); assert.equal(calls, 2)
})
test('Pi rejects a wrong branch boundary, deleted capture and missing API before any model call', async t => {
  const f = fixture(t); let calls = 0
  const options = { env: f.env, summarize: async () => { calls++; return summary } }
  await assert.rejects(compactPi(f.store, { ...f.input, firstKeptEntryId: 'other-branch' }, options), /保留边界/)
  f.store.setHarnessSetting('pi', 'cli')
  await assert.rejects(compactPi(f.store, f.input, options), /摘要 API|后台分支摘要/)
  f.store.db.prepare('INSERT INTO deleted_sessions VALUES(?,?)').run('pi-pi-test', Date.now())
  await assert.rejects(compactPi(f.store, f.input, options), /归档尚未完成/)
  assert.equal(calls, 0)
})
test('Pi cancellation and settings changes retain context and cannot publish a stale summary', async t => {
  const f = fixture(t), controller = new AbortController()
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, signal: controller.signal, summarize: async () => { controller.abort(); return summary } }), /abort/i)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => { savePiPolicy(f.store, { enabled: false, ratio: 0.8,keep:40000,summaryEnabled:false,summaryMode:'main-fork' }); return summary } }), /设置已变化/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM pi_compaction_chunks').get().n, 0)
})
test('Pi verifies originals again if source bytes change during summarization', async t => {
  const f = fixture(t)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => {
    // Neither the live file nor the archive may supply modified bytes.
    const file = f.store.archivePath('pi-pi-test')
    appendFileSync(file, 'tampered\n')
    const raw = readFileSync(file, 'utf8').replace('Inspection is unfinished.', 'Inspection was modified.')
    writeFileSync(file, raw); writeFileSync(f.input.session_file, raw); return summary
  } }), /digest|changed|mismatch|integrity|modified/i)
})
test('Pi chunks are bounded and concatenate to the complete multilingual input', () => {
  const source = ('中文：完整保留工具结果 😀\n' + 'x'.repeat(300) + '\n').repeat(100)
  const chunks = piSourceChunks(source, 500)
  assert.equal(chunks.join(''), source); assert.ok(chunks.length > 2)
  assert.ok(chunks.every(chunk => estimateSummaryTokens(chunk) <= 500))
})
test('Pi rejects mechanically shortened navigation instead of using it to replace live context', async t => {
  const f = fixture(t)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => summary + '\n[SuperLcm reduced navigation]' }), /机械截短/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM pi_compaction_chunks').get().n, 0)
})
test('Pi serializer keeps long tool results, failure evidence and call identifiers', () => {
  const text = 'result '.repeat(2000) + 'FINAL ERROR: quota exceeded'
  const output = serializePiMessages([{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } }] },
    { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text }] }])
  assert.ok(output.includes(text)); assert.match(output, /ERROR \/ failed/); assert.match(output, /call-1/)
})
function runtime({ tokens = 70000, idle = false, responder, compactEffect, guardTimeoutMs, readPolicy = () => ({ enabled: true, ratio: .8 }) } = {}) {
  const handlers = new Map(), commands = [], draft = {}, settings = { compaction: { keepRecentTokens: 512 } }
  const rows = [
    { sourceEntry: { id: 'u1', type: 'message' }, messages: [{ role: 'user', content: 'Original request. ' + 'constraint '.repeat(1000) }] },
    { sourceEntry: { id: 'a1', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Old work. '.repeat(500) }] }] },
    { sourceEntry: { id: 'u2', type: 'message' }, messages: [{ role: 'user', content: 'Recent request. ' + 'recent '.repeat(300) }] },
    { sourceEntry: { id: 'a2', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Keep newest assistant. '.repeat(100) }] }] },
  ]
  let compactCalls = 0, abortCalls = 0, api = null, resolvePrepare, rejectPrepare
  const deferredInputs = []
  const pending = new Promise((resolve, reject) => { resolvePrepare = resolve; rejectPrepare = reject })
  const ctx = { tokens, idle, model: { contextWindow: 100000, provider: 'test', id: 'chat' }, isIdle: () => ctx.idle,
    getContextUsage: () => ({ tokens: ctx.tokens }),
    sessionManager: { getSessionId: () => 's', getSessionFile: () => '/test.jsonl', getLeafId: () => rows.at(-1).sourceEntry.id, buildSessionProjection: () => ({ entries: rows }) },
    ui: { notify() {}, setStatus() {} }, abort() { abortCalls++ }, compact(options) { compactCalls++; if (compactEffect) { compactEffect(ctx, rows); options.onComplete() } } }
  const request = (options, input, signal) => {
    commands.push(options.command)
    if (responder) return responder(options, input, signal)
    if (options.command === 'pi-prepare') { draft.snapshot = input; draft.signal = signal; return pending }
    return Promise.resolve(draft.prepared)
  }
  api = registerPiCompaction({ on: (name, fn) => handlers.set(name, fn), getSettings: () => settings, registerCommand() {}, appendEntry: (type, data) => deferredInputs.push({ type, data }) }, { home: '/unused' }, { policy: readPolicy, request, guardTimeoutMs })
  const complete = async () => {
    draft.prepared = { draftKey: draft.snapshot.draftKey, compaction: { summary, firstKeptEntryId: draft.snapshot.firstKeptEntryId, tokensBefore: 70000, details: { model: 'fixture-luna' } } }
    resolvePrepare(draft.prepared); await api.getState()?.promise
  }
  return { handlers, commands, ctx, rows, api, draft, complete, rejectPrepare, deferredInputs, get compactCalls() { return compactCalls }, get abortCalls() { return abortCalls } }
}
const turn = r => r.handlers.get('turn_end')({ entries: [], context: { contextEntries: r.rows } }, r.ctx)

test('background starts before 80% and never blocks the main tool loop or new input', async () => {
  const r = runtime()
  await turn(r)
  assert.deepEqual(r.commands, ['pi-prepare']); assert.equal(r.api.getState().ready, null)
  r.ctx.tokens = 80000; r.ctx.idle = true
  await r.handlers.get('input')({}, r.ctx)
  assert.equal(r.compactCalls, 0); assert.equal(r.commands.length, 1)
  r.ctx.idle = false; await r.complete()
})
test('80% installs an already prepared prefix with zero replacement model requests and preserves appended tail', async () => {
  const r = runtime(); await turn(r); await r.complete()
  r.rows.push({ sourceEntry: { id: 'late', type: 'message' }, messages: [{ role: 'user', content: 'LATE USER REQUEST MUST REMAIN VERBATIM' }] })
  r.ctx.tokens = 80000
  const result = await turn(r)
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].type, 'compaction')
  assert.equal(result.entries[0].firstKeptEntryId, r.draft.snapshot.firstKeptEntryId)
  assert.equal(result.entries[0].details.replacementModelCalls, 0)
  assert.deepEqual(r.commands, ['pi-prepare', 'pi-ready'])
  assert.equal(r.compactCalls, 0, 'running tool chain must not be aborted through ctx.compact')
  assert.ok(!r.draft.snapshot.source.includes('LATE USER REQUEST'))
  assert.ok(r.rows.findIndex(e => e.sourceEntry.id === 'late') > r.rows.findIndex(e => e.sourceEntry.id === result.entries[0].firstKeptEntryId))
})
test('missing ready result at 80% cancels native compaction without generating synchronously', async () => {
  const r = runtime({ tokens: 80000 })
  const result = await r.handlers.get('session_before_compact')({ preparation: { tokensBefore: 80000 } }, r.ctx)
  assert.deepEqual(result, { cancel: true }); assert.deepEqual(r.commands, [])
})
test('manual/native compaction reuses a ready background result without asking Luna again', async () => {
  const r = runtime(); await turn(r); await r.complete(); r.ctx.tokens = 80000
  const result = await r.handlers.get('session_before_compact')({ preparation: { tokensBefore: 80000 } }, r.ctx)
  assert.equal(result.compaction.tokensBefore, 80000)
  assert.equal(result.compaction.firstKeptEntryId, r.draft.snapshot.firstKeptEntryId)
  assert.deepEqual(r.commands, ['pi-prepare', 'pi-ready'])
})
test('edited prefix or model change discards ready summaries before replacement', async () => {
  for (const change of [r => { r.rows[0].messages[0].content = 'Changed authorization' }, r => { r.ctx.model.id = 'different' }]) {
    const r = runtime(); await turn(r); await r.complete(); change(r); r.ctx.tokens = 80000
    const result = await turn(r)
    assert.equal(result, undefined)
    assert.equal(r.commands.filter(x => x === 'pi-ready').length, 0)
    r.handlers.get('session_shutdown')()
  }
})
test('background failures retry after cooldown without blocking the current run', async () => {
  const r = runtime(), originalNow = Date.now; let now = 0; Date.now = () => now
  try {
    await turn(r); r.rejectPrepare(Error('temporary Luna failure'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await turn(r); assert.equal(r.commands.length, 1)
    now = 61000; await turn(r); assert.equal(r.commands.length, 2)
  } finally { Date.now = originalNow; r.handlers.get('session_shutdown')() }
})
test('session shutdown cancels unfinished background generation', async () => {
  const r = runtime(); await turn(r)
  r.handlers.get('session_shutdown')()
  assert.equal(r.draft.signal.aborted, true); assert.equal(r.api.getState(), null)
})
test('capacity guard waits for the existing slow worker before allowing another model turn', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 90000
  let finished = false
  const guarded = turn(r).then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false); assert.deepEqual(r.commands, ['pi-prepare'])
  await r.complete()
  const result = await guarded
  assert.equal(result.entries[0].type, 'compaction'); assert.equal(r.abortCalls, 0)
})
test('failed summary at capacity aborts the tool loop and never falls through to a main request', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r); r.rejectPrepare(Error('Luna unavailable'))
  assert.equal(await guarded, undefined); assert.equal(r.abortCalls, 1)
  assert.deepEqual(r.commands, ['pi-prepare']); assert.equal(r.rows.length, 4)
})
test('an unshrinkable giant tool result is refused after one bounded restage', async () => {
  let writes = 0
  const r = runtime({ responder: async (opts, snapshot) => {
    if (opts.command === 'pi-prepare') { writes++; r.draft.snapshot = snapshot }
    return { compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } }
  } })
  await turn(r); await r.api.getState()?.promise
  r.rows.push({ sourceEntry: { id: 'huge', type: 'message' }, messages: [{ role: 'toolResult', toolCallId: 'new', content: [{ type: 'text', text: '巨'.repeat(120000) }] }] })
  r.ctx.tokens = 99000
  assert.equal(await turn(r), undefined); assert.equal(r.abortCalls, 1)
  assert.equal(writes, 2, 'only one fresh draft may be attempted at the guard')
  assert.equal(r.rows.at(-1).messages[0].content[0].text.length, 120000)
})
test('fixed system context and completion reserve can trigger protection before the percentage threshold', async () => {
  for (const configure of [ctx => { ctx.getSystemPrompt = () => '固'.repeat(100000) }, ctx => { ctx.model.maxTokens = 50000 }]) {
    const r = runtime({ tokens: 60000, responder: async () => { throw Error('unavailable') } }); configure(r.ctx)
    await turn(r); assert.equal(r.abortCalls, 1); assert.deepEqual(r.commands, ['pi-prepare'])
  }
})
test('capacity recovery can prepare and replace before 70% when output reserve needs space', async () => {
  const r = runtime({ tokens: 60000 }); r.ctx.model.maxTokens = 50000
  // A previous measured request includes fixed costs. Use a large compressible
  // history so a valid replacement can actually fit the remaining input budget.
  r.rows[0].messages[0].content = 'compressible history '.repeat(10000)
  const guarded = turn(r)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(r.commands, ['pi-prepare']); await r.complete()
  const result = await guarded
  assert.equal(result.entries[0].type, 'compaction'); assert.equal(r.abortCalls, 0)
})
test('cold input at capacity is preserved exactly and handled when Luna fails', async () => {
  const r = runtime({ tokens: 95000, idle: true })
  const input = r.handlers.get('input')({ text: 'Keep exact user input 请保留', images: [{ type: 'image', data: 'fixture' }] }, r.ctx)
  r.rejectPrepare(Error('Luna unavailable'))
  assert.deepEqual(await input, { action: 'handled' }); assert.equal(r.compactCalls, 0)
  assert.equal(r.deferredInputs[0].data.text, 'Keep exact user input 请保留')
  assert.equal(r.deferredInputs[0].data.images[0].data, 'fixture')
})
test('malformed runtime policy cannot silently release a blocked input to the provider', async () => {
  const r = runtime({ tokens: 99000, readPolicy: () => { throw Error('malformed policy') } })
  assert.deepEqual(await r.handlers.get('input')({ text: 'must survive' }, r.ctx), { action: 'handled' })
  assert.equal(r.deferredInputs[0].data.text, 'must survive'); assert.deepEqual(r.commands, [])
})
test('new oversized input is counted even before Pi persists the user message', async () => {
  const r = runtime({ tokens: 1000, idle: true })
  const text = '新'.repeat(150000)
  assert.deepEqual(await r.handlers.get('input')({ text }, r.ctx), { action: 'handled' })
  assert.equal(r.deferredInputs[0].data.text, text); assert.deepEqual(r.commands, [])
})
test('a large but admissible input recovers by compacting old history before the normal threshold', async () => {
  const r = runtime({ tokens: 60000, idle: true, compactEffect: (ctx, rows) => { rows.splice(0, rows.length - 1); ctx.tokens = 1000 } })
  r.rows[0].messages[0].content = 'compressible history '.repeat(10000)
  const input = r.handlers.get('input')({ text: '新'.repeat(30000) }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(r.commands, ['pi-prepare'])
  await r.complete()
  assert.equal(await input, undefined); assert.equal(r.compactCalls, 1)
  assert.equal(r.deferredInputs.length, 1, 'input is preserved before the cancellable wait, including successful recovery')
  assert.equal(r.deferredInputs[0].data.text, '新'.repeat(30000))
})
test('final request gate includes prompt expansion and tool declarations in the actual messages', () => {
  const r = runtime({ tokens: 1000 })
  r.handlers.get('context_with_system')({ messages: [{ role: 'system', content: '固'.repeat(150000) }] }, r.ctx)
  assert.equal(r.abortCalls, 1)
})
test('screenshots are budgeted as visual content rather than base64 text', async () => {
  const r = runtime({ tokens: 1000, idle: true })
  const images = [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(1000000) }]
  assert.equal(await r.handlers.get('input')({ text: 'inspect screenshot', images }, r.ctx), undefined)
  r.handlers.get('context_with_system')({ messages: [{ role: 'user', content: images }] }, r.ctx)
  assert.equal(r.abortCalls, 0); assert.equal(r.deferredInputs.length, 0)
})
test('snapshot preserves the full current human request while compressing a long autonomous turn', () => {
  const r = runtime(); r.rows.splice(2, 1)
  const snapshot = makePiSnapshot(r.ctx, { enabled: true, ratio: .8 }, { compaction: { keepRecentTokens: 512 } })
  assert.ok(snapshot.protectedRequest.includes(r.rows[0].messages[0].content))
  assert.ok(snapshotMatches(snapshot, r.rows, snapshot.signature))
})
test('snapshot never leaves a pending tool invocation on the discarded side', () => {
  const r = runtime(); r.rows.splice(2, 0,
    { sourceEntry: { id: 'call', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] }] },
    { sourceEntry: { id: 'result', type: 'message' }, messages: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'result '.repeat(500) }] }] })
  const snapshot = makePiSnapshot(r.ctx, { enabled: true, ratio: .8 }, { compaction: { keepRecentTokens: 2048 } })
  assert.notEqual(snapshot?.firstKeptEntryId, 'result')
})
test('durable prepared lookup is read-only, works after appended raw records and invalidates changed models', async t => {
  const f = fixture(t); let generated = 0
  f.input.draftKey = 'a'.repeat(64)
  await preparePi(f.store, f.input, { env: f.env, summarize: async () => { generated++; return summary } })
  appendFileSync(f.input.session_file, JSON.stringify({ type: 'message', id: 'late', parentId: 'c', message: { role: 'user', content: 'later append' } }) + '\n')
  const ready = readPreparedPi(f.store, f.input, { env: f.env })
  assert.equal(ready.compaction.firstKeptEntryId, 'c'); assert.equal(generated, 1)
  assert.match(f.store.exact('pi-pi-test', 4), /later append/)
  assert.equal(readPreparedPi(f.store, { ...f.input, draftKey: 'b'.repeat(64) }, { env: f.env }), null)
  savePiPolicy(f.store, { enabled: true, ratio: .9 })
  assert.equal(readPreparedPi(f.store, f.input, { env: f.env }), null)
  savePiPolicy(f.store, { enabled: true, ratio: .8 })
  f.store.setHarnessSetting('pi', 'off')
  assert.equal(readPreparedPi(f.store, f.input, { env: f.env }), null)
})
test('Pi subprocess cancellation rejects without a model or orphaned child', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(piCompactRequest({ node: process.execPath, script: '/missing', home: '/missing' }, {}, controller.signal), /取消/)
})
test('Pi takeover is opt-in and malformed policies fail closed', t => {
  const f = fixture(t)
  assert.deepEqual(readPiPolicy(join(f.dir, 'unconfigured')), { enabled: false, ratio: 0.8,keep:40000,summaryEnabled:false,summaryMode:'main-fork' })
  writeFileSync(join(f.store.dir, 'pi-compaction.json'), '{bad')
  assert.throws(() => readPiPolicy(f.store.dir))
})

test('Pi main-fork stores provider usage and blocks without touching the independent API', async t => {
  const { forkHash } = await import('../src/fork-summary.js')
  const { stagePi } = await import('../src/pi-compaction.js')
  const f = fixture(t)
  savePiPolicy(f.store,{enabled:true,ratio:.8,summaryMode:'main-fork'})
  f.store.clearHarnessSetting('pi')
  const staged=stagePi(f.store,f.input,{env:f.env})
  const input={...f.input,draftKey:'f'.repeat(64),forkRevision:staged.revision,forkSummary:{model:'fixture-main',provider:'fixture',sourceDigest:forkHash(f.input.source),prefixHash:'prefix',requestSettingsHash:'settings',usage:{cacheRead:9000},blocks:[{index:0,firstMessage:1,lastMessage:2,summary}]}}
  const options={env:f.env,summarize:async()=>{throw Error('must not call Luna')}}
  const result=await preparePi(f.store,input,options)
  assert.equal(result.compaction.details.calls,1)
  assert.equal(result.compaction.details.providerUsage.cacheRead,9000)
  assert.equal(result.compaction.details.sourceBlocks.length,1)
  assert.deepEqual(readPreparedPi(f.store,input,{env:f.env}),result)
  savePiPolicy(f.store,{enabled:true,ratio:.9,summaryMode:'main-fork'})
  assert.equal(readPreparedPi(f.store,input,{env:f.env}),null)
  await assert.rejects(preparePi(f.store,input,options),/设置已变化/)
})

test('Pi pressure wait has one deadline even if the backend never resolves', async () => {
  const r = runtime({ guardTimeoutMs: 20 }); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r)
  const observed = await Promise.race([guarded.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hung'), 100))])
  await r.complete(); await guarded
  assert.equal(observed, 'settled')
  assert.equal(r.abortCalls, 1)
  assert.equal(r.draft.signal.aborted, true)
  assert.equal(r.api.getState(), null)
})

test('Pi shutdown during a pressure wait cannot purchase a replacement worker', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r)
  r.handlers.get('session_shutdown')()
  r.rejectPrepare(Error('worker cancelled by shutdown'))
  await guarded
  assert.equal(r.commands.filter(c => c === 'pi-prepare').length, 1)
  assert.equal(r.api.getState(), null)
})

test('Pi checks the final native tools payload before dispatching a provider request', () => {
  const r = runtime({ readPolicy: () => ({ enabled: true, summaryEnabled: true, summaryMode: 'main-fork', ratio: .8 }) })
  r.handlers.get('context_with_system')({ messages: [{ role: 'system', content: 'Small system prompt.' }] }, r.ctx)
  r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: 'small' }], tools: [{ name: 'large_schema', description: '巨'.repeat(120000) }] } }, r.ctx)
  assert.equal(r.abortCalls, 1)
  assert.equal(r.api.getState(), null)
})

test('Pi final payload reserves the actual requested output limit in API mode too', () => {
  const r = runtime({ tokens: 1000, readPolicy: () => ({ enabled: true, summaryMode: 'api', ratio: .8 }) })
  r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: '中'.repeat(15000) }], max_tokens: 90000 } }, r.ctx)
  assert.equal(r.abortCalls, 1)
})

test('Pi native image payloads count visual tokens instead of encoded image bytes', () => {
  for (const image of [{ type: 'image_url', image_url: { url: 'data:image/png;base64,'+'a'.repeat(1000000) } }, { type: 'input_image', image_url: 'data:image/png;base64,'+'a'.repeat(1000000) }, { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1000000) } }]) {
    const r = runtime({ tokens: 1000 })
    r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: [image] }] } }, r.ctx)
    assert.equal(r.abortCalls, 0)
  }
})

test('Pi bounds a compaction callback that never arrives', async () => {
  const r = runtime({ guardTimeoutMs: 20 }); await turn(r); await r.complete()
  r.ctx.tokens = 80000; r.ctx.idle = true
  const result = await Promise.race([r.handlers.get('input')({ text: 'Retain this input while replacing.' }, r.ctx).then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hung'), 100))])
  assert.equal(result, 'settled'); assert.equal(r.compactCalls, 1)
  assert.equal(r.deferredInputs[0].data.text, 'Retain this input while replacing.')
  r.handlers.get('session_shutdown')()
})

test('Pi late lookup from an old session cannot discard a new ready draft', async () => {
  let release, delay = false
  const r = runtime({ responder: async (opts, snapshot) => {
    if (opts.command === 'pi-prepare') { r.draft.snapshot = snapshot; return { compaction: { summary, firstKeptEntryId: snapshot.firstKeptEntryId } } }
    if (delay) return new Promise(resolve => { release = resolve })
    return { compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } }
  } })
  await turn(r); await r.api.getState().promise
  delay = true; const lookup = r.api.ready(r.ctx)
  r.handlers.get('session_before_switch')(); delay = false
  await turn(r); await r.api.getState().promise
  const newer = r.api.getState()
  release({ compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } })
  assert.equal(await lookup, null); assert.equal(r.api.getState(), newer)
  r.handlers.get('session_shutdown')()
})

test('Pi late replacement callback cannot clear a new session draft', async () => {
  const r = runtime({ guardTimeoutMs: 1000 }); await turn(r); await r.complete()
  let callbacks
  r.ctx.compact = options => { callbacks = options }
  r.ctx.tokens = 80000; r.ctx.idle = true
  const input = r.handlers.get('input')({ text: 'Input awaiting compaction' }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(callbacks)
  r.handlers.get('session_before_switch')(); r.ctx.tokens = 70000; r.ctx.idle = false
  await turn(r); await r.api.getState().promise
  const newer = r.api.getState()
  callbacks.onComplete(); await input
  assert.equal(r.api.getState(), newer)
  assert.equal(r.deferredInputs[0].data.text, 'Input awaiting compaction')
  r.handlers.get('session_shutdown')()
})

test('Pi final payload rejects invalid output reservations and covers native Google settings', () => {
  for (const fields of [{ max_tokens: NaN }, { max_output_tokens: -1 }, { maxTokens: '1000' }, { generationConfig: { maxOutputTokens: 99000 } }]) {
    const r = runtime()
    r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: '中'.repeat(3000) }], ...fields } }, r.ctx)
    assert.equal(r.abortCalls, 1)
  }
})

test('Pi consecutive summary failures back off and a model change clears the old cooldown', async () => {
  const originalNow = Date.now; let now = 0
  Date.now = () => now
  const r = runtime({ responder: async () => { throw Error('synthetic transient summary failure') } })
  const attempt = async () => { await turn(r); await new Promise(resolve => setImmediate(resolve)) }
  try {
    await attempt(); assert.equal(r.commands.length, 1)
    now = 61000; await attempt(); assert.equal(r.commands.length, 2)
    now = 122000; await attempt(); assert.equal(r.commands.length, 2, 'second failure waits two minutes')
    now = 182000; await attempt(); assert.equal(r.commands.length, 3)
    now = 243000; await attempt(); assert.equal(r.commands.length, 3, 'third failure waits four minutes')
    r.ctx.model.id = 'new-model'; await attempt(); assert.equal(r.commands.length, 4)
  } finally { r.handlers.get('session_shutdown')(); Date.now = originalNow }
})

test('Pi treats an empty backend preparation response as a failure that can retry', async () => {
  const originalNow = Date.now; let now = 0
  Date.now = () => now
  const r = runtime({ responder: async () => null })
  try {
    await turn(r); await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.api.getState(), null, 'an empty response must not strand a permanently pending draft')
    now = 61000; await turn(r); await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.commands.length, 2)
  } finally {r.handlers.get('session_shutdown')(); Date.now = originalNow}
})

test('Pi late compaction callbacks cannot discard a draft for a newly selected model', async () => {
  const r = runtime({ guardTimeoutMs: 1000 }); await turn(r); await r.complete()
  let callbacks
  r.ctx.compact = options => { callbacks = options }
  r.ctx.tokens = 80000; r.ctx.idle = true
  const input = r.handlers.get('input')({ text: 'Input during a model change' }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(callbacks)
  r.ctx.model.id = 'new-model'; r.ctx.tokens = 70000; r.ctx.idle = false
  r.handlers.get('model_select')({}, r.ctx); await r.api.getState().promise
  const newer = r.api.getState()
  callbacks.onComplete(); assert.deepEqual(await input, { action: 'handled' })
  assert.equal(r.api.getState(), newer)
  r.handlers.get('session_shutdown')()
})

test('Pi archives a native summary source with takeover off and background summaries on', t => {
  const f = fixture(t)
  f.store.setHarnessSetting('pi', 'main-fork')
  savePiPolicy(f.store, { enabled: false, ratio: .8 })
  assert.equal(readPiPolicy(f.store.dir).summaryEnabled, true)
  assert.equal(stagePi(f.store, f.input, { env: f.env }).archived, true)
})

test('Pi background failure tolerates a policy that became unreadable during generation', async () => {
  let broken = false
  const r = runtime({ readPolicy: () => { if (broken) throw Error('invalid policy'); return { enabled: true, ratio: .8 } } })
  await turn(r)
  const work = r.api.getState().promise
  broken = true; r.rejectPrepare(Error('synthetic request failure'))
  await assert.doesNotReject(work)
  assert.equal(r.api.getState(), null)
  r.handlers.get('session_shutdown')()
})

test('Pi retention overrides native settings and caps at half of the current dialogue',()=>{
 const rows=Array.from({length:30},(_,i)=>({sourceEntry:{id:'e'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:[{type:'text',text:'exact original '.repeat(700)}]}]}))
 const ctx={model:{contextWindow:100000},sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'retention',getSessionFile:()=>'/fixture',getLeafId:()=> 'e29'},getContextUsage:()=>({tokens:80000})}
 const snapshot=keep=>makePiSnapshot(ctx,{enabled:true,ratio:.8,keep},{compaction:{keepRecentTokens:9999999}})
 const small=snapshot(5000),large=snapshot(40000),capped=snapshot(200000)
 assert.ok(Number(small.firstKeptEntryId.slice(1))>Number(large.firstKeptEntryId.slice(1)))
 assert.equal(capped.firstKeptEntryId,large.firstKeptEntryId)
 assert.notEqual(capped.draftKey,large.draftKey)
 assert.equal(snapshotMatches(large,rows,small.signature),false)
})
test('changing Pi retention invalidates an already prepared API replacement without another model call',async t=>{
 const f=fixture(t);f.input.draftKey='e'.repeat(64)
 let calls=0;await preparePi(f.store,f.input,{env:f.env,summarize:async()=>{calls++;return summary}})
 assert.ok(readPreparedPi(f.store,f.input,{env:f.env}))
 savePiPolicy(f.store,{enabled:true,ratio:.8,keep:80000})
 assert.equal(readPreparedPi(f.store,f.input,{env:f.env}),null);assert.equal(calls,1)
})
