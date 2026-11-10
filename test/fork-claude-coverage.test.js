import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {summaryWork} from '../src/summarize.js'
import {coveredThrough} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'

// A transcript shaped like current Claude Code: dialogue interleaved with bookkeeping records and injected
// attachments, plus one tool output far longer than a summary piece.
function fixture(t,{hidden=false}={}){
  const root=mkdtempSync(join(tmpdir(),'slcm-fork-coverage-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
  const rows=[
    {type:'user',message:{role:'user',content:'Synthetic request'}},
    ...(hidden?[{type:'future_record',content:'SYNTHETIC_HIDDEN_CONSTRAINT'}]:[]),
    {type:'bridge-session',sessionId:'x'},{type:'agent-name',name:'synthetic'},{type:'atis-latch',state:1},
    {type:'attachment',attachment:{type:'hook_additional_context',content:['synthetic hook note']}},
    {type:'attachment',attachment:{type:'deferred_tools_delta',added:['Synthetic']}},
    {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'t1',name:'Read',input:{file:'a'}}]}},
    {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'x'.repeat(400000)}]}},
    {type:'assistant',message:{role:'assistant',content:'Synthetic answer'}},
    ...Array.from({length:40},(_,i)=>({type:i%2?'assistant':'user',message:{role:i%2?'assistant':'user',content:'Synthetic follow-up '+i}}))]
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file)
  s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  return s
}
test('a prompt typed during a turn is part of the summary source',t=>{
  const root=mkdtempSync(join(tmpdir(),'slcm-fork-queued-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
  const rows=[{type:'user',message:{role:'user',content:'Synthetic request'}},
    {type:'attachment',attachment:{type:'queued_command',commandMode:'prompt',prompt:'SYNTHETIC_MIDTURN_CONSTRAINT'}},
    {type:'attachment',attachment:{type:'total_tokens_reminder',tokens:1}},
    ...Array.from({length:12},(_,i)=>({type:i%2?'user':'assistant',message:{role:i%2?'user':'assistant',content:'Synthetic '+i}}))]
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file);s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  const w=summaryWork(s,'s',{batchSize:6})
  assert.equal(w.reducedSources,false);assert.match(w.content,/SYNTHETIC_MIDTURN_CONSTRAINT/)
})
const save=(s,w)=>s.addNode({session:'s',id:w.batch_id,level:w.level,first:w.first,last:w.last,children:w.children,summary:'# History\nSynthetic summary.',digest:w.digest,model:'synthetic',sourceComplete:!w.reducedSources})

test('Claude Code bookkeeping records and a long tool output do not stop a summary from covering its source',t=>{
  const s=fixture(t),w=summaryWork(s,'s',{batchSize:8})
  assert.ok(w);assert.equal(w.reducedSources,false)
  save(s,w)
  assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=w.last)
})

test('an unknown record with content still blocks coverage',t=>{
  const s=fixture(t,{hidden:true}),w=summaryWork(s,'s',{batchSize:8})
  assert.equal(w.reducedSources,true)
})

test('a summary written before quality tracking is checked once against the archive and can cover again',t=>{
  const s=fixture(t),w=summaryWork(s,'s',{batchSize:8})
  save(s,w)
  // What an older fork release left behind: the node, without any quality or coverage rows.
  for(const table of ['summary_node_quality','claude_node_coverage_v3','claude_node_coverage_v4','claude_node_recert'])s.db.prepare(`DELETE FROM ${table} WHERE session='s'`).run()
  assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),-1)
  summaryWork(s,'s',{batchSize:8})
  assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=w.last)
})
