// Native session forks retain the host's system prompt, tools and model setup.
// Worker-only execution hooks block local tools without replacing their schemas.
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {fileURLToPath} from 'node:url'
import {findCli,workerEnv} from './runtime.js'
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'"
export const forkGuardCommand=()=>quote(process.execPath)+' '+quote(fileURLToPath(new URL('./cli.js',import.meta.url)))+' fork-deny'
export const forkGuard=()=>({PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:forkGuardCommand(),timeout:5}]}]})
export const deniedForkTool=()=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'SuperLcm summary branches only generate summary text.'}})
function launch(bin,args,{env,signal,spawnProcess=spawn,timeoutMs=180000},onLine){
  if(!bin)throw Error('未安装对应工具，无法创建主模型后台分支')
  signal?.throwIfAborted()
  const child=spawnProcess(bin,args,{env:workerEnv(env),stdio:['pipe','pipe','pipe'],windowsHide:true})
  let closed=false,size=0,abort
  const done=new Promise((resolve,reject)=>{
    const stop=error=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child.kill('SIGTERM');const kill=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},1500);kill.unref();error?reject(error):resolve()}
    const timer=setTimeout(()=>stop(Error('主模型后台分支超时，原文保留')),timeoutMs)
    abort=()=>stop(signal.reason||Error('主模型后台分支已取消'));signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted)abort()
    child.stdout.on('data',buffer=>{size+=buffer.length;if(size>8*1024*1024)stop(Error('分支返回过大，原文保留'))})
    child.on('error',stop);child.stderr.resume();child.stdin.on('error',stop)
    const lines=createInterface({input:child.stdout})
    lines.on('line',line=>{if(closed)return;try{onLine(JSON.parse(line),stop,child)}catch(e){stop(e)}})
    child.on('close',code=>stop(code===0?null:Error('后台分支异常退出，原文保留')))
  })
  return {child,done}
}
export async function summarizeClaudeFork(session,prompt,{env=process.env,model,...options}={}){
  let result
  const args=['--resume',session,'--fork-session','--print','--output-format','stream-json','--verbose','--max-turns','1','--settings',JSON.stringify({hooks:forkGuard()})]
  if(model)args.push('--model',model)
  const run=launch(findCli('claude',env),args,{env,...options},(item,stop)=>{
    if(item.type==='assistant'&&item.message?.content?.some(b=>b.type==='tool_use'))return stop(Error('摘要分支请求了工具，结果未保存'))
    if(item.type==='result'){
      if(item.is_error||item.subtype&&item.subtype!=='success'||!item.result?.trim())throw Error('Claude 分支未完整结束，原文保留')
      if(item.stop_reason&&!['end_turn','stop','stop_sequence'].includes(item.stop_reason))throw Error('Claude 分支输出被截断')
      result={text:item.result,model:item.model||'claude:session-model',usage:item.usage||{},branchId:item.session_id}
    }
  })
  run.child.stdin.end(prompt);await run.done
  if(!result)throw Error('Claude 分支缺少完成回执')
  return result
}
export async function summarizeCodexFork(session,prompt,{env=process.env,lastTurnId,...options}={}){
  let sequence=0,branch,completed=false,text='',usage={},model='codex:session-model'
  const pending=new Map(),listeners=new Set()
  const run=launch(findCli('codex',env),['app-server','--stdio'],{env,...options},(item,stop,child)=>{
    if(item.id!==undefined&&!item.method){const p=pending.get(item.id);if(p){pending.delete(item.id);item.error?p.reject(Error(item.error.message||'Codex 分支请求失败')):p.resolve(item.result)}return}
    if(item.method&&item.id!==undefined){child.stdin.write(JSON.stringify({id:item.id,error:{code:-32000,message:'Summary branches cannot request tools or approval'}})+'\n');return stop(Error('摘要分支请求了工具或授权，原文保留'))}
    const p=item.params||{}
    if(!branch||p.threadId!==branch)return
    if(item.method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(p.item?.type))return stop(Error('Codex 摘要分支产生工具操作，结果未保存'))
    if(item.method==='item/completed'&&p.item?.type==='agentMessage')text=p.item.text||text
    if(item.method==='thread/tokenUsage/updated')usage=p.tokenUsage?.last||p.tokenUsage||{}
    if(item.method==='turn/completed'){
      if(p.turn?.status!=='completed')return stop(Error('Codex 分支未完整结束，原文保留'))
      completed=true;for(const resolve of listeners)resolve()
    }
    if(item.method==='error')stop(Error('Codex 分支返回错误，原文保留'))
  })
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});run.child.stdin.write(JSON.stringify({id,method,params})+'\n')})
  // All pending protocol requests and completion waits are cancelled with the
  // process, including startup failure before initialize/fork receives a reply.
  let failure
  const ended=run.done.then(()=>{throw Error('Codex 分支在完成前退出')},e=>{throw e})
  ended.catch(error=>{failure=error;for(const p of pending.values())p.reject(error);for(const resolve of listeners)resolve()})
  try{
    await Promise.race([request('initialize',{clientInfo:{name:'superlcm-summary',version:'1'},capabilities:{experimentalApi:true}}),ended])
    run.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n')
    const fork=await request('thread/fork',{threadId:session,ephemeral:true,excludeTurns:true,threadSource:'exec',...(lastTurnId?{lastTurnId}:{}),config:{hooks:forkGuard(),features:{hooks:true}}})
    branch=fork.thread.id;model=fork.model||model
    await request('turn/start',{threadId:branch,input:[{type:'text',text:prompt,text_elements:[]}]})
    if(!completed)await Promise.race([new Promise(resolve=>listeners.add(resolve)),ended])
    if(failure)throw failure
    if(!text.trim())throw Error('Codex 分支缺少完整摘要')
    return {text,model,usage,branchId:branch}
  }finally{
    run.child.stdin.end();run.child.kill('SIGTERM');await run.done.catch(()=>{})
  }
}
export function summarizeNativeFork(harness,session,prompt,options){
  if(harness==='claude-code')return summarizeClaudeFork(session,prompt,options)
  if(harness==='codex')return summarizeCodexFork(session,prompt,options)
  throw Error('此工具的主模型分支由运行中的宿主执行')
}
