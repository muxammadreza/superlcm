import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('runtime tests resolve the active DSH host and respect an explicit version override', t=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-runtime-selection-'))
  const add=(root,version)=>{
    const folder=join(root,'node_modules','@deepseek-ai','dsh-llm');mkdirSync(folder,{recursive:true})
    writeFileSync(join(folder,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-llm',type:'module',main:'index.js'}))
    writeFileSync(join(folder,'index.js'),'export const version='+JSON.stringify(version))
  }
  const host=join(dir,'active'),other=join(dir,'explicit'),project=join(dir,'project')
  for(const [root,version] of [[host,'active-host'],[other,'explicit-host'],[project,'project-copy']]){mkdirSync(root);add(root,version)}
  const cli=join(host,'dsh');writeFileSync(cli,'#!/bin/sh\n',{mode:0o755})
  const script=join(project,'check.mjs');writeFileSync(script,"import {version} from '@deepseek-ai/dsh-llm';console.log(version)")
  const loader=fileURLToPath(new URL('../scripts/dsh-runtime-loader.mjs',import.meta.url))
  const env={...process.env,SUPERLCM_DSH_BIN:cli};delete env.SUPERLCM_DSH_RUNTIME
  const run=override=>spawnSync(process.execPath,['--experimental-loader',loader,script],{cwd:project,encoding:'utf8',env:override?{...env,SUPERLCM_DSH_RUNTIME:join(other,'package.json')}:env})
  const current=run(false),requested=run(true)
  assert.equal(current.status,0,current.stderr);assert.equal(current.stdout.trim(),'active-host')
  assert.equal(requested.status,0,requested.stderr);assert.equal(requested.stdout.trim(),'explicit-host')
  const unavailable=spawnSync(process.execPath,['--experimental-loader',loader,script],{cwd:project,encoding:'utf8',env:{...env,SUPERLCM_DSH_RUNTIME:join(dir,'missing','package.json')}})
  assert.notEqual(unavailable.status,0,'an explicit missing host must not fall back to a different version')
})
