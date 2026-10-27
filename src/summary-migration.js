// Upgrade persisted host/CLI defaults once. Explicit legacy CLI requests made
// after the upgrade remain available to old integrations; they are not a UI mode.
export function migrateSummaryModes(db) {
  const tables=['summary_policies','summary_preferences','global_summary_settings','harness_summary_settings']
  const applied=()=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='summary_mode_migrations'").get()
  const needed=tables.some(name=>{
    const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql
    return sql&&(!sql.includes("'main-fork'")||db.prepare(`SELECT 1 FROM ${name} WHERE mode='agent' LIMIT 1`).get())
  })
  if(applied()&&!needed)return
  const own=!db.isTransaction
  db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT summary_modes')
  try {
    const legacy=applied()?"mode='agent'":"mode IN ('agent','cli','codex-cli')"
    for(const name of tables){
      const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql
      if(!sql)continue
      if(!sql.includes("'main-fork'")){
        const next=name+'_fork_migration',columns=db.prepare(`PRAGMA table_info(${name})`).all().map(x=>x.name)
        const ddl=sql.replace(new RegExp('CREATE TABLE '+name,'i'),'CREATE TABLE '+next).replace(/CHECK\(mode IN \(([^)]*)\)\)/,"CHECK(mode IN ($1,'main-fork'))")
        db.exec(ddl)
        const values=columns.map(c=>c==='mode'?`CASE WHEN ${legacy} THEN 'main-fork' ELSE mode END`:c==='model'?`CASE WHEN ${legacy} THEN NULL ELSE model END`:c)
        db.exec(`INSERT INTO ${next}(${columns.join(',')}) SELECT ${values.join(',')} FROM ${name}`)
        db.exec(`DROP TABLE ${name}; ALTER TABLE ${next} RENAME TO ${name}`)
      }else if(db.prepare(`SELECT 1 FROM ${name} WHERE ${legacy} LIMIT 1`).get()){
        db.exec(`UPDATE ${name} SET mode='main-fork'${name==='summary_policies'?'':',model=NULL'} WHERE ${legacy}`)
      }
    }
    db.exec('CREATE TABLE IF NOT EXISTS summary_mode_migrations(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT OR IGNORE INTO summary_mode_migrations VALUES(1)')
    db.exec(own?'COMMIT':'RELEASE summary_modes')
  }catch(error){db.exec(own?'ROLLBACK':'ROLLBACK TO summary_modes; RELEASE summary_modes');throw error}
}
