import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {randomBytes} from 'node:crypto'
import {privateDirectory,privateFile} from './private-path.js'

const keyFile=dir=>join(dir,'api-credentials.json')
const scopeValid=scope=>scope==='global'||/^harness:[a-z][a-z0-9-]{0,39}$/.test(scope)||/^model:[a-z0-9]{1,40}$/.test(scope)
function credentials(dir) {
  const file=keyFile(dir)
  if(!existsSync(file))return {}
  const stat=lstatSync(file)
  if(!stat.isFile() || stat.size>128*1024 || (process.platform!=='win32' && (stat.mode&0o077)!==0) || (typeof process.getuid==='function' && stat.uid!==process.getuid()))throw new Error('API credential file must be a private regular file owned by this user')
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid API credential file')
  return value
}
function access(dir,mutate){
  const file=join(dir,'api-credentials.sqlite')
  if(!mutate&&!existsSync(file))return credentials(dir)
  privateDirectory(dir);privateFile(file)
  const db=new DatabaseSync(file)
  try{
    db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS credentials(scope TEXT PRIMARY KEY,value TEXT NOT NULL)')
    if(mutate){
      db.exec('BEGIN IMMEDIATE')
      const old=credentials(dir) // Read under the credential lock, so cleanup cannot restore an old JSON key.
      for(const [scope,value] of Object.entries(old))if(scopeValid(scope))db.prepare('INSERT OR IGNORE INTO credentials VALUES(?,?)').run(scope,JSON.stringify(value))
      mutate(db)
      db.exec('COMMIT')
    }
    const old=credentials(dir)
    return {...old,...Object.fromEntries(db.prepare('SELECT scope,value FROM credentials').all().map(r=>[r.scope,JSON.parse(r.value)]))}
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{db.close()}
}
// A secret is first written under an immutable revision. The main database
// then commits only that revision reference together with the model setting.
// A failed or interrupted setting save cannot overwrite the old secret.
function binding(dir,scope){
  const file=join(dir,'lcm.sqlite')
  if(!existsSync(file))return {found:false}
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_bindings'").get())return {found:false}
    const row=db.prepare('SELECT revision FROM credential_bindings WHERE scope=?').get(scope)
    return row?{found:true,revision:row.revision}:{found:false}
  }finally{db.close()}
}
function valueFor(dir,scope){
  const current=binding(dir,scope)
  if(!current.found)return access(dir)[scope]
  if(current.revision===null)return null
  const file=join(dir,'api-credentials.sqlite')
  if(!existsSync(file))throw Error('API credential database is missing')
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_versions'").get())throw Error('API credential revision is missing')
    const row=db.prepare('SELECT value FROM credential_versions WHERE scope=? AND revision=?').get(scope,current.revision)
    if(!row)throw Error('API credential revision is missing')
    return JSON.parse(row.value)
  }finally{db.close()}
}
export function bindApiKey(db,scope,revision){
  if(!scopeValid(scope)||revision!==null&&(typeof revision!=='string'||!/^[a-f0-9]{32}$/.test(revision)))throw Error('Invalid API credential binding')
  if(revision!==null){
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_retired_scopes'").get()&&db.prepare('SELECT 1 FROM credential_retired_scopes WHERE scope=?').get(scope))throw Error('API model was deleted; credential cannot be rebound')
    const main=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file
    if(!main)throw Error('API credential binding requires a persistent database')
    const file=join(dirname(main),'api-credentials.sqlite')
    if(!existsSync(file))throw Error('API credential revision is missing')
    const secrets=new DatabaseSync(file,{readOnly:true})
    try{
      if(!secrets.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_versions'").get()||!secrets.prepare('SELECT 1 FROM credential_versions WHERE scope=? AND revision=?').get(scope,revision))throw Error('API credential revision is missing')
    }finally{secrets.close()}
    db.exec('CREATE TABLE IF NOT EXISTS credential_published(scope TEXT NOT NULL,revision TEXT PRIMARY KEY)')
    db.prepare('INSERT OR IGNORE INTO credential_published VALUES(?,?)').run(scope,revision)
  }
  db.exec('CREATE TABLE IF NOT EXISTS credential_bindings(scope TEXT PRIMARY KEY,revision TEXT)')
  db.prepare('INSERT INTO credential_bindings VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision').run(scope,revision)
}
function bindStandalone(dir,scope,revision){
  privateDirectory(dir);const file=join(dir,'lcm.sqlite');privateFile(file)
  const db=new DatabaseSync(file)
  try{db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');bindApiKey(db,scope,revision);db.exec('COMMIT')}
  catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{db.close()}
}
export function stageApiKey(dir,scope,key,endpoint=null){
  if(!scopeValid(scope)||typeof key!=='string'||key.length<8||key.length>4096||/[\r\n\0]/.test(key)||!key.trim())throw new Error('API key must be 8–4096 nonempty characters without line breaks')
  if(endpoint!==null&&(typeof endpoint!=='string'||endpoint.length>2048))throw new Error('Invalid API credential endpoint')
  privateDirectory(dir)
  // Prepare the compatibility file before publishing a new revision; a file
  // creation error must not change either the selected key or the settings.
  try{writeFileSync(keyFile(dir),'{}',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
  credentials(dir)
  const revision=randomBytes(16).toString('hex'),value=endpoint===null?key:{key,endpoint}
  access(dir,db=>{
    db.exec('CREATE TABLE IF NOT EXISTS credential_versions(revision TEXT PRIMARY KEY,scope TEXT NOT NULL,value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS credential_staging(revision TEXT PRIMARY KEY,scope TEXT NOT NULL,created_ms INTEGER NOT NULL)')
    db.prepare('INSERT INTO credential_versions VALUES(?,?,?)').run(revision,scope,JSON.stringify(value))
    db.prepare('INSERT INTO credential_staging VALUES(?,?,?)').run(revision,scope,Date.now())
  })
  return revision
}
export function apiKeyEndpoint(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=valueFor(dir,scope)
  return value && typeof value==='object' && typeof value.endpoint==='string' ? value.endpoint : null
}
export function readApiKey(dir,scope,endpoint) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=valueFor(dir,scope)
  if(value && typeof value==='object') {
    if(endpoint !== undefined && value.endpoint !== endpoint)return null
    return typeof value.key==='string'&&value.key.length>=8?value.key:null
  }
  return typeof value==='string'&&value.length>=8?value:null
}
export function saveApiKey(dir,scope,key,endpoint=null) {
  privateDirectory(dir);const file=join(dir,'lcm.sqlite');privateFile(file)
  const db=new DatabaseSync(file)
  try{
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE')
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_retired_scopes'").get()&&db.prepare('SELECT 1 FROM credential_retired_scopes WHERE scope=?').get(scope))throw Error('API model was deleted; credential cannot be rebound')
    bindApiKey(db,scope,stageApiKey(dir,scope,key,endpoint))
    db.exec('COMMIT');return true
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{db.close()}
}
export function removeApiKey(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  if(!valueFor(dir,scope))return false
  bindStandalone(dir,scope,null)
  return true
}

// Queue the cleanup in the same transaction that unbinds the model. The
// separate credential database can then be cleaned without risking rollback of
// the model deletion or removing a revision another writer is publishing.
export function queueApiCredentialCleanup(db,scope){
  if(!scopeValid(scope))throw Error('Invalid API credential scope')
  db.exec('CREATE TABLE IF NOT EXISTS credential_gc_queue(scope TEXT PRIMARY KEY)')
  db.prepare('INSERT OR IGNORE INTO credential_gc_queue VALUES(?)').run(scope)
}
export function apiCredentialCleanupPending(db,scope){
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_gc_queue'").get()&&!!db.prepare('SELECT 1 FROM credential_gc_queue WHERE scope=?').get(scope)
}
export function cleanupApiCredential(db,dir,scope){
  if(!apiCredentialCleanupPending(db,scope))return false
  db.exec('BEGIN IMMEDIATE')
  try{
    const current=db.prepare('SELECT revision FROM credential_bindings WHERE scope=?').get(scope)
    if(!current||current.revision!==null){db.exec('COMMIT');return false}
    const file=join(dir,'api-credentials.sqlite'),legacy=keyFile(dir)
    // The lock also serializes migration from the old JSON file.
    privateDirectory(dir);privateFile(file)
    const secrets=new DatabaseSync(file);let waiting=0
    try{
      secrets.exec('PRAGMA busy_timeout=10000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE')
      const old=credentials(dir)
      if(Object.hasOwn(old,scope)){
        delete old[scope]
        const temp=join(dir,`.api-credentials-${randomBytes(12).toString('hex')}.tmp`)
        try{writeFileSync(temp,JSON.stringify(old),{flag:'wx',mode:0o600});renameSync(temp,legacy)}
        finally{try{unlinkSync(temp)}catch(error){if(error.code!=='ENOENT')throw error}}
      }
      if(secrets.prepare("SELECT 1 FROM sqlite_master WHERE name='credentials'").get())secrets.prepare('DELETE FROM credentials WHERE scope=?').run(scope)
      if(secrets.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_versions'").get()){
        const hasStaging=!!secrets.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_staging'").get()
        const hasPublished=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_published'").get()
        const published=hasPublished?db.prepare('SELECT 1 FROM credential_published WHERE scope=? AND revision=?'):null
        const staging=hasStaging?secrets.prepare('SELECT created_ms FROM credential_staging WHERE revision=?'):null
        for(const row of secrets.prepare('SELECT revision FROM credential_versions WHERE scope=?').all(scope)){
          const pending=staging?.get(row.revision)
          // A not-yet-published revision may belong to another writer. Keep it
          // for a day; a later attempt to bind an expired one fails safely.
          if(pending&&!published?.get(scope,row.revision)&&Date.now()-pending.created_ms<86400000){waiting++;continue}
          secrets.prepare('DELETE FROM credential_versions WHERE revision=? AND scope=?').run(row.revision,scope)
          if(staging)secrets.prepare('DELETE FROM credential_staging WHERE revision=?').run(row.revision)
        }
      }
      secrets.exec('COMMIT')
    }catch(error){if(secrets.isTransaction)secrets.exec('ROLLBACK');throw error}finally{secrets.close()}
    if(!waiting)db.prepare('DELETE FROM credential_gc_queue WHERE scope=?').run(scope)
    db.exec('COMMIT');return !waiting
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}
}
export function retryApiCredentialCleanup(db,dir){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_gc_queue'").get())return
  for(const {scope} of db.prepare('SELECT scope FROM credential_gc_queue').all())try{cleanupApiCredential(db,dir,scope)}catch{}
}
