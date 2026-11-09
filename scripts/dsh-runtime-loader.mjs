// Verification resolves the host that the installed DSH command actually runs.
// SUPERLCM_DSH_RUNTIME can explicitly select a different installed host.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findCli } from '../src/runtime.js'

export function runtimeAnchor(env = process.env) {
  if (env.SUPERLCM_DSH_RUNTIME) return resolvePath(env.SUPERLCM_DSH_RUNTIME)
  const cli = findCli('dsh', env)
  if (cli) return /\.(cmd|bat)$/i.test(cli)
    ? join(resolvePath(cli, '..'), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : realpathSync(cli)
  return join(env.HOME || homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')
}
const host = createRequire(runtimeAnchor())
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try { return { url: pathToFileURL(host.resolve(specifier)).href, shortCircuit: true } }
    catch (error) { if (process.env.SUPERLCM_DSH_RUNTIME) throw error }
  }
  return nextResolve(specifier, context)
}
