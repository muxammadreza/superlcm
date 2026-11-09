import {createHash} from 'node:crypto'
import {closeSync,fstatSync,openSync,readSync,statSync} from 'node:fs'

// The host branch reads its transcript, not SuperLcm's private copy. Prove
// the indexed source still matches every archived event and reject an unseen
// compaction boundary, including one appended before its indexing hook runs.
export function verifyClaudeForkSource(store,session,previous=null){
  const source=store.source(session)
  if(!source||source.kind!=='jsonl')throw Error('Claude 转录来源无法核验，原文保留')
  let fd
  try{
    fd=openSync(source.path,'r')
    const start=fstatSync(fd,{bigint:true}),pathStat=statSync(source.path,{bigint:true})
    if(!start.isFile()||start.dev!==pathStat.dev||start.ino!==pathStat.ino)throw Error('Claude 转录来源已替换，原文保留')
    if(previous&&(start.dev!==previous.dev||start.ino!==previous.ino||start.size<previous.size||
      start.size===previous.size&&(start.mtimeNs!==previous.mtimeNs||start.ctimeNs!==previous.ctimeNs)))throw Error('Claude 转录来源已变化，原文保留')
    if(start.size<BigInt(source.offset))throw Error('Claude 转录来源已截断，原文保留')
    const rows=store.db.prepare('SELECT start,end,digest FROM events WHERE session=? ORDER BY ordinal').all(session)
    const buffer=Buffer.alloc(64*1024);let through=0
    for(const row of rows){
      if(row.start!==through||row.end<row.start||row.end>source.offset)throw Error('Claude 转录索引不连续，原文保留')
      const digest=createHash('sha256');let pos=row.start
      while(pos<row.end){
        const count=readSync(fd,buffer,0,Math.min(buffer.length,row.end-pos),pos)
        if(!count)throw Error('Claude 转录来源已截断，原文保留')
        digest.update(buffer.subarray(0,count));pos+=count
      }
      if(digest.digest('hex')!==row.digest)throw Error('Claude 转录来源已变化，原文保留')
      through=row.end
    }
    if(through!==source.offset)throw Error('Claude 转录索引不连续，原文保留')
    const extra=Number(start.size-BigInt(source.offset))
    if(extra>32*1024*1024)throw Error('Claude 转录尚未完整归档，等待索引')
    if(extra){
      const tail=Buffer.alloc(extra);let read=0
      while(read<extra){const n=readSync(fd,tail,read,extra-read,source.offset+read);if(!n)throw Error('Claude 转录来源已变化，原文保留');read+=n}
      if(tail.at(-1)!==10)throw Error('Claude 转录正在写入，等待索引')
      for(const line of tail.toString('utf8').split('\n').slice(0,-1)){
        let record;try{record=JSON.parse(line)}catch{throw Error('Claude 转录尚未完整归档，等待索引')}
        if(record?.isCompactSummary===true||record?.subtype==='compact_boundary')throw Error('Claude 压缩标记尚未归档，等待索引')
      }
    }
    const end=fstatSync(fd,{bigint:true}),current=statSync(source.path,{bigint:true})
    if(start.dev!==end.dev||start.ino!==end.ino||start.size!==end.size||start.mtimeNs!==end.mtimeNs||start.ctimeNs!==end.ctimeNs||
      start.dev!==current.dev||start.ino!==current.ino||start.size!==current.size||start.mtimeNs!==current.mtimeNs||start.ctimeNs!==current.ctimeNs)throw Error('Claude 转录正在变化，等待重新核验')
    return {dev:start.dev,ino:start.ino,size:start.size,mtimeNs:start.mtimeNs,ctimeNs:start.ctimeNs}
  }catch(error){
    if(error.code==='ENOENT'||error.code==='EACCES')throw Error('Claude 转录来源不可读取，原文保留')
    throw error
  }finally{if(fd!==undefined)closeSync(fd)}
}
