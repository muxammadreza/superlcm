// Verify paired runtime modules before releasing the two separate products.
// The other checkout is an explicit argument; no machine-specific path is saved.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),other=process.argv[2]
assert.ok(other,'Usage: node scripts/check-shared-core.mjs <standalone-checkout>')
const pairs=[...['summary-policy.js','summary-language.js','summary-tokens.js','summary-merge.js','summary-attempt.js'].map(f=>['src/'+f,'src/'+f]),...['main-fork.js','archive-fork.js','fork-route.js','engine-config.js','engine-schema.js','summary-model.js','summary-session.js','summary-attempt.js','background-cancellation.js','conversation-rescue.js','tree-semantics.js','draft-tree.js','prepared-tree.js','summary-prefix.js','summary-guards.js','async-region.js','assembled-region.js','draft-persistence.js','request-boundary.js','ratio-runtime.js','ratio-policy.js','rolling.js','engine.js','compaction-owner.js'].map(f=>['dsh/'+f,'src/'+f])]
for(const [a,b] of pairs){
 let left=readFileSync(resolve(root,a),'utf8'),right=readFileSync(resolve(other,b),'utf8')
 // The standalone merge module has a literal input cap because runtime.js is
 // its DSH entrypoint. Normalize this one documented packaging difference only.
 if(a==='src/summary-merge.js'){
  const constant=readFileSync(resolve(root,'src/runtime.js'),'utf8').match(/export const MAX_SUMMARY_INPUT = (\d+)/)?.[1]
  assert.ok(constant);left=left.replace("import { MAX_SUMMARY_INPUT } from './runtime.js'",'const MAX_SUMMARY_INPUT='+constant)
 }
 // Storage belongs to each product. Normalize only these exact, documented
 // resolver expressions; all lifecycle and request logic must remain equal.
 if(['dsh/main-fork.js','dsh/archive-fork.js'].includes(a))left=left.replaceAll("'../src/","'./")
 if(a==='dsh/engine.js'||a==='dsh/compaction-owner.js'){
  left=left.replace("from '../src/summary-policy.js'","from './summary-policy.js'")
   .replace("import { SuperLcmStore,resolveDatabasePath } from './store.js'\nimport {join} from 'node:path'","import { SuperLcmStore, resolveConfiguredDatabasePath } from './store.js'")
   .replace("config.archiveHome?join(config.archiveHome,'lcm.sqlite'):resolveDatabasePath()",'resolveConfiguredDatabasePath(config)')
   .replace("import { SuperLcmStore, resolveDatabasePath } from './store.js'\nimport { join } from 'node:path'", "import { SuperLcmStore, resolveConfiguredDatabasePath } from './store.js'")
   .replace("config.archiveHome ? join(config.archiveHome,'lcm.sqlite') : resolveDatabasePath()",'resolveConfiguredDatabasePath(config)')
   .replace("config.archiveHome ? join(config.archiveHome, 'lcm.sqlite') : resolveDatabasePath()",'resolveConfiguredDatabasePath(config)')
 }
 assert.equal(left,right,'Paired runtime differs: '+a+' / '+b)
}
const fullSequence=readFileSync(resolve(root,'test/dsh-sequence-reliability.test.js'),'utf8')
const standaloneSequence=readFileSync(resolve(other,'test/standalone-sequence-reliability.test.js'),'utf8')
assert.equal(fullSequence,standaloneSequence.replaceAll('../src/','../dsh/'),'Paired lifecycle tests differ')
console.log(JSON.stringify({pairedRuntimeModules:pairs.length,pairedLifecycleTests:true,match:true}))

assert.equal(readFileSync(resolve(root,'test/dsh-fault-resilience.test.js'),'utf8'),readFileSync(resolve(other,'test/standalone-fault-resilience.test.js'),'utf8').replaceAll('../src/','../dsh/'),'Paired fault resilience tests differ')
