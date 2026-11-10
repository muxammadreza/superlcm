// A textual projection may only certify blocks it actually represents.
// Unknown content blocks fail closed; private reasoning is deliberately omitted.
const opaque=new Set(['image','image_url','input_image','file','input_file','document','audio','input_audio','video'])
const text=new Set(['text','input_text','output_text'])
const calls=new Set(['tool_use','toolCall','tool-call','function_call','custom_tool_call'])
const privateReasoning=new Set(['thinking','redacted_thinking'])
const recordTypes=new Set(['user','assistant','tool','toolResult','system','response_item','event_msg','session_meta','turn_context','progress','file-history-snapshot','queue-operation','custom-title','ai-title','summary','last-prompt','pr-link','metadata'])
function contentIncomplete(value){
  if(value==null)return false
  if(typeof value==='string'){
    if(!value.startsWith('\0json:'))return false
    try{return contentIncomplete(JSON.parse(value.slice(6)))}catch{return true}
  }
  if(Array.isArray(value))return value.some(blockIncomplete)
  if(typeof value!=='object')return true
  // Even a serialized wrapper may contain an image or an unknown typed block.
  return value.type?blockIncomplete(value):nestedContentIncomplete(value)
}
function nestedContentIncomplete(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(nestedContentIncomplete)
  if(value.type)return blockIncomplete(value)
  return Object.values(value).some(nestedContentIncomplete)
}
function blockIncomplete(block){
  if(!block||typeof block!=='object'||Array.isArray(block))return true
  if(opaque.has(block.type))return true
  if(text.has(block.type))return typeof block.text!=='string'
  if(calls.has(block.type))return false // input/arguments are serialized in full
  if(block.type==='tool_result')return contentIncomplete(block.content)
  if(privateReasoning.has(block.type))return false
  // A ToolSearch result names the tools it loaded; the harness reloads them, the dialogue does not depend on it.
  if(block.type==='tool_reference')return false
  return true
}
function visitText(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(visitText)
  if(opaque.has(value.type))return !['image','image_url','input_image'].includes(value.type)
  if(calls.has(value.type))return false
  return Object.entries(value).some(([key,child])=>key==='content'?textContentIncomplete(child):visitText(child))
}
function textContentIncomplete(value){
  if(typeof value==='string'&&value.startsWith('\0json:')){try{return textContentIncomplete(JSON.parse(value.slice(6)))}catch{return true}}
  if(Array.isArray(value))return value.some(b=>b&&typeof b==='object'&&['image','image_url','input_image'].includes(b.type)?false:b?.type==='tool_result'?textContentIncomplete(b.content):blockIncomplete(b))
  return contentIncomplete(value)
}
function visit(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(visit)
  if(opaque.has(value.type))return true
  if(calls.has(value.type))return false
  return Object.entries(value).some(([key,child])=>key==='content'?contentIncomplete(child):visit(child))
}
// Claude Code writes many bookkeeping records (bridge-session, relocated, agent-name, atis-latch, tools-used,
// file-history-delta, mode, frame-link, ...) and new kinds appear with every release. A record with neither a
// `message` nor `content` is not dialogue. Attachments are what the harness injects (hook output, listings,
// reminders, date, environment) and are rebuilt by it, not part of the conversation a summary must cover.
// What Claude Code injects and rebuilds itself (hook output, listings, reminders, environment, date, re-read files).
const claudeAttachments=new Set(['hook_success','hook_additional_context','hook_system_message','environment','model','date','auto_mode','plan_mode',
  'instructions','session_context','credential_org','remote_session_change','prompt_snapshot','silent_turn_reminder','thinking_drop',
  'deferred_tools_delta','deferred_tools_record','agent_listing_delta','mcp_instructions_delta','skill_listing','command_permissions',
  'queued_command','edited_text_file','file','compact_file_reference','read_truncation_notice'])
const claudeSystemNotes=new Set(['compact_boundary','informational','local_command','turn_duration','api_error','stop_hook_summary'])
// allowImages: for deciding whether a summary may authorize a cut, an image the summary did not see does not
// make the rest of the conversation unsummarizable (the packet keeps its original addressable by lcm_read).
export function hasUnrepresentedContent(raw,kind='jsonl',{strictRecords=false,allowImages=false}={}){
  if(kind==='text')return false
  let value;try{value=JSON.parse(raw)}catch{return true}
  if(!value||typeof value!=='object'||Array.isArray(value))return true
  if(strictRecords&&!value.dsh_session&&typeof value.type==='string'&&!recordTypes.has(value.type)&&!/^api-request(?:-|$)/.test(value.type)){
    if(value.type==='attachment'){
      const kind=value.attachment?.type
      // A queued prompt the person typed mid-turn is dialogue the projection does not carry.
      if(kind==='queued_command'&&value.attachment.commandMode==='prompt')return true
      if(claudeAttachments.has(kind))return false
      // An empty attachment marker carries no content; an unknown kind may hold context nothing represents.
      return Object.keys(value).some(key=>!['type','uuid','parentUuid','timestamp','sessionId','version'].includes(key))
    }
    // Any unknown payload with dialogue fields may hold information the textual projection does not represent.
    if('message' in value||'content' in value)return true
    return false
  }
  // Request copies are skipped by summaries and never replayed as dialogue.
  if(strictRecords&&/^api-request(?:-|$)/.test(value.type||''))return false
  if(strictRecords&&value.type==='system'&&(value.content!=null||value.message?.content!=null)&&!claudeSystemNotes.has(value.subtype))return true
  return allowImages?visitText(value):visit(value)
}
