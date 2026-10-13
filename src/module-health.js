import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
// A plain line-per-event file, kept beside the database but independent of it: when the database cannot be
// opened (or the Claude Code module fails before it asks the CLI anything) this is the only trace left.
// Messages are limited to short local error text; transcripts never go in. Writing never throws.
const MAX_BYTES = 256 * 1024
const dir = () => resolve(process.env.SUPERLCM_HOME || process.env.SUPERLCM_CLAUDE_HOME || join(homedir(), '.superlcm-claude'))
export const moduleHealthFile = () => join(dir(), 'module-health.jsonl')
export function noteModule(stage, detail = {}) {
  try {
    const file = moduleHealthFile()
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1') } catch {}
    const clean = {}
    for (const [key, value] of Object.entries(detail)) clean[key] = typeof value === 'string' ? value.slice(0, 300) : value
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), stage, ...clean }) + '\n', { mode: 0o600 })
  } catch {}
}
export function recentModuleHealth(limit = 50) {
  try { return readFileSync(moduleHealthFile(), 'utf8').trim().split('\n').slice(-limit).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) } catch { return [] }
}
