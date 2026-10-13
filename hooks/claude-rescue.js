import {abortable} from '../src/summary-attempt.js'
import {checkedSummary} from '../src/summary-policy.js'
import {liveMessage} from '../src/claude-live-messages.js'
// Cache identity is exact serialization; durable source hashes stay in the CLI process.
const fingerprint=value=>JSON.stringify(value)

const pending=new Map(),ready=new Map()
let attemptSequence=0
export function discardClaudeRescue(session) {
  ready.delete(session)
  pending.get(session)?.controller.abort(Error('Session ended'))
}
export async function rescueClaude(api,id,event) {
  const messages=()=>event.messages.map(liveMessage)
  const eventHash=fingerprint([messages(),event.instructions||'',event.trigger]),running=pending.get(id)
  if(running)return running.hash===eventHash?running.promise:null
  const cancelId=Date.now().toString(36)+'-'+(++attemptSequence).toString(36)+'-'+Math.random().toString(36).slice(2)
  let work,revoke
  const controller=new AbortController(),signal=controller.signal
  const forward=()=>controller.abort(event.signal.reason||Error('Final summary cancelled'))
  if(event.signal){event.signal.addEventListener('abort',forward,{once:true});if(event.signal.aborted)forward()}
  const call=async(command,payload)=>{
    signal.throwIfAborted()
    const result=await api.run(['node',`${api.root}/src/launch.js`,command,id],{stdin:JSON.stringify({...payload,cancel_id:cancelId}),timeoutMs:60000})
    signal.throwIfAborted()
    const reply=JSON.parse(result.stdout.trim().split('\n').at(-1)||'{}')
    if(reply.error)throw Error('Final summary storage unavailable')
    return reply
  }
  const stopped=async draft=>{
    // Dispatch before awaiting the blocked save. CLI writes the marker before opening SQLite.
    try{await api.run(['node',`${api.root}/src/launch.js`,'compact-rescue-stop',id],{stdin:JSON.stringify({...draft,cancel_id:cancelId}),timeoutMs:60000})}catch{}
  }
  const cancel=()=>{revoke ||= stopped(work)}
  signal.addEventListener('abort',cancel,{once:true})
  if(signal.aborted)cancel()
  const promise=(async()=>{
    try{
      const usage=await api.usage(),model=await api.currentModel()
      signal.throwIfAborted()
      const input={messages:messages(),tokens:usage.context.tokens||0,window:usage.context.window||0,instructions:event.instructions||'',model,trigger:event.trigger}
      const hash=fingerprint(input)
      let cached=ready.get(id)
      if(cached?.hash!==hash){ready.delete(id);cached=null}
      if(cached)work=cached.work
      else{
        const plan=await call('compact-rescue-prepare',input)
        if(plan.use)return await api.currentModel()===input.model&&fingerprint(messages())===fingerprint(input.messages)?plan:null
        work=plan.work
        if(!work)return null
      }
      const identity={node_id:work.node_id,claim_id:work.claim_id,input_hash:work.input_hash}
      if(fingerprint(messages())!==fingerprint(input.messages)||!(await call('compact-rescue-check',identity)).valid){ready.delete(id);return null}
      let saved=cached?.saved
      if(!saved){
        const remaining=Math.max(1,work.deadline_ms-Date.now())
        const timer=setTimeout(()=>controller.abort(Error('Final summary request timed out')),remaining)
        let answer
        try{answer=await abortable(Promise.resolve().then(()=>{signal.throwIfAborted();return api.complete({model:work.model,system:work.system,prompt:work.prompt,maxTokens:work.maxTokens,timeoutMs:remaining})}),signal)}
        finally{clearTimeout(timer)}
        signal.throwIfAborted()
        if(answer?.isAnswered!==true||await api.currentModel()!==work.model)throw Error('Final summary incomplete or model changed')
        const finishReason=answer.stopReason??answer.stop_reason??answer.finishReason??answer.finish_reason
        const summary=checkedSummary(answer.text,{...work.task,maxChars:60000,finishReason})
        saved={...identity,summary,isAnswered:true,finishReason}
        ready.set(id,{hash,work,saved})
      }
      if(await api.currentModel()!==work.model||fingerprint(messages())!==fingerprint(input.messages)||!(await call('compact-rescue-check',identity)).valid){ready.delete(id);await stopped(work);return null}
      let plan
      // Retry only the save boundary, never buy the main summary again.
      for(let attempt=0;attempt<2;attempt++){
        try{plan=await call('compact-rescue-save',saved);break}catch(error){if(signal.aborted)throw error;if(attempt===1)return null}
      }
      if(plan?.use){ready.delete(id);return plan}
      ready.delete(id);return null
    }catch{
      ready.delete(id)
      if(revoke)await revoke
      else if(work)await stopped(work)
      return null
    }
  })()
  pending.set(id,{hash:eventHash,promise,controller})
  try{return await promise}finally{signal.removeEventListener('abort',cancel);event.signal?.removeEventListener('abort',forward);if(revoke)await revoke;if(pending.get(id)?.promise===promise)pending.delete(id)}
}
