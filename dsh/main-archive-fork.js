// Archive and native compaction share one branch producer per live DSH session.
import {ArchiveDatabase} from './archive-db.js'
import {registerArchiveCapture,summarizeArchiveFork,registerForkArchive} from './archive-fork.js'
import {readSettings} from './settings.js'
import {ClaudeStore} from '../src/store.js'
import {saveForkTree} from '../src/main-fork.js'
import {dshSessionKey} from '../src/dsh.js'
import {forkHash} from './fork-summary.js'
import {markerFromSummary} from './marker.js'
import {isDeepStrictEqual} from 'node:util'
export class MainArchiveFork {
  constructor(ctx,native,home,warn){
    this.ctx=ctx;this.native=native;this.file=home;this.warn=warn;this.db=new ArchiveDatabase(native.path);this.store=new ClaudeStore(home);this.jobs=new Map();this.mirrored=new Map();this.stopped=false
    this.onTreeSaved=id=>this.mirror(id);registerArchiveCapture(this)
    this.unregister=registerForkArchive(native.path,async(id,tree,receipt)=>{
      const doc=readSettings(home);if(this.stopped||!doc.settings.summaryEnabled)return
      this.capture(id)
      const owner=this.db.lease(id,doc.revision);if(!owner)return
      try{
        const rows=this.db.sourceRows(id),known=new Set(rows.map(r=>r.seq))
        const expand=(seq,active=new Set())=>{
          if(known.has(seq))return [seq]
          if(active.has(seq))throw Error('DSH 摘要原文引用成环');active.add(seq)
          const event=ctx.sessions.get(id)?.eventAt(seq),marker=markerFromSummary(event?.data?.content),node=marker&&native.getNode(id,marker.id)
          if(!node)throw Error('DSH 摘要原文引用缺失')
          const sources=node.sourceSeqs.flatMap(s=>expand(s,active));active.delete(seq);return sources
        }
        const nodes=tree.map(n=>({...n,sources:[...new Set(n.sources.flatMap(seq=>expand(seq)))]}))
        this.db.saveTree(id,nodes,owner,doc.revision,()=>readSettings(home).revision,rows,receipt)
        this.mirror(id)
      }finally{this.db.release(id,owner)}
    },()=>readSettings(home).revision)
  }
  capture(id){const session=this.ctx.sessions.get(id);if(session){const cursor=this.db.cursor(id);this.db.capture(session.header,Array.from({length:Math.max(0,session.seq-cursor)},(_,i)=>session.eventAt(cursor+i)))}}
  mirror(id){
    const session=dshSessionKey(id),nodes=this.db.nodes(id),stamp=forkHash(nodes.map(n=>n.id));if(!nodes.length||!this.store.source(session)||this.store.isDeleted(session)||this.mirrored.get(id)===stamp)return
    const rows=this.db.sourceRows(id),originals=[],positions=new Map()
    for(const row of this.store.db.prepare('SELECT ordinal,digest FROM events WHERE session=? ORDER BY ordinal').all(session)){
      const record=JSON.parse(this.store.exact(session,row.ordinal));if(record.event?.seq!==undefined)positions.set(record.event.seq,{...row,event:record.event})
    }
    const wanted=new Set(nodes.flatMap(n=>n.sources))
    for(const seq of wanted){
      const source=rows.find(r=>r.seq===seq),record=positions.get(seq)
      if(!source||!record)return // The raw archive worker has not reached this prefix yet.
      if(!isDeepStrictEqual(JSON.parse(source.event),record.event))throw Error('DSH 分支原文与共享归档不一致')
      originals.push({ordinal:record.ordinal,digest:record.digest})
    }
    const ids=new Map(nodes.map((n,index)=>[n.id,index]))
    const tree=nodes.map((node,index)=>{
      const sourceRecords=node.sources.map(seq=>positions.get(seq).ordinal)
      return {index,archiveId:'dsh-fork-'+forkHash([id,node.id]).slice(0,24),level:node.level,firstMessage:Math.min(...sourceRecords),lastMessage:Math.max(...sourceRecords),sourceRecords,children:node.children.map(child=>{if(!ids.has(child))throw Error('DSH 分支摘要树不完整');return ids.get(child)}),summary:node.summary}
    })
    const doc=readSettings(this.file)
    if(!doc.settings.summaryEnabled)return
    const receipt=this.db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sl_fork_receipts'").get()&&this.db.db.prepare('SELECT * FROM sl_fork_receipts WHERE session=?').get(id)
    saveForkTree(this.store,session,{digest:forkHash(nodes.map(n=>n.id)),originals},tree,{model:receipt?.model||'dsh:session-model',usage:receipt?JSON.parse(receipt.usage):{},validate:()=>!this.stopped&&readSettings(this.file).revision===doc.revision})
    this.mirrored.set(id,stamp)
  }
  afterCapture(id,settled=false){
    if(this.stopped)return
    this.capture(id);this.mirror(id)
    const doc=readSettings(this.file)
    if(!settled||!doc.settings.summaryEnabled||doc.settings.takeover||this.jobs.has(id))return
    const owner=this.db.lease(id,doc.revision);if(!owner)return
    const controller=new AbortController()
    const timer=setInterval(()=>{try{if(!this.db.renew(id,owner)||readSettings(this.file).revision!==doc.revision)controller.abort(Error('DSH 摘要任务已取消'))}catch(error){controller.abort(error)}},10000);timer.unref()
    const state={controller,promise:null};this.jobs.set(id,state)
    let failed=false
    state.promise=summarizeArchiveFork(this,id,doc,owner,controller.signal).catch(error=>{failed=!controller.signal.aborted;this.warn(error)}).finally(()=>{clearInterval(timer);this.db.release(id,owner,failed);if(this.jobs.get(id)===state)this.jobs.delete(id)})
  }
  async close(){this.stopped=true;this.unregister();for(const job of this.jobs.values())job.controller.abort(Error('DSH 归档已停止'));await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));this.db.close();this.store.close()}
}
